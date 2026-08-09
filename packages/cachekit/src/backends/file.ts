import { constants as fsConstants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { blake2b16Hex } from '../serialization/key-generator.js';
import { Backend, FileBackendConfig, TTLBackend } from './types.js';
import { BackendError } from '../errors.js';

// On-disk format shared with cachekit-py's FileBackend (14-byte header).
// Any change here breaks cross-SDK File readers — py and ts can point at the
// same cache directory, so the header layout and the blake2b-16 filename
// derivation are a frozen cross-SDK contract, not an implementation detail.
const MAGIC_0 = 0x43; // 'C'
const MAGIC_1 = 0x4b; // 'K'
const FORMAT_VERSION = 1;
const HEADER_SIZE = 14; // [0:2] magic, [2] version, [3] reserved, [4:6] flags u16 BE, [6:14] expiry u64 BE
const FLAGS_OFFSET = 4;
const EXPIRY_OFFSET = 6;

/** TTL ceiling shared with py (10 years) — prevents u64 overflow games. */
const MAX_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

/** Orphaned temp files older than this are deleted on startup (matches py). */
const TEMP_FILE_MAX_AGE_MS = 60_000;

const DEFAULT_MAX_VALUE_BYTES = 100 * 1024 * 1024; // py: max_value_mb = 100

/**
 * File-based backend for local disk caching (Node-runtime only).
 *
 * On-disk compatible with cachekit-py's FileBackend: filenames are
 * `blake2b(key, digestSize=16)` hex (32 chars, flat directory), each file is a
 * 14-byte header (magic "CK", version, flags, uint64 BE expiry — 0 = never
 * expire) followed by the raw payload. Writes are atomic via
 * write-to-temp → fsync → rename; expired or corrupt entries are unlinked on
 * read. Symlinks are rejected with O_NOFOLLOW on every open.
 *
 * Deliberate deltas from py (documented, not accidental):
 * - No LRU size eviction / max_entry_count: LAB-430 scopes parity to
 *   directory layout + TTL semantics. Size caps beyond maxValueBytes are a
 *   follow-up; until then the directory grows unbounded like any disk cache
 *   without a sweeper.
 * - No flock/msvcrt file locks: Node is single-threaded per process and
 *   cross-process safety comes from atomic rename (readers see old or new
 *   bytes, never a torn file). The one in-place write (refreshTTL's 8-byte
 *   expiry field) has the same torn-write ceiling py accepted: worst case a
 *   wrong expiry, never a corrupt payload.
 *
 * @example
 * ```typescript
 * import { file } from '@cachekit-io/cachekit/backends/file';
 *
 * const backend = file({ cacheDir: '/var/cache/myapp' });
 * await backend.set('key', new TextEncoder().encode('value'), 3600);
 * const value = await backend.get('key');
 * await backend.close();
 * ```
 */
export class FileBackend implements Backend, TTLBackend {
  private readonly config: Required<FileBackendConfig>;
  private closed = false;
  /** Memoized directory init: mkdir + orphaned-temp-file sweep, once. */
  private ready: Promise<void> | null = null;

  constructor(config: FileBackendConfig = {}) {
    const defaultTtl = config.defaultTtl ?? 0;
    if (defaultTtl < 0 || defaultTtl > MAX_TTL_SECONDS) {
      throw new BackendError(
        `defaultTtl ${defaultTtl} out of range [0, ${MAX_TTL_SECONDS}] (max 10 years)`
      );
    }
    this.config = {
      cacheDir: config.cacheDir ?? path.join(os.tmpdir(), 'cachekit'),
      defaultTtl,
      maxValueBytes: config.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES,
      fileMode: config.fileMode ?? 0o600,
      dirMode: config.dirMode ?? 0o700,
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.ensureNotClosed();
    await this.ensureDir();
    const filePath = this.keyToPath(key);

    let handle: FileHandle;
    try {
      handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (isMissingOrSymlink(error)) return null;
      throw this.wrapError('get', error);
    }

    try {
      const data = await handle.readFile();
      const expiry = this.parseHeader(data);
      if (expiry === 'unsupported') return null;
      if (expiry === 'corrupt' || isExpired(expiry)) {
        await handle.close();
        await this.safeUnlink(filePath);
        return null;
      }
      return new Uint8Array(data.buffer, data.byteOffset + HEADER_SIZE, data.length - HEADER_SIZE);
    } catch (error) {
      throw this.wrapError('get', error);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async set(key: string, value: Uint8Array, ttl?: number): Promise<void> {
    this.ensureNotClosed();

    if (this.config.maxValueBytes > 0 && value.length > this.config.maxValueBytes) {
      throw new BackendError(
        `Value size ${value.length} exceeds maxValueBytes (${this.config.maxValueBytes})`
      );
    }

    const effectiveTtl = ttl ?? this.config.defaultTtl;
    let expiry = 0n;
    if (effectiveTtl !== 0) {
      if (effectiveTtl < 0 || effectiveTtl > MAX_TTL_SECONDS) {
        throw new BackendError(
          `TTL ${effectiveTtl} out of range [0, ${MAX_TTL_SECONDS}] (max 10 years)`
        );
      }
      expiry = nowSeconds() + BigInt(Math.floor(effectiveTtl));
    }

    await this.ensureDir();
    const filePath = this.keyToPath(key);
    // Unique temp name in the same directory so rename() is atomic (same fs).
    const tempPath = `${filePath}.tmp.${process.pid}.${process.hrtime.bigint()}`;

    const header = Buffer.alloc(HEADER_SIZE); // zero-filled: reserved + flags stay 0
    header[0] = MAGIC_0;
    header[1] = MAGIC_1;
    header[2] = FORMAT_VERSION;
    header.writeBigUInt64BE(expiry, EXPIRY_OFFSET);

    try {
      const handle = await fs.open(
        tempPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        this.config.fileMode
      );
      try {
        await handle.writeFile(Buffer.concat([header, Buffer.from(value)]));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await this.safeUnlink(tempPath);
      throw this.wrapError('set', error);
    }
  }

  async delete(key: string): Promise<boolean> {
    this.ensureNotClosed();
    await this.ensureDir();

    try {
      await fs.unlink(this.keyToPath(key));
      return true;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return false;
      throw this.wrapError('delete', error);
    }
  }

  async exists(key: string): Promise<boolean> {
    this.ensureNotClosed();
    const expiry = await this.readExpiry('exists', key);
    return expiry !== null;
  }

  /**
   * See {@link TTLBackend.getTTL}: remaining seconds from the on-disk expiry
   * header, or null when the key is missing, permanent (expiry field 0), or
   * already expired (expired entries are unlinked, mirroring get/exists).
   */
  async getTTL(key: string): Promise<number | null> {
    this.ensureNotClosed();
    const expiry = await this.readExpiry('getTTL', key);
    if (expiry === null || expiry === 0n) return null;
    const remaining = Number(expiry) - Date.now() / 1000;
    if (remaining <= 0) {
      await this.delete(key);
      return null;
    }
    return Math.floor(remaining);
  }

  /**
   * See {@link TTLBackend.refreshTTL}: rewrites the 8-byte expiry field in
   * place (payload and all other header fields untouched, so cross-SDK File
   * readers stay compatible). Returns false when the key is missing or
   * already expired (expired entries are unlinked, mirroring get). Throws on
   * ttl <= 0 per the ts-wide TTLBackend contract — unlike cachekit-py's File
   * refresh_ttl(0) = permanent, every ts refreshTTL rejects non-positive TTLs
   * so swapping backends never changes zero-semantics.
   */
  async refreshTTL(key: string, ttl: number): Promise<boolean> {
    this.ensureNotClosed();

    const seconds = Math.floor(ttl);
    if (seconds <= 0) {
      throw new BackendError(`File refreshTTL requires ttl >= 1 second, got ${ttl}`);
    }
    if (seconds > MAX_TTL_SECONDS) {
      throw new BackendError(`TTL ${ttl} out of range [1, ${MAX_TTL_SECONDS}] (max 10 years)`);
    }

    await this.ensureDir();
    const filePath = this.keyToPath(key);

    let handle: FileHandle;
    try {
      handle = await fs.open(filePath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (isMissingOrSymlink(error)) return false;
      throw this.wrapError('refreshTTL', error);
    }

    try {
      const header = Buffer.alloc(HEADER_SIZE);
      const { bytesRead } = await handle.read(header, 0, HEADER_SIZE, 0);
      const expiry = this.parseHeader(header.subarray(0, bytesRead));
      if (expiry === 'unsupported') return false;
      if (expiry === 'corrupt' || isExpired(expiry)) {
        await handle.close();
        await this.safeUnlink(filePath);
        return false;
      }

      const newExpiry = Buffer.alloc(8);
      newExpiry.writeBigUInt64BE(nowSeconds() + BigInt(seconds));
      await handle.write(newExpiry, 0, 8, EXPIRY_OFFSET);
      await handle.sync();
      return true;
    } catch (error) {
      throw this.wrapError('refreshTTL', error);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  // ==================== private ====================

  /**
   * `blake2b(key, digestSize=16)` hex — 32-char filename, flat layout.
   * Byte-identical to py's `_key_to_path`, so the same logical key maps to
   * the same file from either SDK (this is also why Backend.keyPrefix stays
   * unset: key identity is preserved, nothing is prefixed on the wire).
   */
  private keyToPath(key: string): string {
    return path.join(this.config.cacheDir, blake2b16Hex(key));
  }

  /**
   * Expiry from a header buffer. Unknown reserved/flag bits are deliberately
   * reported separately: they may denote a future transform, so this reader
   * must fail closed without unlinking an entry a newer SDK understands.
   */
  private parseHeader(data: Uint8Array): bigint | 'corrupt' | 'unsupported' {
    if (data.length < HEADER_SIZE) return 'corrupt';
    if (data[0] !== MAGIC_0 || data[1] !== MAGIC_1 || data[2] !== FORMAT_VERSION) return 'corrupt';
    if (
      data[3] !== 0 ||
      Buffer.from(data.buffer, data.byteOffset, HEADER_SIZE).readUInt16BE(FLAGS_OFFSET) !== 0
    ) {
      return 'unsupported';
    }
    return Buffer.from(data.buffer, data.byteOffset, HEADER_SIZE).readBigUInt64BE(EXPIRY_OFFSET);
  }

  /**
   * Shared header-read path for exists/getTTL: expiry field of a live entry
   * (0n = permanent), or null for missing/corrupt/expired — corrupt and
   * expired entries are unlinked, mirroring py.
   */
  private async readExpiry(operation: string, key: string): Promise<bigint | null> {
    await this.ensureDir();
    const filePath = this.keyToPath(key);

    let handle: FileHandle;
    try {
      handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (isMissingOrSymlink(error)) return null;
      throw this.wrapError(operation, error);
    }

    try {
      const header = Buffer.alloc(HEADER_SIZE);
      const { bytesRead } = await handle.read(header, 0, HEADER_SIZE, 0);
      const expiry = this.parseHeader(header.subarray(0, bytesRead));
      if (expiry === 'unsupported') return null;
      if (expiry === 'corrupt' || isExpired(expiry)) {
        await handle.close();
        await this.safeUnlink(filePath);
        return null;
      }
      return expiry;
    } catch (error) {
      throw this.wrapError(operation, error);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private ensureDir(): Promise<void> {
    this.ready ??= (async () => {
      try {
        await fs.mkdir(this.config.cacheDir, { recursive: true, mode: this.config.dirMode });
      } catch (error) {
        this.ready = null; // let a later call retry instead of caching the failure
        throw this.wrapError('init', error);
      }
      await this.cleanupTempFiles();
    })();
    return this.ready;
  }

  /** Best-effort sweep of orphaned `*.tmp.*` files older than 60s (matches py). */
  private async cleanupTempFiles(): Promise<void> {
    try {
      const entries = await fs.readdir(this.config.cacheDir);
      const cutoff = Date.now() - TEMP_FILE_MAX_AGE_MS;
      for (const name of entries) {
        if (!name.includes('.tmp.')) continue;
        const tempPath = path.join(this.config.cacheDir, name);
        try {
          const stat = await fs.lstat(tempPath); // lstat: never follow symlinks
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            await fs.unlink(tempPath);
          }
        } catch {
          // raced with another process — fine
        }
      }
    } catch {
      // best-effort: never fail an operation over temp cleanup
    }
  }

  private async safeUnlink(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch(() => undefined);
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new BackendError('File backend is closed');
    }
  }

  private wrapError(operation: string, error: unknown): Error {
    if (error instanceof BackendError) return error;
    if (isErrnoException(error)) {
      // Disk-full and I/O errors may clear; inaccessible or read-only paths
      // are permanent for this backend instance.
      const permanent = error.code === 'EACCES' || error.code === 'EROFS' || error.code === 'EPERM';
      return new BackendError(
        `File ${operation} failed: ${error.message}`,
        permanent ? 'permanent' : 'transient',
        { cause: error }
      );
    }
    if (error instanceof Error) {
      return new BackendError(`File ${operation} failed: ${error.message}`, 'transient', {
        cause: error,
      });
    }
    return new BackendError(`File ${operation} failed: Unknown error`);
  }
}

/** Missing file, or symlink rejected by O_NOFOLLOW — both mean "not found". */
function isMissingOrSymlink(error: unknown): boolean {
  return isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ELOOP');
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** Whole-second wall clock as bigint, the unit of the on-disk expiry field. */
function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/** Python compares the integer wire timestamp to its fractional wall clock. */
function isExpired(expiry: bigint): boolean {
  return expiry > 0n && BigInt(Date.now()) > expiry * 1000n;
}

/**
 * Factory function to create a File backend.
 *
 * @example
 * ```typescript
 * import { file } from '@cachekit-io/cachekit/backends/file';
 *
 * const backend = file({ cacheDir: '/var/cache/myapp', defaultTtl: 3600 });
 * ```
 */
export function file(config: FileBackendConfig = {}): FileBackend {
  return new FileBackend(config);
}

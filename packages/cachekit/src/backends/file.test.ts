import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { file, FileBackend } from './file.js';
import { BackendError } from '../errors.js';

/**
 * FileBackend unit tests — run against the real filesystem in a per-test
 * tmpdir. No mocks: the on-disk format is a cross-SDK contract with
 * cachekit-py, so the tests pin real bytes (see the "python golden vectors"
 * block, generated with cachekit-py's hashlib/struct calls).
 */

const HEADER_SIZE = 14;

/** blake2b('test-key', digestSize=16) — py-verified (see PY_FILENAMES below). */
const TEST_KEY_HASH = '0e2a03b49262c15a063c04d5a29c0158'; // pragma: allowlist secret

/** Build a py-format file image: CK + version + reserved + flags + u64 BE expiry. */
function fileImage(expirySeconds: bigint, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write('CK', 0, 'ascii');
  header[2] = 1;
  header.writeBigUInt64BE(expirySeconds, 6);
  return Buffer.concat([header, payload]);
}

describe('FileBackend', () => {
  let dir: string;
  let backend: FileBackend;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cachekit-file-test-'));
    backend = file({ cacheDir: dir });
  });

  afterEach(async () => {
    await backend.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('basic operations', () => {
    it('set/get round-trip preserves bytes', async () => {
      const value = new Uint8Array([0, 1, 2, 255, 254, 128]);
      await backend.set('test-key', value, 60);
      expect(await backend.get('test-key')).toEqual(value);
    });

    it('get returns null for missing key', async () => {
      expect(await backend.get('nope')).toBeNull();
    });

    it('empty payload round-trips', async () => {
      await backend.set('empty', new Uint8Array(0), 60);
      expect(await backend.get('empty')).toEqual(new Uint8Array(0));
    });

    it('overwrite replaces the value', async () => {
      await backend.set('k', new Uint8Array([1]), 60);
      await backend.set('k', new Uint8Array([2, 3]), 60);
      expect(await backend.get('k')).toEqual(new Uint8Array([2, 3]));
    });

    it('delete returns true for existing key, false for missing', async () => {
      await backend.set('k', new Uint8Array([1]), 60);
      expect(await backend.delete('k')).toBe(true);
      expect(await backend.delete('k')).toBe(false);
      expect(await backend.get('k')).toBeNull();
    });

    it('exists reflects presence', async () => {
      expect(await backend.exists('k')).toBe(false);
      await backend.set('k', new Uint8Array([1]), 60);
      expect(await backend.exists('k')).toBe(true);
    });

    it('operations after close throw BackendError', async () => {
      await backend.close();
      await expect(backend.get('k')).rejects.toThrow(BackendError);
      await expect(backend.set('k', new Uint8Array([1]))).rejects.toThrow(BackendError);
    });
  });

  describe('python golden vectors (cross-SDK on-disk contract)', () => {
    // hashlib.blake2b(key.encode('utf-8'), digest_size=16).hexdigest()
    const PY_FILENAMES: Array<[string, string]> = [
      ['test-key', TEST_KEY_HASH],
      [
        'ns:myapp:func:mod.fn:args:0011223344556677889900112233445566778899001122334455667788990011:v1',
        '48b25847fb31fc0b4f19b5484a11d6bb', // pragma: allowlist secret
      ],
      ['unicode-ключ-🔑', 'f13b0df717f97cf1d2fe3da650525c79'], // pragma: allowlist secret
    ];

    it.each(PY_FILENAMES)('key %s maps to the same filename as cachekit-py', async (key, hex) => {
      await backend.set(key, new Uint8Array([1]), 60);
      const entries = await fs.readdir(dir);
      expect(entries).toContain(hex);
    });

    it('reads a file written by cachekit-py (permanent entry)', async () => {
      // struct-packed by python: b'CK' + \x01 + \x00 + >H(0) + >Q(0) + b'hello'
      const pyBytes = Buffer.from('434b01000000000000000000000068656c6c6f', 'hex');
      await fs.writeFile(path.join(dir, TEST_KEY_HASH), pyBytes);

      expect(await backend.get('test-key')).toEqual(new TextEncoder().encode('hello'));
      expect(await backend.getTTL('test-key')).toBeNull(); // permanent → null
    });

    it('reads a file written by cachekit-py (expiry in 2100)', async () => {
      // >Q(4102444800) — 2100-01-01T00:00:00Z
      const pyBytes = Buffer.from('434b0100000000000000f486570068656c6c6f', 'hex');
      await fs.writeFile(path.join(dir, TEST_KEY_HASH), pyBytes);

      expect(await backend.get('test-key')).toEqual(new TextEncoder().encode('hello'));
      const ttl = await backend.getTTL('test-key');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(4102444800 - Math.floor(Date.now() / 1000));
    });

    it('writes headers python can parse (expiry field position and endianness)', async () => {
      await backend.set('test-key', new TextEncoder().encode('hi'), 3600);
      const raw = await fs.readFile(path.join(dir, TEST_KEY_HASH));

      expect(raw.subarray(0, 2).toString('ascii')).toBe('CK');
      expect(raw[2]).toBe(1); // version
      expect(raw[3]).toBe(0); // reserved
      expect(raw.readUInt16BE(4)).toBe(0); // flags
      const expiry = Number(raw.readBigUInt64BE(6));
      const now = Math.floor(Date.now() / 1000);
      expect(expiry).toBeGreaterThanOrEqual(now + 3595);
      expect(expiry).toBeLessThanOrEqual(now + 3605);
      expect(raw.subarray(HEADER_SIZE).toString('utf-8')).toBe('hi');
    });
  });

  describe('TTL and expiry', () => {
    it('ttl omitted and defaultTtl unset → permanent (py parity, not Redis 1h)', async () => {
      await backend.set('k', new Uint8Array([1]));
      const raw = await fs.readFile(path.join(dir, (await fs.readdir(dir))[0]));
      expect(raw.readBigUInt64BE(6)).toBe(0n);
      expect(await backend.getTTL('k')).toBeNull();
    });

    it('defaultTtl config applies when ttl omitted', async () => {
      const b = file({ cacheDir: dir, defaultTtl: 120 });
      await b.set('k', new Uint8Array([1]));
      const ttl = await b.getTTL('k');
      expect(ttl).toBeGreaterThan(110);
      expect(ttl).toBeLessThanOrEqual(120);
      await b.close();
    });

    it('expired entry: get returns null and unlinks the file', async () => {
      const image = fileImage(BigInt(Math.floor(Date.now() / 1000) - 10), new Uint8Array([1]));
      const filePath = path.join(dir, TEST_KEY_HASH);
      await fs.writeFile(filePath, image);

      expect(await backend.get('test-key')).toBeNull();
      await expect(fs.access(filePath)).rejects.toThrow(); // unlinked
    });

    it('expired entry: exists returns false and unlinks the file', async () => {
      const image = fileImage(BigInt(Math.floor(Date.now() / 1000) - 10), new Uint8Array([1]));
      const filePath = path.join(dir, TEST_KEY_HASH);
      await fs.writeFile(filePath, image);

      expect(await backend.exists('test-key')).toBe(false);
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('getTTL: missing → null, live → remaining seconds, expired → null + unlink', async () => {
      expect(await backend.getTTL('missing')).toBeNull();

      await backend.set('live', new Uint8Array([1]), 300);
      const ttl = await backend.getTTL('live');
      expect(ttl).toBeGreaterThan(290);
      expect(ttl).toBeLessThanOrEqual(300);

      const image = fileImage(BigInt(Math.floor(Date.now() / 1000) - 10), new Uint8Array([1]));
      const filePath = path.join(dir, TEST_KEY_HASH);
      await fs.writeFile(filePath, image);
      expect(await backend.getTTL('test-key')).toBeNull();
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('set rejects negative and >10y TTLs', async () => {
      await expect(backend.set('k', new Uint8Array([1]), -1)).rejects.toThrow(BackendError);
      await expect(backend.set('k', new Uint8Array([1]), 11 * 365 * 24 * 60 * 60)).rejects.toThrow(
        BackendError
      );
    });
  });

  describe('refreshTTL', () => {
    it('refreshes a live key and reports the new TTL', async () => {
      await backend.set('k', new Uint8Array([7, 8]), 10);
      expect(await backend.refreshTTL('k', 500)).toBe(true);
      const ttl = await backend.getTTL('k');
      expect(ttl).toBeGreaterThan(490);
      expect(ttl).toBeLessThanOrEqual(500);
      // payload untouched by the in-place header rewrite
      expect(await backend.get('k')).toEqual(new Uint8Array([7, 8]));
    });

    it('refreshes a permanent key onto a TTL', async () => {
      await backend.set('k', new Uint8Array([1])); // permanent
      expect(await backend.refreshTTL('k', 60)).toBe(true);
      expect(await backend.getTTL('k')).toBeGreaterThan(50);
    });

    it('returns false for missing key', async () => {
      expect(await backend.refreshTTL('missing', 60)).toBe(false);
    });

    it('returns false for expired key and unlinks it', async () => {
      const image = fileImage(BigInt(Math.floor(Date.now() / 1000) - 10), new Uint8Array([1]));
      const filePath = path.join(dir, TEST_KEY_HASH);
      await fs.writeFile(filePath, image);

      expect(await backend.refreshTTL('test-key', 60)).toBe(false);
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('throws on ttl <= 0 rather than deleting or making permanent', async () => {
      await backend.set('k', new Uint8Array([1]), 60);
      await expect(backend.refreshTTL('k', 0)).rejects.toThrow(BackendError);
      await expect(backend.refreshTTL('k', -5)).rejects.toThrow(BackendError);
      expect(await backend.exists('k')).toBe(true); // still there, TTL untouched
    });
  });

  describe('corruption and safety', () => {
    it('truncated file (< header size) → null + unlink', async () => {
      const filePath = path.join(dir, TEST_KEY_HASH);
      await fs.writeFile(filePath, Buffer.from('CK'));
      expect(await backend.get('test-key')).toBeNull();
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('bad magic → null + unlink', async () => {
      const image = fileImage(0n, new Uint8Array([1]));
      image[0] = 0x58; // 'X'
      const filePath = path.join(dir, TEST_KEY_HASH);
      await fs.writeFile(filePath, image);
      expect(await backend.get('test-key')).toBeNull();
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('unknown format version → null + unlink', async () => {
      const image = fileImage(0n, new Uint8Array([1]));
      image[2] = 99;
      const filePath = path.join(dir, TEST_KEY_HASH);
      await fs.writeFile(filePath, image);
      expect(await backend.exists('test-key')).toBe(false);
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('rejects values over maxValueBytes before touching disk', async () => {
      const b = file({ cacheDir: dir, maxValueBytes: 4 });
      await expect(b.set('k', new Uint8Array(5))).rejects.toThrow(/maxValueBytes/);
      expect(await fs.readdir(dir)).toEqual([]);
      await b.close();
    });

    it.skipIf(process.platform === 'win32')(
      'symlinked cache entry is treated as missing (O_NOFOLLOW)',
      async () => {
        const target = path.join(dir, 'target');
        await fs.writeFile(target, fileImage(0n, new TextEncoder().encode('attack')));
        await fs.symlink(target, path.join(dir, TEST_KEY_HASH));
        expect(await backend.get('test-key')).toBeNull();
      }
    );

    it('sweeps orphaned temp files older than 60s on first use', async () => {
      const stale = path.join(dir, 'deadbeef.tmp.123.456');
      const fresh = path.join(dir, 'cafebabe.tmp.789.012');
      await fs.writeFile(stale, 'x');
      await fs.writeFile(fresh, 'x');
      const old = new Date(Date.now() - 120_000);
      await fs.utimes(stale, old, old);

      const b = file({ cacheDir: dir });
      await b.get('anything'); // triggers lazy init + sweep
      const entries = await fs.readdir(dir);
      expect(entries).not.toContain('deadbeef.tmp.123.456');
      expect(entries).toContain('cafebabe.tmp.789.012'); // too young to sweep
      await b.close();
    });

    it('creates the cache directory with restrictive permissions', async () => {
      const nested = path.join(dir, 'a', 'b');
      const b = file({ cacheDir: nested });
      await b.set('k', new Uint8Array([1]), 60);
      if (process.platform !== 'win32') {
        const stat = await fs.stat(nested);
        expect(stat.mode & 0o777).toBe(0o700);
        const [entry] = await fs.readdir(nested);
        const fileStat = await fs.stat(path.join(nested, entry));
        expect(fileStat.mode & 0o777).toBe(0o600);
      }
      await b.close();
    });
  });
});

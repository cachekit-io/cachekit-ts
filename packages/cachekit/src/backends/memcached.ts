import type { Client as MemjsClient } from 'memjs';
import { Backend, MemcachedBackendConfig } from './types.js';
import { BackendError, ConfigurationError, TimeoutError } from '../errors.js';

/**
 * Memcached maximum relative TTL: 30 days in seconds. The protocol treats any
 * larger `expires` as an absolute UNIX timestamp, so cachekit clamps here
 * (matching cachekit-py) instead of letting a "31 days" TTL expire instantly.
 */
export const MAX_MEMCACHED_TTL = 30 * 24 * 60 * 60;

/** Server default item-size limit (-I flag): 1 MiB. */
const DEFAULT_MAX_ITEM_SIZE_BYTES = 1024 * 1024;

/**
 * Memcached backend using memjs (binary protocol, multi-server support).
 *
 * Node-runtime only, behind the `@cachekit-io/cachekit/backends/memcached`
 * subpath export. `memjs` is an optional peer dependency loaded lazily on
 * first use — install it alongside cachekit (`pnpm add memjs`); browser/edge
 * bundles that never import this subpath never see it.
 *
 * Capability surface matches cachekit-py's Memcached backend: base Backend
 * only, plus a directly-callable {@link refreshTTL}. It is deliberately NOT a
 * TTLBackend — the memcached protocol has no command to *read* a key's
 * remaining TTL (memjs exposes no meta protocol), so `getTTL` cannot exist.
 * `refreshTTL` ships anyway because the `touch` command makes it trivially
 * free, exactly mirroring py's `refresh_ttl`.
 *
 * @example
 * ```typescript
 * import { memcached } from '@cachekit-io/cachekit/backends/memcached';
 *
 * const backend = memcached({ servers: ['mc1:11211', 'mc2:11211'] });
 * await backend.set('key', new TextEncoder().encode('value'), 3600);
 * await backend.close();
 * ```
 */
export class MemcachedBackend implements Backend {
  private readonly config: Required<MemcachedBackendConfig>;
  private closed = false;
  /** Memoized lazy client — memjs is an optional peer dep, imported on first use. */
  private clientPromise: Promise<MemjsClient> | null = null;

  /** Applied client-side to every key (like py) — exposed so interop mode
   * can fail closed; see Backend.keyPrefix for the contract. */
  get keyPrefix(): string {
    return this.config.keyPrefix;
  }

  constructor(config: MemcachedBackendConfig = {}) {
    const servers = config.servers ?? ['127.0.0.1:11211'];
    if (servers.length === 0) {
      throw new ConfigurationError('At least one Memcached server must be specified');
    }
    for (const server of servers) {
      const port = Number(server.slice(server.lastIndexOf(':') + 1));
      if (!server.includes(':') || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigurationError(
          `Memcached server address must be 'host:port' with port 1-65535, got: ${server}`
        );
      }
    }

    this.config = {
      servers,
      defaultTtl: config.defaultTtl ?? 0,
      timeout: config.timeout ?? 1000,
      connectTimeout: config.connectTimeout ?? 2000,
      retries: config.retries ?? 2,
      keyPrefix: config.keyPrefix ?? '',
      maxItemSizeBytes: config.maxItemSizeBytes ?? DEFAULT_MAX_ITEM_SIZE_BYTES,
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.ensureNotClosed();
    const client = await this.getClient();

    try {
      const { value } = await client.get(this.prefixedKey(key));
      return value ? new Uint8Array(value) : null;
    } catch (error) {
      throw this.wrapError('get', error);
    }
  }

  async set(key: string, value: Uint8Array, ttl?: number): Promise<void> {
    this.ensureNotClosed();

    // Fail loudly BEFORE sending: the server rejects items over its -I limit
    // (default 1 MiB), and that rejection is easy to lose — guard client-side
    // so the caller can compress, shard, or switch backends (matches py).
    const maxSize = this.config.maxItemSizeBytes;
    if (maxSize > 0 && value.length > maxSize) {
      throw new BackendError(
        `Value for key '${key}' is ${value.length} bytes, which exceeds the Memcached max ` +
          `item size of ${maxSize} bytes. Enable compression, use a larger-payload backend ` +
          `(Redis/SaaS/File), or raise both the server's -I limit and maxItemSizeBytes.`
      );
    }

    const effectiveTtl = ttl ?? this.config.defaultTtl;
    const expires =
      effectiveTtl > 0 ? Math.min(Math.max(1, Math.floor(effectiveTtl)), MAX_MEMCACHED_TTL) : 0;

    const client = await this.getClient();
    try {
      await client.set(this.prefixedKey(key), Buffer.from(value), { expires });
    } catch (error) {
      throw this.wrapError('set', error);
    }
  }

  async delete(key: string): Promise<boolean> {
    this.ensureNotClosed();
    const client = await this.getClient();

    try {
      return await client.delete(this.prefixedKey(key));
    } catch (error) {
      throw this.wrapError('delete', error);
    }
  }

  /** Memcached has no native EXISTS command; GET and check for null (matches py). */
  async exists(key: string): Promise<boolean> {
    this.ensureNotClosed();
    const client = await this.getClient();

    try {
      const { value } = await client.get(this.prefixedKey(key));
      return value !== null;
    } catch (error) {
      throw this.wrapError('exists', error);
    }
  }

  /**
   * Refresh a key's TTL via the memcached `touch` command. Returns false when
   * the key doesn't exist. TTLs are clamped to the 30-day maximum like `set`.
   *
   * This is the ONLY half of TTLBackend memcached can ship (see class docs) —
   * it is a plain method, not a TTLBackend implementation, so capability
   * checks (`'getTTL' in backend`) correctly exclude this backend. Throws on
   * ttl <= 0 per the ts-wide refreshTTL contract (py's refresh_ttl(0) means
   * "make permanent"; ts rejects non-positive TTLs on every backend so
   * swapping backends never changes zero-semantics).
   */
  async refreshTTL(key: string, ttl: number): Promise<boolean> {
    this.ensureNotClosed();

    const seconds = Math.floor(ttl);
    if (seconds <= 0) {
      throw new BackendError(`Memcached refreshTTL requires ttl >= 1 second, got ${ttl}`);
    }

    const client = await this.getClient();
    try {
      return await client.touch(this.prefixedKey(key), Math.min(seconds, MAX_MEMCACHED_TTL));
    } catch (error) {
      throw this.wrapError('refreshTTL', error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.clientPromise) {
      // quit() flushes outstanding requests before closing (vs close()'s abort).
      const client = await this.clientPromise.catch(() => null);
      client?.quit();
    }
  }

  // ==================== private ====================

  private prefixedKey(key: string): string {
    return this.config.keyPrefix ? `${this.config.keyPrefix}${key}` : key;
  }

  private getClient(): Promise<MemjsClient> {
    this.clientPromise ??= (async () => {
      let memjs: typeof import('memjs');
      try {
        memjs = await import('memjs');
      } catch (error) {
        this.clientPromise = null; // don't cache the failure
        throw new ConfigurationError(
          "The Memcached backend requires the optional peer dependency 'memjs'. " +
            'Install it alongside @cachekit-io/cachekit: pnpm add memjs (or npm install memjs).',
          { cause: error }
        );
      }
      // memjs timeouts are in (fractional) seconds; cachekit config is ms.
      return memjs.Client.create(this.config.servers.join(','), {
        expires: 0, // per-op expires is always passed explicitly in set()
        timeout: this.config.timeout / 1000,
        conntimeout: this.config.connectTimeout / 1000,
        retries: this.config.retries,
      });
    })();
    return this.clientPromise;
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new BackendError('Memcached backend is closed');
    }
  }

  private wrapError(operation: string, error: unknown): Error {
    if (error instanceof Error) {
      if (error.message.includes('timed out') || error.message.includes('timeout')) {
        return new TimeoutError(`Memcached ${operation} timed out: ${error.message}`, {
          cause: error,
        });
      }
      return new BackendError(`Memcached ${operation} failed: ${error.message}`, 'transient', {
        cause: error,
      });
    }
    return new BackendError(`Memcached ${operation} failed: Unknown error`);
  }
}

/**
 * Factory function to create a Memcached backend.
 *
 * @example
 * ```typescript
 * import { memcached } from '@cachekit-io/cachekit/backends/memcached';
 *
 * const backend = memcached({
 *   servers: ['127.0.0.1:11211'],
 *   keyPrefix: 'myapp:',
 * });
 * ```
 */
export function memcached(config: MemcachedBackendConfig = {}): MemcachedBackend {
  return new MemcachedBackend(config);
}

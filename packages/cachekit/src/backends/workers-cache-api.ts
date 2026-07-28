import { Backend } from './types.js';
import { BackendError, ConfigurationError } from '../errors.js';
import { classifyWorkersRuntimeError } from './error-classifier.js';
import { DEFAULT_TTL_SECONDS } from '../constants.js';

/**
 * `ttl <= 0` means "no expiry" on Redis/KV, but the Cache API has no
 * unbounded storage — freshness always comes from `Cache-Control`. Such
 * entries get a 1-year max-age instead (Cloudflare's edge-TTL ceiling).
 */
const CACHE_API_NO_EXPIRY_MAX_AGE = 31_536_000;

/**
 * Synthetic URL base for cache keys. The Cache API is request-keyed, so each
 * cache key maps to a URL under a deliberately non-routable host — it can
 * never collide with real zone traffic cached in `caches.default`, and is
 * never fetched.
 *
 * The key rides a query parameter, NOT a path segment: the WHATWG URL
 * parser dot-normalizes path segments AFTER percent-decoding, so path-borne
 * keys '.', '..' — and even their '%2E' escapes — would alias the empty key
 * or escape the prefix entirely (CWE-41). Query strings are never
 * normalized, and encodeURIComponent escapes '&'/'='/'#', so the key → URL
 * mapping stays injective for every possible key.
 */
const SYNTHETIC_KEY_BASE = 'https://cachekit.invalid/v1/cache?key=';

/**
 * Minimal structural view of a Workers `Cache` / `CacheStorage`.
 *
 * Duck-typed so the SDK does not depend on `@cloudflare/workers-types`;
 * `caches.default` is Cloudflare-specific (absent from the WHATWG interface),
 * hence the local shape.
 */
export interface CacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
}

export interface CacheStorageLike {
  open(cacheName: string): Promise<CacheLike>;
  readonly default?: CacheLike;
}

/**
 * Configuration for the Workers Cache API backend.
 *
 * @example
 * ```typescript
 * const backend = workersCacheAPI(); // caches.default
 * const named = workersCacheAPI({ cacheName: 'cachekit' });
 * ```
 */
export interface CacheAPIBackendConfig {
  /** Named cache (`caches.open(name)`). Omit to use `caches.default`. */
  cacheName?: string;
  /** Default TTL in seconds for set operations without explicit TTL */
  defaultTtl?: number;
}

/**
 * Cache API backend — stores opaque bytes in the Cloudflare Workers Cache
 * API (`caches.default` or a named cache). Cloudflare-Workers-only
 * (`/workers` entrypoint).
 *
 * The Cache API is request-keyed: each cache key is mapped to a synthetic,
 * never-fetched URL under a non-routable host, and the value rides a
 * `Response` whose `Cache-Control: max-age` carries the TTL. That model
 * makes this a **point-of-presence tier, not authoritative storage**:
 *
 * - Entries are per-data-center — a hit in one Cloudflare location says
 *   nothing about another. Use it as a read-through accelerator in front of
 *   a shared source (CachekitIO, KV, your origin), not as the only copy.
 * - Eviction is best-effort: Cloudflare may drop entries before their TTL
 *   under cache pressure. Expiry itself is honored to the second (no 60s
 *   floor, unlike KV).
 * - `delete()` only affects the current data center.
 *
 * Encryption-agnostic: sits below serialization / envelope / encryption, so
 * secure caches store only ciphertext.
 *
 * @example
 * ```typescript
 * import { createCache, workersCacheAPI } from '@cachekit-io/cachekit/workers';
 *
 * const cache = createCache.minimal({ backend: workersCacheAPI(), ttl: 60 });
 * ```
 */
export class CacheAPIBackend implements Backend {
  /** Keys map 1:1 to synthetic URLs — no prefixing. See Backend.keyPrefix. */
  readonly keyPrefix?: string;
  /**
   * `keyUrl()` re-encodes each key onto a synthetic URL — a key transform,
   * not a prefix — so this backend is interop-incompatible. Interop caches
   * must use a verbatim-key backend (KV / Redis / CachekitIO).
   * See Backend.transformsKeys.
   */
  readonly transformsKeys = true;
  private readonly cacheName?: string;
  private readonly defaultTtl: number;
  private cachePromise: Promise<CacheLike> | null = null;
  private closed = false;

  constructor(config: CacheAPIBackendConfig = {}) {
    this.cacheName = config.cacheName;
    this.defaultTtl = config.defaultTtl ?? DEFAULT_TTL_SECONDS;
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.ensureNotClosed();
    try {
      const response = await (await this.cache()).match(keyUrl(key));
      if (response === undefined) return null;
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw this.wrapError('get', error);
    }
  }

  async set(key: string, value: Uint8Array, ttl?: number): Promise<void> {
    this.ensureNotClosed();
    const effectiveTtl = ttl ?? this.defaultTtl;
    const maxAge = effectiveTtl > 0 ? Math.ceil(effectiveTtl) : CACHE_API_NO_EXPIRY_MAX_AGE;
    try {
      await (
        await this.cache()
      ).put(
        keyUrl(key),
        new Response(value, {
          headers: {
            'Cache-Control': `max-age=${maxAge}`,
            'Content-Type': 'application/octet-stream',
          },
        })
      );
    } catch (error) {
      throw this.wrapError('set', error);
    }
  }

  async delete(key: string): Promise<boolean> {
    this.ensureNotClosed();
    try {
      return await (await this.cache()).delete(keyUrl(key));
    } catch (error) {
      throw this.wrapError('delete', error);
    }
  }

  async exists(key: string): Promise<boolean> {
    this.ensureNotClosed();
    try {
      const response = await (await this.cache()).match(keyUrl(key));
      if (response === undefined) return false;
      // Discard the body deterministically rather than leaving a dangling
      // stream for workerd to clean up.
      await response.body?.cancel();
      return true;
    } catch (error) {
      throw this.wrapError('exists', error);
    }
  }

  async close(): Promise<void> {
    // The Cache API has no connection to release.
    this.closed = true;
  }

  private cache(): Promise<CacheLike> {
    this.cachePromise ??= this.openCache();
    return this.cachePromise;
  }

  private async openCache(): Promise<CacheLike> {
    const caches = (globalThis as { caches?: CacheStorageLike }).caches;
    if (caches === undefined) {
      throw new ConfigurationError(
        'The Cache API backend requires the Workers `caches` global — ' +
          'it is only available on the Cloudflare Workers runtime.'
      );
    }
    if (this.cacheName !== undefined) {
      return caches.open(this.cacheName);
    }
    if (caches.default === undefined) {
      throw new ConfigurationError(
        'caches.default is not available on this runtime; pass cacheName to use a named cache.'
      );
    }
    return caches.default;
  }

  private wrapError(operation: string, error: unknown): Error {
    // ConfigurationError passes through unwrapped because openCache() throws
    // lazily INSIDE each op's try-block (unlike KV, whose config errors
    // throw in the constructor) — wrapping would bury the clean "caches
    // global missing" setup error inside a BackendError.
    if (error instanceof ConfigurationError) return error;
    if (error instanceof Error) {
      return new BackendError(
        `Cache API ${operation} failed: ${error.message}`,
        classifyWorkersRuntimeError(error),
        { cause: error }
      );
    }
    return new BackendError(`Cache API ${operation} failed: Unknown error`);
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new BackendError('Cache API backend is closed');
    }
  }
}

function keyUrl(key: string): string {
  return SYNTHETIC_KEY_BASE + encodeURIComponent(key);
}

/**
 * Create a Cache API backend (per-data-center read-through tier).
 *
 * @example
 * ```typescript
 * const cache = createCache({ backend: workersCacheAPI() });
 * ```
 */
export function workersCacheAPI(config: CacheAPIBackendConfig = {}): CacheAPIBackend {
  return new CacheAPIBackend(config);
}

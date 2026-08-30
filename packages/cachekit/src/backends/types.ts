/**
 * Backend interface for pluggable cache storage.
 *
 * Backends operate on raw bytes (Uint8Array), not deserialized values.
 * Serialization/encryption happens at higher layers.
 *
 * Implement this interface to create custom backends (e.g., Memcached, DynamoDB).
 *
 * @example
 * ```typescript
 * class MyBackend implements Backend {
 *   async get(key: string): Promise<Uint8Array | null> {
 *     // fetch from your storage
 *   }
 *   // ... other methods
 * }
 * ```
 */
export interface Backend {
  /**
   * Retrieve a value by key.
   *
   * @param key - Cache key
   * @returns The stored bytes, or null if not found
   * @throws {BackendError} if the operation fails
   */
  get(key: string): Promise<Uint8Array | null>;

  /**
   * Retrieve a value together with its remaining TTL — in the SAME storage
   * round trip as a plain get (LAB-1388). Optional capability: implement it
   * only when the store surfaces the expiry on read for free (Cache API
   * response headers, Redis GET+TTL pipeline). Do NOT implement it as
   * get + a second TTL request — CacheImpl calls this on every L2 hit when
   * L1 is enabled, and a second round trip there doubles read latency (and
   * on metered backends, cost).
   *
   * CacheImpl uses the returned `ttlSeconds` to cap L1 re-population at the
   * entry's remaining lifetime, so an L1 copy never outlives the L2 entry it
   * was read from. Backends without this capability fall back to `get()`,
   * where L1 re-population is bounded only by the cache's default TTL.
   *
   * @returns The stored bytes plus remaining TTL in seconds (`null` TTL =
   *   unknown or no expiry), or `null` when the key is missing
   * @throws {BackendError} if the operation fails
   */
  getWithTtl?(key: string): Promise<GetWithTtlResult | null>;

  /**
   * Store a value with optional TTL.
   *
   * @param key - Cache key
   * @param value - Raw bytes to store
   * @param ttl - Time-to-live in seconds (optional, backend default if omitted)
   * @throws {BackendError} if the operation fails
   */
  set(key: string, value: Uint8Array, ttl?: number): Promise<void>;

  /**
   * Optional capability: synchronously reject a TTL this backend cannot
   * store, BEFORE any I/O. CacheImpl calls this ahead of the reliability
   * executor, because a deterministic caller error must surface to the
   * caller — inside the executor, degradation (on by default) would swallow
   * it, so a `set()` with an invalid TTL would silently never store, and
   * retry/circuit-breaker would count the caller's mistake as backend
   * failures. Same rationale as the interop-rejection path in CacheImpl.
   *
   * Implement only where the backend has hard TTL bounds (CachekitIO's
   * protocol rules: reject 0/negative/> 30 days). Backends that map
   * out-of-range TTLs to a defined behavior (e.g. `ttl <= 0` = no expiry
   * on Redis/File/Workers KV) omit it.
   *
   * Delegating wrappers MUST forward the inner backend's implementation,
   * or they hide the rejection from CacheImpl.
   *
   * @throws {ConfigurationError} when the TTL is invalid for this backend
   */
  validateTtl?(ttl: number): void;

  /**
   * Delete a key from the cache.
   *
   * @param key - Cache key to delete
   * @returns true if key existed and was deleted, false if key didn't exist
   * @throws {BackendError} if the operation fails
   */
  delete(key: string): Promise<boolean>;

  /**
   * Check if a key exists in the cache.
   *
   * @param key - Cache key to check
   * @returns true if key exists, false otherwise
   * @throws {BackendError} if the operation fails
   */
  exists(key: string): Promise<boolean>;

  /**
   * Close the backend connection and release resources.
   *
   * Should be called when the cache is no longer needed.
   * After close(), the backend should not be used.
   */
  close(): Promise<void>;

  /**
   * Prefix the backend transparently prepends to every key on the wire
   * (e.g. ioredis `keyPrefix`). A backend that prefixes keys MUST expose it
   * here: interop mode fails closed when a prefix is present, because
   * interop keys have to reach the store byte-identical to the Python and
   * Rust SDKs' bare `{namespace}:{operation}:{hash}` — a hidden prefix
   * means every cross-SDK read silently misses while the encryption AAD
   * stays bound to the un-prefixed key. Omit (or return '') when keys are
   * stored verbatim.
   *
   * Contract details:
   * - The value MUST be constant from construction onward — interop guards
   *   read it at wrap time and on every call, and a request-scoped prefix
   *   cannot be made safe.
   * - Delegating wrappers (metrics, logging, fallback decorators) MUST
   *   forward the inner backend's `keyPrefix`, or they hide the transform
   *   from the guard.
   * - Backends applying any non-prefix key transformation (suffixing,
   *   hashing, re-encoding) cannot express it here; they declare
   *   {@link transformsKeys} instead and are incompatible with interop
   *   mode, full stop.
   */
  readonly keyPrefix?: string;

  /**
   * Set to `true` by backends that apply a non-prefix key transformation —
   * suffixing, hashing, or re-encoding (e.g. the Cloudflare Cache API maps
   * each key onto a synthetic URL). Such a transform cannot be expressed as
   * a plain {@link keyPrefix}, but it breaks interop for the same reason: the
   * key can never reach the store byte-identical to the Python and Rust SDKs'
   * bare `{namespace}:{operation}:{hash}`. Interop mode fails closed when this
   * is `true`. Backends that store keys verbatim omit it (or return `false`).
   *
   * Like `keyPrefix`, the value MUST be constant from construction onward.
   */
  readonly transformsKeys?: boolean;

  /**
   * The backend's preferred default for the ByteStorage compression
   * envelope (LAB-1388). Left unset, the cache-level default stays `true`.
   * Backends whose store already compresses values at rest (the Cloudflare
   * Cache API stores `Response` bodies compressed) advertise `false` here so
   * the default configuration doesn't spend CPU compressing twice. An
   * explicit `compression:` option on the cache always wins.
   *
   * Like `keyPrefix`, the value MUST be constant from construction onward.
   */
  readonly compressionDefault?: boolean;
}

/** Result of {@link Backend.getWithTtl}: the bytes plus remaining lifetime. */
export interface GetWithTtlResult {
  /** The stored bytes. */
  value: Uint8Array;
  /**
   * Remaining TTL in seconds, or `null` when unknown / no expiry (matches
   * {@link TTLBackend.getTTL}'s collapse of Redis's -1).
   */
  ttlSeconds: number | null;
}

/**
 * Configuration for Redis backend.
 */
export interface RedisBackendConfig {
  /** Redis connection URL (e.g., "redis://localhost:6379") */
  url: string;
  /** Default TTL in seconds for set operations without explicit TTL */
  defaultTtl?: number;
  /** Connection timeout in milliseconds */
  connectTimeout?: number;
  /** Command timeout in milliseconds */
  commandTimeout?: number;
  /** Enable TLS */
  tls?: boolean;
  /** Key prefix for namespacing */
  keyPrefix?: string;
}

/**
 * Configuration for the Memcached backend (Node-runtime only).
 *
 * The backend lives at the `@cachekit-io/cachekit/backends/memcached` subpath
 * export and requires the optional `memjs` peer dependency — neither enters
 * the root bundle, so browser/edge consumers are unaffected.
 */
export interface MemcachedBackendConfig {
  /**
   * Memcached server addresses in "host:port" format
   * (default: ["127.0.0.1:11211"], matching cachekit-py).
   */
  servers?: string[];
  /**
   * Default TTL in seconds for set operations without explicit TTL.
   * Default 0 = never expire, matching cachekit-py's Memcached backend
   * (NOT the Redis backend's 1-hour default).
   */
  defaultTtl?: number;
  /** Operation timeout in milliseconds (default: 1000, matching py's 1.0s) */
  timeout?: number;
  /** Connection timeout in milliseconds (default: 2000, matching py's 2.0s) */
  connectTimeout?: number;
  /** Retries on transient failures (default: 2, matching py) */
  retries?: number;
  /** Key prefix for namespacing (exposed via Backend.keyPrefix for the interop guard) */
  keyPrefix?: string;
  /**
   * Reject values larger than this BEFORE sending to Memcached
   * (default: 1 MiB, matching the server's default item-size limit; 0 disables).
   * Memcached rejects oversized items server-side; guarding client-side keeps
   * the failure loud and actionable (compress, shard, or switch backends).
   */
  maxItemSizeBytes?: number;
}

/**
 * Configuration for the File backend (Node-runtime only).
 *
 * The backend lives at the `@cachekit-io/cachekit/backends/file` subpath
 * export so its `node:fs` imports never enter the root bundle.
 */
export interface FileBackendConfig {
  /**
   * Directory for cache files
   * (default: `${os.tmpdir()}/cachekit`, matching cachekit-py).
   */
  cacheDir?: string;
  /**
   * Default TTL in seconds for set operations without explicit TTL.
   * Default 0 = never expire, matching cachekit-py's File backend
   * (NOT the Redis backend's 1-hour default).
   */
  defaultTtl?: number;
  /** Maximum single value size in bytes (default: 100 MiB, matching py's max_value_mb=100; 0 disables) */
  maxValueBytes?: number;
  /** Cache file permissions (default: 0o600 — owner-only, matching py) */
  fileMode?: number;
  /** Cache directory permissions (default: 0o700 — owner-only, matching py) */
  dirMode?: number;
}

/**
 * Configuration for CachekitIO (SaaS HTTP) backend.
 *
 * Connects to api.cachekit.io (or custom endpoint) via HTTPS.
 *
 * @example
 * ```typescript
 * const backend = cachekitio({
 *   apiKey: process.env.CACHEKIT_API_KEY!,
 *   apiUrl: 'https://api.cachekit.io',
 *   defaultTtl: 3600,
 * });
 * ```
 */
export interface CachekitIOBackendConfig {
  /** API key for authentication (required, e.g., "ck_live_...") */
  apiKey: string;
  /** API endpoint URL (default: "https://api.cachekit.io"). Must be HTTPS. */
  apiUrl?: string;
  /**
   * Default TTL in seconds for set operations without explicit TTL.
   * Protocol bounds apply (saas-api.md TTL Validation Rules): must be
   * greater than 0 and at most 2,592,000 (30 days) — out-of-range values
   * throw ConfigurationError at construction. Unlike File/Memcached,
   * `0` does NOT mean "never expire" here; the protocol rejects it.
   */
  defaultTtl?: number;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Allow non-standard API hostnames (custom proxies, etc.) */
  allowCustomHost?: boolean;
  /** Provider function for L1 cache metrics (used in request headers) */
  metricsProvider?: () => L1Metrics | null;
}

export interface L1Metrics {
  l1Hits: number;
  l2Hits: number;
  misses: number;
  l1Enabled: boolean;
}

/**
 * Optional capability: distributed locking for cache stampede prevention.
 *
 * Contract (shared by every implementation and pinned by regression tests —
 * see cachekit-py#135 / cachekit-ts#70 for the regressions this prevents):
 * - Lock methods take the same BARE cache key as get/set/delete. Any lock
 *   namespace (e.g. Redis's on-wire `<key>:lock`) is derived internally by
 *   the backend; callers MUST NOT pre-suffix the key.
 * - The lease is best-effort stampede mitigation bounded by `timeoutMs`,
 *   not a mutual-exclusion guarantee: a holder that outlives the lease
 *   loses exclusivity. Size `timeoutMs` at or above the expected recompute.
 */
export interface LockableBackend extends Backend {
  /**
   * Acquire the lock, or return null when another client holds it
   * (contested — never blocks, retries, or throws for contention; LAB-240).
   *
   * @param timeoutMs - Lease duration in milliseconds before auto-release
   *   (default 5000)
   * @returns The lock capability token to pass to releaseLock, or null
   */
  acquireLock(key: string, timeoutMs?: number): Promise<string | null>;

  /**
   * Release a lock acquired with acquireLock. Must be compare-and-delete:
   * returns false (releasing nothing) when the lease expired or lockId is
   * not the current holder's — never releases another holder's lock.
   */
  releaseLock(key: string, lockId: string): Promise<boolean>;
}

/** Optional capability: TTL inspection and refresh. */
export interface TTLBackend extends Backend {
  /**
   * Remaining TTL in seconds, or null when the key is missing OR exists
   * without an expiry (matches cachekit-py's collapse of Redis's -2/-1).
   */
  getTTL(key: string): Promise<number | null>;

  /**
   * Reset the key's TTL to `ttl` seconds (>= 1). Returns false when the key
   * doesn't exist; throws on ttl <= 0 rather than deleting the key.
   */
  refreshTTL(key: string, ttl: number): Promise<boolean>;
}

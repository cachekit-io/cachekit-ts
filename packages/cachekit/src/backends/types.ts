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
   * Store a value with optional TTL.
   *
   * @param key - Cache key
   * @param value - Raw bytes to store
   * @param ttl - Time-to-live in seconds (optional, backend default if omitted)
   * @throws {BackendError} if the operation fails
   */
  set(key: string, value: Uint8Array, ttl?: number): Promise<void>;

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
   *   hashing, re-encoding) cannot express it here and are incompatible
   *   with interop mode, full stop.
   */
  readonly keyPrefix?: string;
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
  /** Default TTL in seconds for set operations without explicit TTL */
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

export interface LockableBackend extends Backend {
  acquireLock(key: string, timeoutMs?: number): Promise<string | null>;
  releaseLock(key: string, lockId: string): Promise<boolean>;
}

export interface TTLBackend extends Backend {
  getTTL(key: string): Promise<number | null>;
  refreshTTL(key: string, ttl: number): Promise<boolean>;
}

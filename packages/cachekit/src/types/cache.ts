import type { Backend, RedisBackendConfig, CachekitIOBackendConfig } from '../backends/types.js';
import type { L1Config } from '../l1/types.js';
import type { MetricsConfig } from '../metrics/prometheus.js';
import type { CircuitBreakerConfig } from '../reliability/circuit-breaker.js';
import type { RetryConfig } from '../reliability/retry.js';
import type { SerializerConfig } from '../serialization/serializer.js';
import type { Redis } from 'ioredis';

/**
 * Configuration for cross-instance cache invalidation via Redis Pub/Sub.
 */
export interface InvalidationConfig {
  /** Redis client for Pub/Sub (will be duplicated for subscriber) */
  redis: Redis;
  /** Channel name for invalidation messages (default: "cachekit:invalidate") */
  channelName?: string;
}

/**
 * Options for individual cache set operations.
 */
export interface SetOptions {
  /** Time-to-live in seconds (overrides default) */
  ttl?: number;
  /** Namespace for this entry (for invalidation) */
  namespace?: string;
}

/**
 * Options shared by both wrap modes.
 */
export interface WrapOptionsBase {
  /** Cache namespace (e.g., "user-service:getUser") */
  namespace: string;
  /** Time-to-live in seconds */
  ttl: number;
  /** Skip L1 cache for this operation */
  skipL1?: boolean;
}

/**
 * Options for wrap operations (function caching).
 *
 * Interop mode is a discriminated pair: `interop` and `interopArity` must be
 * provided together (enforced at compile time for TS callers and at wrap
 * time for JS callers).
 */
export type WrapOptions = WrapOptionsBase &
  (
    | {
        interop?: undefined;
        interopArity?: undefined;
      }
    | {
        /**
         * Opt into interop mode (interop/v1) with an explicit,
         * language-neutral operation name — cache entries become readable
         * and writable by the Python and Rust SDKs.
         *
         * Keys use `{namespace}:{operation}:{args_hash}` (canonical
         * cross-SDK argument hashing) and values are stored as plain
         * MessagePack with no ByteStorage envelope. Both `namespace` and the
         * operation name must match `^[a-z0-9][a-z0-9._-]{0,63}$` (validated
         * at wrap time).
         *
         * Fails closed — at wrap time and on every call — if the backend
         * applies a key prefix (e.g. Redis `keyPrefix`): a prefixed interop
         * key would silently miss the bare key the other SDKs read and
         * write. Use a separate unprefixed client for interop caches.
         *
         * The wrapped function MUST NOT use default, optional, or rest
         * parameters, and callers MUST pass the full declared arity — JS
         * cannot introspect defaults, so they would silently diverge from
         * the other SDKs' named-to-positional binding. Integer arguments
         * beyond `Number.isSafeInteger` must be passed as BigInt.
         */
        interop: string;
        /**
         * The interop operation's exact argument count — the cross-SDK
         * contract arity.
         *
         * Declared explicitly rather than inferred from `fn.length`, because
         * `fn.length` stops counting at the first default or rest parameter:
         * an accidental `(a, b = 5)` would silently hash `[a]` while Python
         * binds the default and hashes `[a, 5]`. Wrap fails when `fn.length`
         * disagrees with this declaration (default/rest parameters, or a
         * wrapper that erased the parameter list), and every call must pass
         * exactly this many arguments.
         */
        interopArity: number;
      }
  );

/**
 * Encryption configuration for cache.
 */
export interface EncryptionConfig {
  /** Master encryption key (hex-encoded, min 32 bytes) */
  masterKey: string;
  /** Tenant ID for key derivation isolation */
  tenantId?: string;
}

/**
 * Reliability configuration for cache.
 */
export interface ReliabilityConfig {
  /** Circuit breaker configuration */
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  /** Retry policy configuration */
  retry?: Partial<RetryConfig>;
  /** Enable graceful degradation (default: true) */
  degradation?: boolean;
}

/**
 * Configuration options for creating a cache instance.
 */
export interface CacheOptions {
  /** Backend configuration or instance */
  backend: Backend | RedisBackendConfig | CachekitIOBackendConfig;

  /** Default TTL in seconds for cache entries (default: 3600) */
  defaultTtl?: number;

  /** L1 (in-memory) cache configuration */
  l1?: Partial<L1Config> & { enabled?: boolean };

  /** Encryption configuration (enables zero-knowledge caching) */
  encryption?: EncryptionConfig;

  /** Reliability configuration (circuit breaker, retry) */
  reliability?: ReliabilityConfig;

  /** Serializer configuration */
  serializer?: Partial<SerializerConfig>;

  /** Enable ByteStorage wire format (LZ4 compression + xxHash3-64 integrity). Default: true */
  compression?: boolean;

  /**
   * Enable Prometheus metrics (`true`), or enable with configuration
   * (prefix, default labels, custom registry). Requires the optional
   * `prom-client` peer dependency — when it is missing, metrics report the
   * failure once through the library logger and degrade to no-ops.
   * Default: false.
   */
  metrics?: boolean | MetricsConfig;

  /** Cross-instance invalidation via Redis Pub/Sub */
  invalidation?: InvalidationConfig;
}

/**
 * Main cache interface.
 *
 * Provides both raw key-value operations and function wrapping.
 */
export interface Cache {
  /**
   * Get a value from cache.
   *
   * @param key - Cache key
   * @returns Cached value or null if not found
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Set a value in cache.
   *
   * @param key - Cache key
   * @param value - Value to cache
   * @param options - Set options (TTL, namespace)
   */
  set<T>(key: string, value: T, options?: SetOptions): Promise<void>;

  /**
   * Delete a key from cache.
   *
   * @param key - Cache key to delete
   * @returns true if key existed and was deleted
   */
  delete(key: string): Promise<boolean>;

  /**
   * Check if a key exists in cache.
   *
   * @param key - Cache key to check
   * @returns true if key exists
   */
  exists(key: string): Promise<boolean>;

  /**
   * Wrap a function with caching.
   *
   * The wrapped function automatically caches results based on arguments.
   *
   * @example
   * ```typescript
   * const getUser = cache.wrap(
   *   async (id: number) => db.users.find(id),
   *   { namespace: 'users:getUser', ttl: 3600 }
   * );
   * const user = await getUser(123); // Cached
   * ```
   */
  wrap<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    options: WrapOptions
  ): (...args: TArgs) => Promise<TResult>;

  /**
   * Create a partial application of wrap with preset options.
   *
   * @example
   * ```typescript
   * const cachedUser = cache.with({ namespace: 'users', ttl: 3600 });
   * const getUser = cachedUser((id) => db.users.find(id));
   * ```
   */
  with(
    options: WrapOptions
  ): <TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>
  ) => (...args: TArgs) => Promise<TResult>;

  /**
   * Invalidate cache entries.
   *
   * @param level - Invalidation level: 'global', 'namespace', or 'params'
   * @param options - Namespace or key to invalidate
   */
  invalidate(
    level: 'global' | 'namespace' | 'params',
    options?: { namespace?: string; key?: string }
  ): Promise<void>;

  /**
   * Close the cache and release resources.
   */
  close(): Promise<void>;
}

/**
 * Secure cache interface with encryption.
 * Extends Cache with secure-only wrap method.
 */
export interface SecureCache extends Cache {
  /**
   * Secure version of wrap that always encrypts.
   */
  secure: {
    wrap<TArgs extends unknown[], TResult>(
      fn: (...args: TArgs) => Promise<TResult>,
      // Plain WrapOptions: 'encrypt' was never one of its keys, and an Omit
      // over the interop discriminated union would flatten it and lose the
      // compile-time interop/interopArity pairing.
      options: WrapOptions
    ): (...args: TArgs) => Promise<TResult>;
  };
}

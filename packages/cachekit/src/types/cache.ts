import type { Backend, RedisBackendConfig, CachekitIOBackendConfig } from '../backends/types.js';
import type { L1Config } from '../l1/types.js';
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
 * Options for wrap operations (function caching).
 */
export interface WrapOptions {
  /** Cache namespace (e.g., "user-service:getUser") */
  namespace: string;
  /** Time-to-live in seconds */
  ttl: number;
  /** Skip L1 cache for this operation */
  skipL1?: boolean;
}

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

  /** Enable Prometheus metrics */
  metrics?: boolean;

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
  with(options: WrapOptions): <TArgs extends unknown[], TResult>(
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
      options: Omit<WrapOptions, 'encrypt'>
    ): (...args: TArgs) => Promise<TResult>;
  };
}

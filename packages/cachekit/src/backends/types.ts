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

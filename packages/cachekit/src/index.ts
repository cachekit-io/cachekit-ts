// ============ Main API ============
export { createCache } from './cache.js';
export { redis } from './backends/redis.js';

// ============ Types ============
export type {
  Cache,
  SecureCache,
  CacheOptions,
  SetOptions,
  WrapOptions,
  EncryptionConfig,
  ReliabilityConfig,
  InvalidationConfig,
} from './types/cache.js';

export type { Backend, RedisBackendConfig } from './backends/types.js';

export type {
  L1Config,
  InvalidationLevel,
  InvalidationEvent,
} from './l1/types.js';

export type { CircuitBreakerConfig, CircuitState } from './reliability/circuit-breaker.js';
export type { RetryConfig } from './reliability/retry.js';
export type { SerializerConfig, Serializer } from './serialization/serializer.js';

// ============ Error Classes ============
export {
  CachekitError,
  ConfigurationError,
  EncryptionError,
  IntegrityError,
  BackendError,
  CircuitBreakerOpenError,
  TimeoutError,
  ValueTooLargeError,
  NonceExhaustedError,
  SerializationError,
} from './errors.js';

// ============ Optional Utilities ============
// Export for advanced users who want to customize
export { L1Cache } from './l1/lru-cache.js';
export { CircuitBreaker } from './reliability/circuit-breaker.js';
export { RetryPolicy } from './reliability/retry.js';
export { withDegradation, withDegradationFn } from './reliability/degradation.js';
export { MessagePackSerializer, defaultSerializer } from './serialization/serializer.js';
export { generateKey, generateParamsHash, extractNamespace } from './serialization/key-generator.js';
export { EncryptionManager } from './encryption/manager.js';
export { RedisInvalidationChannel } from './invalidation/redis-channel.js';
export {
  serializeEvent,
  deserializeEvent,
  createInvalidationEvent,
} from './invalidation/event.js';
export type { RedisInvalidationChannelConfig } from './invalidation/redis-channel.js';

// ============ Constants ============
// Export for users who want to reference defaults programmatically
export * from './constants.js';

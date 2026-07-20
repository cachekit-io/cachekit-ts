// ============ Main API ============
export { createCache } from './intents.js';
export type {
  CreateCacheFn,
  MinimalOptions,
  ProductionOptions,
  SecureOptions,
  IOOptions,
} from './intents.js';
export { redis } from './backends/redis.js';
export {
  cachekitio,
  cachekitioWithLocking,
  cachekitioWithTTL,
  cachekitioFull,
} from './backends/cachekitio-factory.js';
export { CachekitIOCore } from './backends/cachekitio.js';

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

export type {
  Backend,
  RedisBackendConfig,
  CachekitIOBackendConfig,
  LockableBackend,
  TTLBackend,
  L1Metrics,
} from './backends/types.js';

export type { ErrorClassification } from './backends/error-classifier.js';

export type { L1Config, InvalidationLevel, InvalidationEvent } from './l1/types.js';

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
export {
  generateKey,
  generateParamsHash,
  extractNamespace,
} from './serialization/key-generator.js';
// Interop mode (interop/v1): the key generator for manual invalidate/delete
// by key, and the value codec for direct cross-SDK readers. Lower-level
// helpers stay module-internal — public API on a frozen wire format is
// forever. NOTE: manual get/set/delete/invalidate with an interop key does
// NOT pass wrap()'s fail-closed keyPrefix guard — on a prefixed backend
// those calls silently target the prefixed key, so interop keys must only
// be used against unprefixed clients (see Backend.keyPrefix).
export {
  generateInteropKey,
  encodeInteropValue,
  decodeInteropValue,
} from './serialization/interop.js';
export { EncryptionManager } from './encryption/manager.js';
export { ByteStorage } from '@cachekit-io/cachekit-core-ts';
export { RedisInvalidationChannel } from './invalidation/redis-channel.js';
export { serializeEvent, deserializeEvent, createInvalidationEvent } from './invalidation/event.js';
export type { RedisInvalidationChannelConfig } from './invalidation/redis-channel.js';

// ============ Constants ============
// Export for users who want to reference defaults programmatically
export * from './constants.js';

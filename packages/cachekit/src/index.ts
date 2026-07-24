// ============ Main API ============
export { createCache } from './intents.js';
export { redis } from './backends/redis.js';

// ============ Shared surface (identical on the Workers entrypoint) ============
export * from './exports-common.js';

// ============ Node-only exports ============
export type { RedisBackendConfig } from './backends/types.js';
export type { InvalidationConfig } from './types/cache.js';
// Observability: the Prometheus collector reaches the optional prom-client
// peer dependency, so it stays off the shared (Workers-safe) surface.
export { CacheMetrics, NoopMetrics, createMetrics } from './metrics/prometheus.js';
export type { MetricsCollector, MetricsConfig } from './metrics/prometheus.js';
export { EncryptionManager } from './encryption/manager.js';
export { ByteStorage } from '@cachekit-io/cachekit-core-ts';
export { RedisInvalidationChannel } from './invalidation/redis-channel.js';
export { serializeEvent, deserializeEvent, createInvalidationEvent } from './invalidation/event.js';
export type { RedisInvalidationChannelConfig } from './invalidation/redis-channel.js';

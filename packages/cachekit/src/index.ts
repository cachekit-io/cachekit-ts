// ============ Main API ============
export { createCache } from './intents.js';
export { redis } from './backends/redis.js';

// ============ Shared surface (identical on the Workers entrypoint) ============
export * from './exports-common.js';

// ============ Node-only exports ============
export type {
  RedisBackendConfig,
  MemcachedBackendConfig,
  FileBackendConfig,
} from './backends/types.js';
// NOTE: the Memcached and File backends themselves are deliberately NOT
// re-exported here. They live behind subpath exports so the root entry never
// loads memjs or the File backend:
//   import { file } from '@cachekit-io/cachekit/backends/file';
//   import { memcached } from '@cachekit-io/cachekit/backends/memcached';
// The root entry is still Node-only: it loads ioredis, node:crypto and the
// NAPI core, whose loader requires node:fs. Edge code uses the `workerd`
// condition or '@cachekit-io/cachekit/workers'.
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

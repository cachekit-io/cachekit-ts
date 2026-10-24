import type {
  CacheOptions,
  SecureCache,
  InvalidationConfig,
  StampedeConfig,
} from './types/cache.js';
import type { L1Metrics, RedisBackendConfig, CachekitIOBackendConfig } from './backends/types.js';
import { redis } from './backends/redis.js';
import { cachekitio, cachekitioWithLocking } from './backends/cachekitio-factory.js';
import { createMetrics } from './metrics/prometheus.js';
import { EncryptionManager } from './encryption/manager.js';
import { ByteStorage } from '@cachekit-io/cachekit-core-ts';
import { RedisInvalidationChannel } from './invalidation/redis-channel.js';
import { CacheImpl, type CacheRuntime } from './cache-core.js';
import { AsyncResource } from 'node:async_hooks';

/**
 * The async context the key memo's timers are set in: the one this module loaded
 * in, never a caller's. Node.js gives a timer the context it was set in, so a
 * timer set inside a caller's AsyncLocalStorage context would hold that context,
 * a whole request perhaps, until it fired. A module first loaded inside such a
 * context (a lazy import in a request handler) keeps that one context for the
 * life of the process: Node.js can make a resource outside one storage's context
 * (exit()), but not outside every application's, so the README asks for the
 * package to be imported at startup.
 */
const keyMemoTimerScope = new AsyncResource('cachekit.keyMemoTimer');

/**
 * Node runtime: Redis + CachekitIO backends, NAPI bindings for the
 * ByteStorage envelope and encryption, Redis Pub/Sub invalidation.
 * The Workers entrypoint (workers/index.ts) supplies its own runtime —
 * everything protocol-critical is shared in cache-core.ts.
 */
const nodeRuntime: CacheRuntime = {
  resolveBackend(
    config: CacheOptions['backend'],
    stampede?: StampedeConfig,
    l1Telemetry?: () => L1Metrics
  ) {
    if ('get' in config) {
      return config;
    }
    if ('apiKey' in config) {
      const ioConfig = config as CachekitIOBackendConfig;
      // Auto-wire the SaaS telemetry headers from the cache's live hit/miss
      // counters; an explicit user-supplied provider still wins.
      const withTelemetry: CachekitIOBackendConfig = {
        ...ioConfig,
        metricsProvider: ioConfig.metricsProvider ?? l1Telemetry,
      };
      // The plain SaaS factory has no lock capability; the distributedLock
      // opt-in selects the lockable wrapper so config-based users aren't
      // forced to construct the backend by hand.
      return stampede?.distributedLock
        ? cachekitioWithLocking(withTelemetry)
        : cachekitio(withTelemetry);
    }
    return redis(config as RedisBackendConfig);
  },
  createMetrics: (config) => createMetrics(true, config),
  createByteStorage: () => new ByteStorage(),
  createEncryption: (config) =>
    new EncryptionManager(config.masterKey, config.tenantId, config.previousMasterKeys),
  createInvalidationChannel: (config: InvalidationConfig) =>
    new RedisInvalidationChannel(config.redis, { channelName: config.channelName }),
  setUnrefTimeout: (callback, ms) => {
    const timer = keyMemoTimerScope.runInAsyncScope(() => setTimeout(callback, ms));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/**
 * Create a configured cache instance.
 *
 * @param options - Cache configuration options
 * @returns Configured cache instance
 *
 * @example
 * ```typescript
 * import { createCache, redis } from '@cachekit-io/cachekit';
 *
 * const cache = createCache({
 *   backend: { url: 'redis://localhost:6379' },
 *   defaultTtl: 3600,
 *   l1: { enabled: true, maxEntries: 1000 },
 *   encryption: { masterKey: process.env.MASTER_KEY },
 * });
 *
 * // Direct key-value
 * await cache.set('user:123', { name: 'Alice' });
 * const user = await cache.get('user:123');
 *
 * // Function wrapping
 * const getUser = cache.wrap(
 *   async (id: number) => db.users.find(id),
 *   { namespace: 'users:getUser', ttl: 3600 }
 * );
 * const user = await getUser(123);
 *
 * // Cleanup
 * await cache.close();
 * ```
 */
export function createCache(options: CacheOptions): SecureCache {
  return new CacheImpl(options, nodeRuntime);
}

import type { CacheOptions, SecureCache, InvalidationConfig } from './types/cache.js';
import type { RedisBackendConfig, CachekitIOBackendConfig } from './backends/types.js';
import { redis } from './backends/redis.js';
import { cachekitio } from './backends/cachekitio-factory.js';
import { EncryptionManager } from './encryption/manager.js';
import { ByteStorage } from '@cachekit-io/cachekit-core-ts';
import { RedisInvalidationChannel } from './invalidation/redis-channel.js';
import { CacheImpl, type CacheRuntime } from './cache-core.js';

/**
 * Node runtime: Redis + CachekitIO backends, NAPI bindings for the
 * ByteStorage envelope and encryption, Redis Pub/Sub invalidation.
 * The Workers entrypoint (workers/index.ts) supplies its own runtime —
 * everything protocol-critical is shared in cache-core.ts.
 */
const nodeRuntime: CacheRuntime = {
  resolveBackend(config: CacheOptions['backend']) {
    if ('get' in config) {
      return config;
    }
    if ('apiKey' in config) {
      return cachekitio(config as CachekitIOBackendConfig);
    }
    return redis(config as RedisBackendConfig);
  },
  createByteStorage: () => new ByteStorage(),
  createEncryption: (config) => new EncryptionManager(config.masterKey, config.tenantId),
  createInvalidationChannel: (config: InvalidationConfig) =>
    new RedisInvalidationChannel(config.redis, { channelName: config.channelName }),
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

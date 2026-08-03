import { randomUUID } from 'node:crypto';
import { Redis as IoRedis, type RedisOptions } from 'ioredis';
import { GetWithTtlResult, LockableBackend, RedisBackendConfig, TTLBackend } from './types.js';
import type { RedisPubSubLike } from '../types/cache.js';
import { BackendError, TimeoutError } from '../errors.js';
import { logError } from '../logger.js';
import {
  DEFAULT_TTL_SECONDS,
  DEFAULT_REDIS_CONNECT_TIMEOUT,
  DEFAULT_REDIS_COMMAND_TIMEOUT,
  DEFAULT_REDIS_MAX_RETRIES,
  REDIS_RETRY_BASE_DELAY,
  REDIS_RETRY_MAX_DELAY,
} from '../constants.js';

/**
 * Atomic compare-and-delete: release the lock only if the caller still holds
 * it (stored value == lockId). A plain GET+DEL race would let a client whose
 * lock already expired delete the next holder's lock.
 */
const RELEASE_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

// Compile-time proof that a real ioredis client satisfies the structural
// RedisPubSubLike that replaced the nominal ioredis type in
// InvalidationConfig (LAB-1388). Anchored here because this is the one
// type-checked src module that already imports ioredis (tests are excluded
// from `tsc --noEmit`; this module is Node-closure-only, so the ioredis
// types never reach the workers type surface). Type-only — erased at
// runtime; if the structural type ever drifts incompatible, `pnpm
// type-check` fails here instead of in every consumer's build.
type AssertPubSubCompatible<T extends RedisPubSubLike> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _IoRedisIsPubSubCompatible = AssertPubSubCompatible<IoRedis>;

/**
 * Redis backend implementation using ioredis.
 *
 * Features:
 * - Connection pooling (handled by ioredis)
 * - Auto-reconnect with exponential backoff
 * - TLS support
 * - Key prefixing
 * - TTL inspection/refresh (TTLBackend)
 * - Distributed locking for stampede prevention (LockableBackend)
 *
 * @example
 * ```typescript
 * const backend = redis({ url: 'redis://localhost:6379' });
 * await backend.set('key', Buffer.from('value'), 3600);
 * const value = await backend.get('key');
 * await backend.close();
 * ```
 */
export class RedisBackend implements LockableBackend, TTLBackend {
  private readonly client: IoRedis;
  private readonly config: Required<RedisBackendConfig>;
  private closed = false;

  /** ioredis prepends this to every key on the wire — exposed so interop
   * mode can fail closed; see Backend.keyPrefix for the contract. */
  get keyPrefix(): string {
    return this.config.keyPrefix;
  }

  constructor(config: RedisBackendConfig) {
    this.config = {
      url: config.url,
      defaultTtl: config.defaultTtl ?? DEFAULT_TTL_SECONDS,
      connectTimeout: config.connectTimeout ?? DEFAULT_REDIS_CONNECT_TIMEOUT,
      commandTimeout: config.commandTimeout ?? DEFAULT_REDIS_COMMAND_TIMEOUT,
      tls: config.tls ?? false,
      keyPrefix: config.keyPrefix ?? '',
    };

    const redisOptions: RedisOptions = {
      connectTimeout: this.config.connectTimeout,
      commandTimeout: this.config.commandTimeout,
      retryStrategy: (times: number) => {
        // Exponential backoff: 100ms, 200ms, 400ms, ... up to 30s
        const delay = Math.min(
          REDIS_RETRY_BASE_DELAY * Math.pow(2, times - 1),
          REDIS_RETRY_MAX_DELAY
        );
        return delay;
      },
      maxRetriesPerRequest: DEFAULT_REDIS_MAX_RETRIES,
      enableReadyCheck: true,
      lazyConnect: false,
    };

    if (this.config.tls) {
      redisOptions.tls = {};
    }

    if (this.config.keyPrefix) {
      redisOptions.keyPrefix = this.config.keyPrefix;
    }

    this.client = new IoRedis(this.config.url, redisOptions);

    // Error handling - log but don't throw (connection errors handled per-operation)
    this.client.on('error', (err: Error) => {
      // Sanitize both message AND stack to prevent credential leakage (CWE-532)
      const sanitize = (text: string | undefined): string => {
        if (!text) return '';
        return text
          .replace(/redis:\/\/[^@]*@/g, 'redis://***@')
          .replace(/rediss:\/\/[^@]*@/g, 'rediss://***@');
      };

      const safeMessage = sanitize(err.message) || 'Unknown Redis error';
      logError(`[cachekit] Redis error: ${safeMessage}`);
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.ensureNotClosed();

    try {
      const result = await this.client.getBuffer(key);
      return result ? new Uint8Array(result) : null;
    } catch (error) {
      throw this.wrapError('get', error);
    }
  }

  /**
   * See {@link Backend.getWithTtl}: GET + TTL pipelined onto one round trip
   * (LAB-1388), so CacheImpl can cap L1 re-population at the entry's
   * remaining lifetime without a second network hop. TTL's -2 (missing) /
   * -1 (no expiry) collapse to null, matching {@link TTLBackend.getTTL};
   * a TTL-command failure downgrades to "unknown" rather than failing a
   * read whose GET succeeded.
   */
  async getWithTtl(key: string): Promise<GetWithTtlResult | null> {
    this.ensureNotClosed();

    try {
      const results = await this.client.pipeline().getBuffer(key).ttl(key).exec();
      if (!results || results.length !== 2) {
        throw new Error('pipeline returned no results');
      }
      const [getErr, buf] = results[0] as [Error | null, Buffer | null];
      if (getErr) throw getErr;
      if (buf === null) return null;
      const [ttlErr, ttl] = results[1] as [Error | null, number];
      const ttlSeconds = !ttlErr && typeof ttl === 'number' && ttl > 0 ? ttl : null;
      return { value: new Uint8Array(buf), ttlSeconds };
    } catch (error) {
      throw this.wrapError('get', error);
    }
  }

  async set(key: string, value: Uint8Array, ttl?: number): Promise<void> {
    this.ensureNotClosed();

    const effectiveTtl = ttl ?? this.config.defaultTtl;

    try {
      if (effectiveTtl > 0) {
        await this.client.setex(key, effectiveTtl, Buffer.from(value));
      } else {
        await this.client.set(key, Buffer.from(value));
      }
    } catch (error) {
      throw this.wrapError('set', error);
    }
  }

  async delete(key: string): Promise<boolean> {
    this.ensureNotClosed();

    try {
      const result = await this.client.del(key);
      return result > 0;
    } catch (error) {
      throw this.wrapError('delete', error);
    }
  }

  async exists(key: string): Promise<boolean> {
    this.ensureNotClosed();

    try {
      const result = await this.client.exists(key);
      return result > 0;
    } catch (error) {
      throw this.wrapError('exists', error);
    }
  }

  /** See {@link TTLBackend.getTTL}: -2 (missing) / -1 (no expiry) → null. */
  async getTTL(key: string): Promise<number | null> {
    this.ensureNotClosed();

    try {
      const ttl = await this.client.ttl(key);
      return ttl > 0 ? ttl : null;
    } catch (error) {
      throw this.wrapError('getTTL', error);
    }
  }

  /** Reset the key's TTL. Returns false when the key doesn't exist. */
  async refreshTTL(key: string, ttl: number): Promise<boolean> {
    this.ensureNotClosed();

    // EXPIRE with a non-positive TTL DELETES the key and still returns 1 —
    // reporting "refreshed" while silently destroying the data. Reject loudly
    // instead (the SaaS backend's PATCH /ttl rejects ttl <= 0 the same way).
    const seconds = Math.floor(ttl);
    if (seconds <= 0) {
      throw new BackendError(`Redis refreshTTL requires ttl >= 1 second, got ${ttl}`);
    }

    try {
      const result = await this.client.expire(key, seconds);
      return result === 1;
    } catch (error) {
      throw this.wrapError('refreshTTL', error);
    }
  }

  /**
   * See {@link LockableBackend.acquireLock} for the contract. On Redis the
   * lease is a `SET NX PX` under the derived lock key (see {@link lockKey}),
   * mirroring cachekit-py's Redis provider so py and ts workloads contend on
   * the same lock.
   */
  async acquireLock(key: string, timeoutMs = 5000): Promise<string | null> {
    this.ensureNotClosed();

    // PX requires a positive integer — floats/zero make Redis reject the SET.
    const px = Math.floor(timeoutMs);
    if (px <= 0) {
      throw new BackendError(`Redis acquireLock requires timeoutMs >= 1, got ${timeoutMs}`);
    }

    const lockId = randomUUID();
    try {
      const result = await this.client.set(this.lockKey(key), lockId, 'PX', px, 'NX');
      return result === 'OK' ? lockId : null;
    } catch (error) {
      throw this.wrapError('acquireLock', error);
    }
  }

  /**
   * See {@link LockableBackend.releaseLock}: atomic Lua compare-and-delete.
   */
  async releaseLock(key: string, lockId: string): Promise<boolean> {
    this.ensureNotClosed();

    try {
      const result = await this.client.eval(RELEASE_LOCK_SCRIPT, 1, this.lockKey(key), lockId);
      return result === 1;
    } catch (error) {
      throw this.wrapError('releaseLock', error);
    }
  }

  /**
   * Bare-cache-key contract (cachekit-py#135 / cachekit-ts#70): lock methods
   * receive the same key as get/set/delete; the `:lock` suffix is a
   * Redis-backend wire detail, kept identical to py's `<scoped_key>:lock`
   * for zero-migration compatibility. It never enters the data keyspace or
   * the canonical cache-key format.
   */
  private lockKey(key: string): string {
    return `${key}:lock`;
  }

  async close(): Promise<void> {
    if (this.closed) return;

    this.closed = true;
    await this.client.quit();
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new BackendError('Redis backend is closed');
    }
  }

  private wrapError(operation: string, error: unknown): Error {
    if (error instanceof Error) {
      if (error.message.includes('ETIMEDOUT') || error.message.includes('timeout')) {
        return new TimeoutError(`Redis ${operation} timed out: ${error.message}`, { cause: error });
      }
      return new BackendError(`Redis ${operation} failed: ${error.message}`, 'transient', {
        cause: error,
      });
    }
    return new BackendError(`Redis ${operation} failed: Unknown error`);
  }
}

/**
 * Factory function to create a Redis backend.
 *
 * @param config - Redis connection configuration
 * @returns Configured Redis backend
 *
 * @example
 * ```typescript
 * import { redis } from '@cachekit-io/cachekit';
 *
 * const backend = redis({
 *   url: 'redis://localhost:6379',
 *   defaultTtl: 3600,
 *   keyPrefix: 'myapp:',
 * });
 * ```
 */
export function redis(config: RedisBackendConfig): LockableBackend & TTLBackend {
  return new RedisBackend(config);
}

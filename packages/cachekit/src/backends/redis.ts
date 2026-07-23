import { randomUUID } from 'node:crypto';
import { Redis as IoRedis, type RedisOptions } from 'ioredis';
import { LockableBackend, RedisBackendConfig, TTLBackend } from './types.js';
import { BackendError, TimeoutError } from '../errors.js';
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
      // eslint-disable-next-line no-console -- Library intentionally uses console for error visibility
      console.error(`[cachekit] Redis error: ${safeMessage}`);
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

  /**
   * Remaining TTL in seconds, or null when the key is missing or has no
   * expiry — the same collapse cachekit-py's Redis provider applies to
   * Redis's -2 (missing) / -1 (no expiry) sentinels.
   */
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

    try {
      const result = await this.client.expire(key, ttl);
      return result === 1;
    } catch (error) {
      throw this.wrapError('refreshTTL', error);
    }
  }

  /**
   * Acquire a distributed lock, or null when another client holds it
   * (contested — never blocks or retries, matching the LAB-240 contract).
   *
   * Takes the BARE cache key: the `:lock` namespace is derived on the wire
   * by this backend (`<key>:lock`, after ioredis applies keyPrefix), exactly
   * mirroring cachekit-py's Redis provider so py and ts workloads contend on
   * the same lock. Callers MUST NOT pre-suffix the key.
   *
   * @param timeoutMs - How long the lock is held before auto-release (lease
   *   TTL, `SET PX`). Best-effort stampede mitigation, not mutual-exclusion
   *   correctness: a holder that outlives the lease loses exclusivity.
   */
  async acquireLock(key: string, timeoutMs = 5000): Promise<string | null> {
    this.ensureNotClosed();

    const lockId = randomUUID();
    try {
      const result = await this.client.set(this.lockKey(key), lockId, 'PX', timeoutMs, 'NX');
      return result === 'OK' ? lockId : null;
    } catch (error) {
      throw this.wrapError('acquireLock', error);
    }
  }

  /**
   * Release a lock previously acquired with {@link acquireLock}. Atomic
   * compare-and-delete: returns false (and deletes nothing) when the lock
   * expired or is held by someone else — never releases another holder's lock.
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

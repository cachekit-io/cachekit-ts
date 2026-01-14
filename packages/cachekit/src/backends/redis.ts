import { Redis as IoRedis, type RedisOptions } from 'ioredis';
import { Backend, RedisBackendConfig } from './types.js';
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
 * Redis backend implementation using ioredis.
 *
 * Features:
 * - Connection pooling (handled by ioredis)
 * - Auto-reconnect with exponential backoff
 * - TLS support
 * - Key prefixing
 *
 * @example
 * ```typescript
 * const backend = redis({ url: 'redis://localhost:6379' });
 * await backend.set('key', Buffer.from('value'), 3600);
 * const value = await backend.get('key');
 * await backend.close();
 * ```
 */
export class RedisBackend implements Backend {
  private readonly client: IoRedis;
  private readonly config: Required<RedisBackendConfig>;
  private closed = false;

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
        const delay = Math.min(REDIS_RETRY_BASE_DELAY * Math.pow(2, times - 1), REDIS_RETRY_MAX_DELAY);
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
      return new BackendError(`Redis ${operation} failed: ${error.message}`, { cause: error });
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
export function redis(config: RedisBackendConfig): Backend {
  return new RedisBackend(config);
}

import type {
  CacheOptions,
  SetOptions,
  WrapOptions,
  SecureCache,
  InvalidationConfig,
} from './types/cache.js';
import type { Backend, RedisBackendConfig, CachekitIOBackendConfig } from './backends/types.js';
import { redis } from './backends/redis.js';
import { cachekitio } from './backends/cachekitio-factory.js';
import { L1Cache } from './l1/lru-cache.js';
import { ReliabilityExecutor } from './reliability/executor.js';
import { BackgroundRefreshManager } from './cache/background-refresh.js';
import { MessagePackSerializer } from './serialization/serializer.js';
import {
  generateKey,
  generateParamsHash,
  extractNamespace,
} from './serialization/key-generator.js';
import {
  generateInteropKey,
  validateInteropSegment,
  encodeInteropValue,
  decodeInteropValue,
} from './serialization/interop.js';
import { EncryptionManager } from './encryption/manager.js';
import { ByteStorage } from '@cachekit-io/cachekit-core-ts';
import { RedisInvalidationChannel } from './invalidation/redis-channel.js';
import { createInvalidationEvent } from './invalidation/event.js';
import { BackendError, ConfigurationError } from './errors.js';
import { DEFAULT_TTL_SECONDS } from './constants.js';

/**
 * Internal cache implementation.
 */
class CacheImpl implements SecureCache {
  private readonly backend: Backend;
  private readonly l1: L1Cache | null;
  private readonly reliabilityExecutor: ReliabilityExecutor;
  private readonly backgroundRefresh: BackgroundRefreshManager;
  private readonly encryption: EncryptionManager | null;
  private readonly byteStorage: ByteStorage | null;
  private readonly serializer: MessagePackSerializer;
  private readonly defaultTtl: number;
  private readonly invalidationChannel: RedisInvalidationChannel | null = null;
  private closed = false;

  constructor(options: CacheOptions) {
    // Initialize backend
    if ('get' in options.backend) {
      this.backend = options.backend;
    } else if ('apiKey' in options.backend) {
      this.backend = cachekitio(options.backend as CachekitIOBackendConfig);
    } else {
      this.backend = redis(options.backend as RedisBackendConfig);
    }

    // Initialize L1 cache
    if (options.l1?.enabled !== false) {
      this.l1 = new L1Cache(options.l1);
    } else {
      this.l1 = null;
    }

    // Initialize reliability executor (composes circuit breaker + retry + degradation)
    this.reliabilityExecutor = new ReliabilityExecutor({
      circuitBreaker: options.reliability?.circuitBreaker,
      retry: options.reliability?.retry,
      degradation: options.reliability?.degradation,
    });

    // Initialize background refresh manager (SWR)
    this.backgroundRefresh = new BackgroundRefreshManager();

    // Initialize encryption
    this.encryption = options.encryption
      ? new EncryptionManager(options.encryption.masterKey, options.encryption.tenantId)
      : null;

    // Initialize ByteStorage (LZ4 compression + xxHash3-64 integrity)
    this.byteStorage = (options.compression ?? true) ? new ByteStorage() : null;

    // Initialize serializer
    this.serializer = new MessagePackSerializer(options.serializer);

    // Default TTL
    this.defaultTtl = options.defaultTtl ?? DEFAULT_TTL_SECONDS;

    // m1 Fix: Initialize invalidation channel if config provided
    if (options.invalidation) {
      this.invalidationChannel = this.initializeInvalidationChannel(options.invalidation);
    }
  }

  /**
   * Initialize the invalidation channel and wire up L1 cache subscription.
   */
  private initializeInvalidationChannel(config: InvalidationConfig): RedisInvalidationChannel {
    const channel = new RedisInvalidationChannel(config.redis, {
      channelName: config.channelName,
    });

    // Subscribe L1 cache to invalidation events if L1 is enabled
    if (this.l1) {
      channel.subscribe((event) => {
        this.l1?.handleInvalidationEvent(event);
      });
    }

    // Start the channel (fire-and-forget, channel handles errors internally)
    channel.start().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[cachekit] Failed to start invalidation channel:', err);
    });

    return channel;
  }

  async get<T>(key: string): Promise<T | null> {
    return this.getEntry(key, false);
  }

  /**
   * L1 + L2 read. Interop entries (interop=true) are plain MessagePack —
   * no ByteStorage envelope and AAD compressed=False — regardless of the
   * cache-level `compression` option. `ttlSeconds` (when known, i.e. from
   * wrap()) bounds the L1 repopulation lifetime so an entry never outlives
   * its declared TTL in L1 long after L2 and the other SDKs expired it.
   */
  private async getEntry<T>(key: string, interop: boolean, ttlSeconds?: number): Promise<T | null> {
    this.ensureNotClosed();

    // Check L1 first
    if (this.l1) {
      const l1Result = this.l1.get(key);
      if (l1Result !== null) {
        return l1Result as T;
      }
    }

    const useEnvelope = !interop && this.byteStorage !== null;

    // Fetch from L2 (backend)
    const operation = async (): Promise<T | null> => {
      const data = await this.backend.get(key);
      if (data === null) return null;

      // Decrypt if encryption enabled
      let plaintext = data;
      if (this.encryption) {
        plaintext = await this.encryption.decrypt(data, key, useEnvelope);
      }

      // Decompress with ByteStorage (after decryption)
      if (useEnvelope) {
        plaintext = this.byteStorage!.unpack(plaintext);
      }

      // Deserialize
      const value = interop
        ? decodeInteropValue<T>(plaintext)
        : this.serializer.decode<T>(plaintext);

      // Populate L1. Interop keys are {namespace}:{operation}:{hash} — group
      // under the user-facing namespace segment so namespace-level
      // invalidation matches entries written through wrap().
      if (this.l1) {
        const namespace = interop ? key.slice(0, key.indexOf(':')) : extractNamespace(key);
        this.l1.set(key, value, (ttlSeconds ?? this.defaultTtl) * 1000, namespace);
      }

      return value;
    };

    return this.reliabilityExecutor.execute(operation, null);
  }

  async set<T>(key: string, value: T, options?: SetOptions): Promise<void> {
    return this.setEntry(key, value, options, false);
  }

  /**
   * L1 + L2 write. Interop entries (interop=true) serialize to canonical
   * plain MessagePack — never the ByteStorage envelope — and encrypt with
   * AAD compressed=False, matching the Python and Rust SDKs byte-for-byte.
   */
  private async setEntry<T>(
    key: string,
    value: T,
    options: SetOptions | undefined,
    interop: boolean
  ): Promise<void> {
    this.ensureNotClosed();

    const ttl = options?.ttl ?? this.defaultTtl;

    // Validate TTL
    if (!Number.isFinite(ttl) || ttl < 0) {
      throw new ConfigurationError(`Invalid TTL: ${ttl}. Must be a non-negative finite number.`);
    }

    const namespace = options?.namespace ?? extractNamespace(key);
    const useEnvelope = !interop && this.byteStorage !== null;

    // Interop model rejection is a deterministic caller error (spec: values
    // outside the data model MUST error) — it surfaces synchronously and
    // never reaches the reliability executor, where degradation would
    // silently swallow it and retry/circuit-breaker would count it as a
    // backend failure. Auto-mode encoding stays inside the executor
    // (existing degrade semantics unchanged).
    const interopSerialized = interop ? encodeInteropValue(value) : null;

    const operation = async (): Promise<void> => {
      // Serialize
      const serialized = interopSerialized ?? this.serializer.encode(value);

      // Compress with ByteStorage (before encryption)
      let data: Uint8Array = useEnvelope ? this.byteStorage!.pack(serialized) : serialized;

      // Encrypt if encryption enabled
      if (this.encryption) {
        data = await this.encryption.encrypt(data, key, useEnvelope);
      }

      // Store in backend
      await this.backend.set(key, data, ttl);

      // Update L1
      if (this.l1) {
        this.l1.set(key, value, ttl * 1000, namespace);
      }
    };

    await this.reliabilityExecutor.execute(operation, undefined);
  }

  async delete(key: string): Promise<boolean> {
    this.ensureNotClosed();

    const operation = async (): Promise<boolean> => {
      // Delete from backend
      const deleted = await this.backend.delete(key);

      // Invalidate L1
      if (this.l1) {
        this.l1.invalidateByKey(key);
      }

      return deleted;
    };

    return this.reliabilityExecutor.execute(operation, false);
  }

  async exists(key: string): Promise<boolean> {
    this.ensureNotClosed();

    // Check L1 first
    if (this.l1) {
      const l1Value = this.l1.get(key);
      if (l1Value !== null) {
        return true;
      }
    }

    return this.reliabilityExecutor.execute(() => this.backend.exists(key), false);
  }

  wrap<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    options: WrapOptions
  ): (...args: TArgs) => Promise<TResult> {
    const interopOperation = options.interop;
    const interop = interopOperation !== undefined;
    if (interop) {
      // Spec: reject non-conforming segments at registration time — never
      // silently normalize, never defer to the first call.
      validateInteropSegment('namespace', options.namespace);
      validateInteropSegment('operation', interopOperation);
    }

    return async (...args: TArgs): Promise<TResult> => {
      // Interop arity contract: the flat argument array must match the
      // declared parameter list exactly — the other SDKs bind named args and
      // apply defaults, which JS cannot introspect. A short call (relying on
      // a default), an extra arg, or a rest-parameter function would hash a
      // different array than Python/Rust and silently miss cross-SDK.
      // fn.length also drops to the first default/rest parameter, so this
      // check surfaces the "no default parameters" rule at first call.
      if (interop && args.length !== fn.length) {
        throw new ConfigurationError(
          `Interop operation "${interopOperation}" called with ${args.length} argument(s) but ` +
            `the wrapped function declares ${fn.length} — interop functions must not use ` +
            'default, optional, or rest parameters, and callers must pass the full declared arity'
        );
      }
      const cacheKey = interop
        ? generateInteropKey(options.namespace, interopOperation, args)
        : generateKey(options.namespace, args);

      // Check L1 with SWR
      if (this.l1 && !options.skipL1) {
        const swrResult = this.l1.getWithSwr(cacheKey);

        if (swrResult.value !== null) {
          // Trigger background refresh if needed
          if (swrResult.shouldRefresh) {
            this.backgroundRefresh.scheduleRefresh(
              cacheKey,
              () => fn(...args),
              { ttl: options.ttl, namespace: options.namespace },
              swrResult.versionToken,
              this.l1,
              async (key, value, opts) => {
                await this.setEntry(key, value, { ttl: opts.ttl, namespace: opts.namespace }, interop);
              }
            );
          }
          return swrResult.value as TResult;
        }
      }

      // Check L2
      const cached = await this.getEntry<TResult>(cacheKey, interop, options.ttl);
      if (cached !== null) {
        return cached;
      }

      // Compute and cache
      const result = await fn(...args);
      await this.setEntry(cacheKey, result, { ttl: options.ttl, namespace: options.namespace }, interop);

      return result;
    };
  }

  with(
    options: WrapOptions
  ): <TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>
  ) => (...args: TArgs) => Promise<TResult> {
    return <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>) =>
      this.wrap(fn, options);
  }

  secure = {
    wrap: <TArgs extends unknown[], TResult>(
      fn: (...args: TArgs) => Promise<TResult>,
      options: WrapOptions
    ): ((...args: TArgs) => Promise<TResult>) => {
      return this.wrap(fn, options);
    },
  };

  async invalidate(
    level: 'global' | 'namespace' | 'params',
    options?: { namespace?: string; key?: string }
  ): Promise<void> {
    this.ensureNotClosed();

    // Invalidate L1
    if (this.l1) {
      switch (level) {
        case 'global':
          this.l1.invalidateAll();
          break;
        case 'namespace':
          if (options?.namespace) {
            this.l1.invalidateByNamespace(options.namespace);
          }
          break;
        case 'params':
          if (options?.key) {
            this.l1.invalidateByKey(options.key);
          }
          break;
      }
    }

    // Invalidate L2 for params-level (key deletion)
    if (level === 'params' && options?.key) {
      try {
        await this.backend.delete(options.key);
      } catch {
        // Best-effort L2 invalidation - don't fail the operation
      }
    }
    // Note: namespace/global L2 invalidation requires Redis SCAN - not implemented

    // Publish to other instances if invalidation channel available
    if (this.invalidationChannel) {
      const event = createInvalidationEvent(level, this.l1?.instanceID ?? 'unknown', {
        namespace: options?.namespace,
        paramsHash: options?.key ? generateParamsHash([options.key]) : undefined,
      });
      this.invalidationChannel.publish(event);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Stop background refresh manager (clears in-flight refreshes)
    this.backgroundRefresh.close();

    // Stop invalidation channel
    if (this.invalidationChannel) {
      await this.invalidationChannel.stop();
    }

    // Dispose encryption
    if (this.encryption) {
      this.encryption.dispose();
    }

    // Clear L1 (this also clears L1's internal refreshingKeys)
    if (this.l1) {
      this.l1.clear();
    }

    // Close backend
    await this.backend.close();
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new BackendError('Cache has been closed');
    }
  }
}

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
  return new CacheImpl(options);
}

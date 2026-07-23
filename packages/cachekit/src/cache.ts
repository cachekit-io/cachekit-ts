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
import { logError } from './logger.js';
import { createMetrics, type MetricsCollector } from './metrics/prometheus.js';
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
  private readonly metrics: MetricsCollector;
  // Live hit/miss counters. Feed both the Prometheus collector and the SaaS
  // X-CacheKit-L1-* telemetry headers (auto-wired metricsProvider below).
  private readonly telemetry = { l1Hits: 0, l2Hits: 0, misses: 0 };
  private closed = false;

  constructor(options: CacheOptions) {
    // Initialize backend
    if ('get' in options.backend) {
      this.backend = options.backend;
    } else if ('apiKey' in options.backend) {
      const ioConfig = options.backend as CachekitIOBackendConfig;
      this.backend = cachekitio({
        ...ioConfig,
        // Auto-wire the SaaS telemetry headers from the cache's live hit/miss
        // counters; an explicit user-supplied provider still wins. Reads
        // `this` lazily (per request), so constructor field order is safe.
        metricsProvider:
          ioConfig.metricsProvider ??
          ((): import('./backends/types.js').L1Metrics => ({
            ...this.telemetry,
            l1Enabled: this.l1 !== null,
          })),
      });
    } else {
      this.backend = redis(options.backend as RedisBackendConfig);
    }

    // Initialize metrics (Prometheus via optional prom-client peer dependency)
    const metricsOption = options.metrics ?? false;
    this.metrics = createMetrics(
      metricsOption !== false,
      typeof metricsOption === 'object' ? metricsOption : undefined
    );

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
      logError('[cachekit] Failed to start invalidation channel:', err);
    });

    return channel;
  }

  // ── Metrics recording ─────────────────────────────────────
  // MetricsCollector methods never reject (errors route to its handler), so
  // fire-and-forget `void` keeps them off the hot path.

  private recordHit(layer: 'l1' | 'l2'): void {
    if (layer === 'l1') this.telemetry.l1Hits++;
    else this.telemetry.l2Hits++;
    void this.metrics.recordHit(layer);
  }

  private recordMiss(): void {
    this.telemetry.misses++;
    void this.metrics.recordMiss();
  }

  private recordFailure(operation: string, error: unknown): void {
    void this.metrics.recordOperation(operation, 'error');
    void this.metrics.recordError(error instanceof Error ? error.constructor.name : 'Unknown');
  }

  private publishL1Stats(): void {
    if (!this.l1) return;
    const stats = this.l1.stats;
    void this.metrics.updateL1Stats(stats.entries, stats.memoryUsed);
  }

  /**
   * Run an operation through the reliability stack, then publish the
   * circuit-breaker state gauge (state transitions happen inside execute).
   */
  private async execute<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await this.reliabilityExecutor.execute(operation, fallback);
    } finally {
      const state = this.reliabilityExecutor.getCircuitBreakerState();
      if (state !== null) void this.metrics.updateCircuitBreakerState(state);
    }
  }

  /**
   * Instrument one backend attempt: duration histogram + operations counter
   * by status + errors counter. Wraps the operation closure (inside retry),
   * so each retry attempt counts as one operation — the honest reading of
   * `operations_total`.
   */
  private async instrument<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const endTimer = await this.metrics.startTimer(operation);
    try {
      const result = await fn();
      void this.metrics.recordOperation(operation, 'success');
      return result;
    } catch (error) {
      this.recordFailure(operation, error);
      throw error;
    } finally {
      endTimer();
    }
  }

  /**
   * Route a backend op through instrumentation (timer + op/error counters,
   * inside retry so each attempt counts once) and the reliability stack
   * (retry + circuit breaker, publishing the CB gauge). Every public op goes
   * through here so none can silently drift out of the metrics set.
   */
  private run<T>(operation: string, fallback: T, fn: () => Promise<T>): Promise<T> {
    return this.execute(() => this.instrument(operation, fn), fallback);
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
        this.recordHit('l1');
        return l1Result as T;
      }
    }

    const useEnvelope = !interop && this.byteStorage !== null;

    // Fetch from L2 (backend)
    return this.run('get', null, async (): Promise<T | null> => {
      const data = await this.backend.get(key);
      if (data === null) {
        this.recordMiss();
        return null;
      }

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
        this.publishL1Stats();
      }

      this.recordHit('l2');
      return value;
    });
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

    return this.run('set', undefined, async (): Promise<void> => {
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
        this.publishL1Stats();
      }
    });
  }

  async delete(key: string): Promise<boolean> {
    this.ensureNotClosed();

    return this.run('delete', false, async (): Promise<boolean> => {
      // Delete from backend
      const deleted = await this.backend.delete(key);

      // Invalidate L1
      if (this.l1) {
        this.l1.invalidateByKey(key);
        this.publishL1Stats();
      }

      return deleted;
    });
  }

  async exists(key: string): Promise<boolean> {
    this.ensureNotClosed();

    // Check L1 first
    if (this.l1) {
      const l1Value = this.l1.get(key);
      if (l1Value !== null) {
        this.recordHit('l1');
        return true;
      }
    }

    return this.run('exists', false, () => this.backend.exists(key));
  }

  wrap<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    options: WrapOptions
  ): (...args: TArgs) => Promise<TResult> {
    const interopOperation = options.interop;
    const interop = interopOperation !== undefined;
    const interopArity = options.interopArity;
    if (!interop && interopArity !== undefined) {
      // A declared contract arity with no operation name means the interop
      // opt-in was dropped (typo, refactor) — auto-mode keys would silently
      // miss every cross-SDK entry, so refuse rather than ignore.
      throw new ConfigurationError(
        'interopArity was set without interop — declare the operation name (interop: "...") ' +
          'or remove interopArity'
      );
    }
    if (interop) {
      // Spec: reject non-conforming segments at registration time — never
      // silently normalize, never defer to the first call.
      validateInteropSegment('namespace', options.namespace);
      validateInteropSegment('operation', interopOperation);

      // Fail closed on key-transforming backends. An interop key must reach
      // the store byte-identical to the other SDKs' bare
      // {namespace}:{operation}:{hash}; a backend prefix (e.g. Redis
      // keyPrefix) would make TypeScript read and write the prefixed key —
      // every cross-SDK access silently misses, and the encryption AAD stays
      // bound to the un-prefixed key while the ciphertext lives elsewhere.
      // Silently dropping the prefix instead would split the prefix policy
      // on one connection (auto-mode keys isolated, interop keys escaping) —
      // worse than refusing.
      const backendKeyPrefix = this.backend.keyPrefix;
      if (backendKeyPrefix) {
        throw new ConfigurationError(
          `Interop operation "${interopOperation}" cannot run on a backend with a key prefix ` +
            `(${JSON.stringify(backendKeyPrefix)}). Put interop caches on a separate unprefixed ` +
            'client, or drop the keyPrefix.'
        );
      }

      // The cross-SDK arity contract is declared explicitly (fn.length stops
      // at the first default/rest parameter, so it cannot be trusted to
      // carry the contract). A mismatch here means default/optional/rest
      // parameters — which Python binds but JS cannot introspect — or a
      // wrapper that erased the parameter list.
      if (interopArity === undefined) {
        throw new ConfigurationError(
          `Interop operation "${interopOperation}" requires interopArity: the exact argument ` +
            'count of the cross-SDK contract'
        );
      }
      if (!Number.isInteger(interopArity) || interopArity < 0) {
        throw new ConfigurationError(
          `Interop operation "${interopOperation}": interopArity must be a non-negative ` +
            `integer, got ${interopArity}`
        );
      }
      if (fn.length !== interopArity) {
        throw new ConfigurationError(
          `Interop operation "${interopOperation}" declares interopArity ${interopArity} but the ` +
            `wrapped function's parameter list reports ${fn.length} — remove default, optional, ` +
            'and rest parameters (Python binds defaults into the hash; JS cannot see them), or ' +
            'declare the parameters explicitly if a wrapper erased them'
        );
      }
    }

    return async (...args: TArgs): Promise<TResult> => {
      // Interop arity contract, call side: the flat argument array must
      // match the declared contract exactly — a short or long call would
      // hash a different array than Python/Rust bind and silently miss
      // cross-SDK.
      if (interop && args.length !== interopArity) {
        throw new ConfigurationError(
          `Interop operation "${interopOperation}" called with ${args.length} argument(s) but ` +
            `declares interopArity ${interopArity} — callers must pass the full declared arity`
        );
      }
      // Re-check the prefix per call: the wrap-time check is a snapshot, and
      // a backend whose keyPrefix getter is request-scoped (e.g. an
      // AsyncLocalStorage tenant router) could report '' at registration and
      // prefix at runtime — reopening the exact fail-open this guard closes.
      // The Backend contract requires a construction-time-constant value; a
      // backend that violates it still fails closed here.
      if (interop && this.backend.keyPrefix) {
        throw new ConfigurationError(
          `Interop operation "${interopOperation}" cannot run on a backend with a key prefix ` +
            `(${JSON.stringify(this.backend.keyPrefix)}) — see Backend.keyPrefix`
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
                await this.setEntry(
                  key,
                  value,
                  { ttl: opts.ttl, namespace: opts.namespace },
                  interop
                );
              }
            );
          }
          this.recordHit('l1');
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
      await this.setEntry(
        cacheKey,
        result,
        { ttl: options.ttl, namespace: options.namespace },
        interop
      );

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
      this.publishL1Stats();
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

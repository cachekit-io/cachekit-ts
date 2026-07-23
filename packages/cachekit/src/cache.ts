import type {
  CacheOptions,
  SetOptions,
  StampedeConfig,
  WrapOptions,
  WrapOptionsBase,
  SecureCache,
  InvalidationConfig,
} from './types/cache.js';
import type {
  Backend,
  LockableBackend,
  RedisBackendConfig,
  CachekitIOBackendConfig,
} from './backends/types.js';
import { redis } from './backends/redis.js';
import { cachekitio, cachekitioWithLocking } from './backends/cachekitio-factory.js';
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
import {
  DEFAULT_TTL_SECONDS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_WAIT_MS,
  DEFAULT_LOCK_POLL_MS,
} from './constants.js';

/**
 * Sentinel for "the lock path did not resolve the miss — compute without
 * it". Distinct from null: the wrapped function may legitimately resolve
 * null, and conflating the two would compute twice under a held lock.
 */
const LOCK_FALLTHROUGH = Symbol('cachekit.lock-fallthrough');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  /** One in-flight cold-miss resolution per cache key (single-flight, LAB-519). */
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly stampede: Required<StampedeConfig>;
  private readonly lockable: LockableBackend | null;

  constructor(options: CacheOptions) {
    // Initialize backend
    if ('get' in options.backend) {
      this.backend = options.backend;
    } else if ('apiKey' in options.backend) {
      // The plain SaaS factory has no lock capability; the distributedLock
      // opt-in selects the lockable wrapper so config-based users aren't
      // forced to construct the backend by hand.
      this.backend = options.stampede?.distributedLock
        ? cachekitioWithLocking(options.backend as CachekitIOBackendConfig)
        : cachekitio(options.backend as CachekitIOBackendConfig);
    } else {
      this.backend = redis(options.backend as RedisBackendConfig);
    }

    // Stampede config + lock capability. Duck-typed like cachekit-py's
    // hasattr check: user-supplied Backend instances aren't required to
    // declare the LockableBackend interface, only to implement it.
    this.stampede = {
      distributedLock: options.stampede?.distributedLock ?? false,
      lockTimeoutMs: options.stampede?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      lockWaitMs: options.stampede?.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
      lockPollMs: options.stampede?.lockPollMs ?? DEFAULT_LOCK_POLL_MS,
    };
    if (!Number.isFinite(this.stampede.lockTimeoutMs) || this.stampede.lockTimeoutMs <= 0) {
      throw new ConfigurationError(
        `stampede.lockTimeoutMs must be > 0, got ${this.stampede.lockTimeoutMs}`
      );
    }
    if (!Number.isFinite(this.stampede.lockPollMs) || this.stampede.lockPollMs <= 0) {
      throw new ConfigurationError(
        `stampede.lockPollMs must be > 0, got ${this.stampede.lockPollMs}`
      );
    }
    if (!Number.isFinite(this.stampede.lockWaitMs) || this.stampede.lockWaitMs < 0) {
      throw new ConfigurationError(
        `stampede.lockWaitMs must be >= 0, got ${this.stampede.lockWaitMs}`
      );
    }
    const maybeLockable = this.backend as Partial<LockableBackend>;
    this.lockable =
      typeof maybeLockable.acquireLock === 'function' &&
      typeof maybeLockable.releaseLock === 'function'
        ? (this.backend as LockableBackend)
        : null;
    if (this.stampede.distributedLock && !this.lockable) {
      throw new ConfigurationError(
        'stampede.distributedLock requires a backend with lock capability ' +
          '(Redis, cachekitioWithLocking, or cachekitioFull) — the configured backend ' +
          'has no acquireLock/releaseLock'
      );
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
          return swrResult.value as TResult;
        }
      }

      // Cold path (L1 miss): single-flight per key per process. The flight
      // covers the L2 read too, not just the compute — the L2 GET-miss is
      // the billed event under metered-misses, so N concurrent cold callers
      // must share one read, one compute, and one write (LAB-519).
      const existing = this.inflight.get(cacheKey);
      if (existing) {
        return existing as Promise<TResult>;
      }
      const flight = this.resolveMiss<TResult>(cacheKey, interop, () => fn(...args), options);
      this.inflight.set(cacheKey, flight);
      try {
        return await flight;
      } finally {
        this.inflight.delete(cacheKey);
      }
    };
  }

  /**
   * Cold-path resolution shared by every concurrent caller of one key:
   * L2 read, then compute + write, optionally bracketed by a distributed
   * lock when the backend supports it and stampede.distributedLock is on.
   */
  private async resolveMiss<TResult>(
    cacheKey: string,
    interop: boolean,
    compute: () => Promise<TResult>,
    options: WrapOptionsBase
  ): Promise<TResult> {
    const cached = await this.getEntry<TResult>(cacheKey, interop, options.ttl);
    if (cached !== null) {
      return cached;
    }

    if (this.lockable && this.stampede.distributedLock) {
      const locked = await this.resolveUnderLock<TResult>(cacheKey, interop, compute, options);
      if (locked !== LOCK_FALLTHROUGH) {
        return locked;
      }
    }

    return this.computeAndStore(cacheKey, interop, compute, options);
  }

  /**
   * Cross-process miss arbitration, mirroring cachekit-py's acquire_lock
   * flow (wrapper.py): acquire → double-check L2 → compute → write →
   * release. acquireLock never blocks on contention (LAB-240), so
   * "waiting" is retrying the lock on an interval bounded by lockWaitMs —
   * deliberately NOT polling get(), because on a metered-misses backend
   * every poll GET against a still-cold key is itself a billed miss,
   * while contested lock calls are not.
   *
   * Returns LOCK_FALLTHROUGH when the lock never resolved the miss
   * (acquire error, or contested past the wait budget): the lease is
   * best-effort stampede mitigation, never a correctness gate, so lock
   * failure degrades to computing without it.
   */
  private async resolveUnderLock<TResult>(
    cacheKey: string,
    interop: boolean,
    compute: () => Promise<TResult>,
    options: WrapOptionsBase
  ): Promise<TResult | typeof LOCK_FALLTHROUGH> {
    const lockable = this.lockable!;
    const { lockTimeoutMs, lockWaitMs, lockPollMs } = this.stampede;
    const deadline = Date.now() + lockWaitMs;

    for (;;) {
      let lockId: string | null;
      try {
        // Deliberately outside the reliability executor: retry would stack
        // latency onto a best-effort call, and counting lock failures
        // against the circuit breaker could open it for data operations.
        lockId = await lockable.acquireLock(cacheKey, lockTimeoutMs);
      } catch {
        return LOCK_FALLTHROUGH;
      }

      if (lockId !== null) {
        try {
          // Double-check: the holder we waited on (or a racing process)
          // may have written between our miss and this grant — one GET
          // that hits, instead of a duplicate compute + write.
          const filled = await this.getEntry<TResult>(cacheKey, interop, options.ttl);
          if (filled !== null) {
            return filled;
          }
          return await this.computeAndStore(cacheKey, interop, compute, options);
        } finally {
          // Best-effort: the lease auto-expires, and a failed release must
          // not mask the compute result.
          lockable.releaseLock(cacheKey, lockId).catch(() => {});
        }
      }

      if (Date.now() + lockPollMs > deadline) {
        return LOCK_FALLTHROUGH;
      }
      await sleep(lockPollMs);
    }
  }

  private async computeAndStore<TResult>(
    cacheKey: string,
    interop: boolean,
    compute: () => Promise<TResult>,
    options: WrapOptionsBase
  ): Promise<TResult> {
    const result = await compute();
    await this.setEntry(
      cacheKey,
      result,
      { ttl: options.ttl, namespace: options.namespace },
      interop
    );
    return result;
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

    // Drop single-flight registrations (in-flight promises settle on their
    // own; callers already awaiting them get the result or a closed-backend
    // error)
    this.inflight.clear();

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

import type {
  CacheOptions,
  SetOptions,
  WrapOptions,
  SecureCache,
  EncryptionConfig,
  InvalidationConfig,
} from './types/cache.js';
import type { Backend } from './backends/types.js';
import type { InvalidationEvent } from './l1/types.js';
import { L1Cache } from './l1/lru-cache.js';
import { ReliabilityExecutor } from './reliability/executor.js';
import { BackgroundRefreshManager, type WaitUntil } from './cache/background-refresh.js';
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
import { createInvalidationEvent } from './invalidation/event.js';
import { BackendError, ConfigurationError } from './errors.js';
import { DEFAULT_TTL_SECONDS } from './constants.js';

/**
 * ByteStorage envelope surface (LZ4 + xxHash3-64 + msgpack envelope).
 * Implemented by the NAPI binding on Node and the wasm binding on Workers —
 * byte-identical output.
 */
export interface ByteStorageLike {
  pack(data: Uint8Array): Uint8Array;
  unpack(packed: Uint8Array): Uint8Array;
  /**
   * Release the codec's native resources (wasm bindings). Optional: the NAPI
   * binding is GC-managed and doesn't expose it. cache.close() calls this —
   * on Workers, FinalizationRegistry callbacks are best-effort ("may never
   * be executed"), so unfreed wasm allocations accumulate in linear memory.
   */
  free?(): void;
}

/** Encryption surface CacheImpl drives (see EncryptionManagerCore). */
export interface EncryptionLike {
  encrypt(data: Uint8Array, cacheKey: string, compressed?: boolean): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, cacheKey: string, compressed?: boolean): Promise<Uint8Array>;
  dispose(): void;
}

/** Cross-instance invalidation channel surface (Redis Pub/Sub on Node). */
export interface InvalidationChannelLike {
  publish(event: InvalidationEvent): void;
  subscribe(callback: (event: InvalidationEvent) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Structural subset of the Workers `ExecutionContext` the cache uses.
 * Structural on purpose: no dependency on @cloudflare/workers-types, and
 * any platform exposing a compatible waitUntil (Vercel Edge, Deno Deploy)
 * satisfies it.
 */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export type { WaitUntil };

/**
 * Platform pieces injected into CacheImpl. Two implementations: Node
 * (cache.ts — Redis + NAPI) and Cloudflare Workers (workers/index.ts —
 * CachekitIO + wasm). Everything protocol-critical stays in CacheImpl.
 */
export interface CacheRuntime {
  /** Resolve a backend config union to a Backend instance. */
  resolveBackend(config: CacheOptions['backend']): Backend;
  /** Create the ByteStorage envelope codec. */
  createByteStorage(): ByteStorageLike;
  /** Create the encryption manager for this platform's bindings. */
  createEncryption(config: EncryptionConfig): EncryptionLike;
  /**
   * Create the cross-instance invalidation channel. Absent on platforms
   * without one (Workers) — configuring `invalidation` there fails fast.
   */
  createInvalidationChannel?(config: InvalidationConfig): InvalidationChannelLike;
  /**
   * When true, SWR background refreshes only schedule through a bound
   * per-request handle (withExecutionContext) — the platform cancels
   * fire-and-forget work at response return (workerd), which would strand
   * the refresh mid-flight and leave its key marked "refreshing". Reads
   * without a handle fall back to plain (no-SWR) L1 gets rather than
   * wedging. Unset on Node, where fire-and-forget is safe.
   */
  swrRequiresWaitUntil?: boolean;
}

/**
 * Internal cache implementation, shared across platform entrypoints.
 */
export class CacheImpl implements SecureCache {
  private readonly backend: Backend;
  private readonly l1: L1Cache | null;
  private readonly reliabilityExecutor: ReliabilityExecutor;
  private readonly backgroundRefresh: BackgroundRefreshManager;
  private readonly encryption: EncryptionLike | null;
  private readonly byteStorage: ByteStorageLike | null;
  private readonly serializer: MessagePackSerializer;
  private readonly defaultTtl: number;
  private readonly invalidationChannel: InvalidationChannelLike | null = null;
  private readonly swrRequiresWaitUntil: boolean;
  private closed = false;

  constructor(options: CacheOptions, runtime: CacheRuntime) {
    // Initialize backend
    this.backend = runtime.resolveBackend(options.backend);

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
    this.swrRequiresWaitUntil = runtime.swrRequiresWaitUntil ?? false;

    // Initialize encryption
    this.encryption = options.encryption ? runtime.createEncryption(options.encryption) : null;

    // Initialize ByteStorage (LZ4 compression + xxHash3-64 integrity)
    this.byteStorage = (options.compression ?? true) ? runtime.createByteStorage() : null;

    // Initialize serializer
    this.serializer = new MessagePackSerializer(options.serializer);

    // Default TTL
    this.defaultTtl = options.defaultTtl ?? DEFAULT_TTL_SECONDS;

    // m1 Fix: Initialize invalidation channel if config provided
    if (options.invalidation) {
      if (!runtime.createInvalidationChannel) {
        throw new ConfigurationError(
          'Cross-instance invalidation is not supported in this runtime ' +
            '(Redis Pub/Sub requires Node — remove the invalidation option)'
        );
      }
      this.invalidationChannel = this.initializeInvalidationChannel(
        options.invalidation,
        runtime.createInvalidationChannel
      );
    }
  }

  /**
   * Initialize the invalidation channel and wire up L1 cache subscription.
   */
  private initializeInvalidationChannel(
    config: InvalidationConfig,
    createChannel: (config: InvalidationConfig) => InvalidationChannelLike
  ): InvalidationChannelLike {
    const channel = createChannel(config);

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

  /**
   * The optional `waitUntil` is not part of the public Cache interface — it
   * is threaded in by withExecutionContext()'s request-scoped view so SWR
   * refreshes triggered by the wrapped function ride the platform's
   * background-work registration instead of firing fire-and-forget.
   */
  wrap<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    options: WrapOptions,
    waitUntil?: WaitUntil
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

      // Check L1 with SWR. On platforms that cancel fire-and-forget work at
      // response return (Workers), SWR only runs when a per-request
      // waitUntil handle is bound — otherwise fall back to a plain L1 read:
      // no refresh marker is taken, so nothing can wedge, and the entry
      // simply expires and recomputes in the request path (fail-safe
      // no-SWR).
      if (this.l1 && !options.skipL1) {
        if (this.swrRequiresWaitUntil && !waitUntil) {
          const l1Value = this.l1.get(cacheKey);
          if (l1Value !== null) {
            return l1Value as TResult;
          }
        } else {
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
                },
                waitUntil
              );
            }
            return swrResult.value as TResult;
          }
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

  /**
   * Bind a request's execution context, returning a request-scoped view of
   * this cache whose SWR background refreshes are registered with the
   * platform (`ctx.waitUntil`) instead of fired fire-and-forget.
   *
   * All state — L1, backend, encryption, refresh tracking — is shared with
   * this cache; the view only carries the handle. Create one per request
   * and wrap functions THROUGH it (`view.wrap` / `view.with` /
   * `view.secure.wrap`): the handle must belong to the request that calls
   * the wrapped function, because workerd ties a refresh's I/O to the
   * request that started it. Binding the context lexically per request is
   * what makes this safe under concurrent requests in one isolate — a
   * mutable "current context" slot on the singleton would not be.
   *
   * Functions wrapped on the base cache keep working on Workers, just
   * without SWR (fail-safe plain L1 reads). On Node this is unnecessary:
   * fire-and-forget refreshes are never cancelled.
   */
  withExecutionContext(ctx: ExecutionContextLike): SecureCache {
    const waitUntil: WaitUntil = (promise) => ctx.waitUntil(promise);
    const wrapWith = <TArgs extends unknown[], TResult>(
      fn: (...args: TArgs) => Promise<TResult>,
      options: WrapOptions
    ): ((...args: TArgs) => Promise<TResult>) => this.wrap(fn, options, waitUntil);

    return {
      get: (key) => this.get(key),
      set: (key, value, options) => this.set(key, value, options),
      delete: (key) => this.delete(key),
      exists: (key) => this.exists(key),
      wrap: wrapWith,
      with: (options) => (fn) => wrapWith(fn, options),
      secure: { wrap: wrapWith },
      invalidate: (level, options) => this.invalidate(level, options),
      close: () => this.close(),
    };
  }

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

    // Every step runs even if an earlier one throws — key zeroization, wasm
    // frees, and the backend connection must not be leaked behind a failing
    // invalidation channel. Errors are collected and re-thrown (never
    // swallowed): the single-failure case keeps its original error type.
    const errors: unknown[] = [];
    const attempt = (step: () => unknown) => {
      try {
        step();
      } catch (error) {
        errors.push(error);
      }
    };

    // Stop background refresh manager (clears in-flight refreshes)
    attempt(() => this.backgroundRefresh.close());

    // Stop invalidation channel
    if (this.invalidationChannel) {
      try {
        await this.invalidationChannel.stop();
      } catch (error) {
        errors.push(error);
      }
    }

    // Dispose encryption (zeroizes key material)
    attempt(() => this.encryption?.dispose());

    // Release the envelope codec (zeroizes/frees wasm resources on Workers;
    // no-op for the GC-managed NAPI binding)
    attempt(() => this.byteStorage?.free?.());

    // Clear L1 (this also clears L1's internal refreshingKeys)
    attempt(() => this.l1?.clear());

    // Close backend
    try {
      await this.backend.close();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'cache.close() failed');
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new BackendError('Cache has been closed');
    }
  }
}

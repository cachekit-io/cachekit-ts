import type {
  CacheOptions,
  SetOptions,
  StampedeConfig,
  WrapOptions,
  WrapOptionsBase,
  SecureCache,
  EncryptionConfig,
  InvalidationConfig,
} from './types/cache.js';
import type { Backend, L1Metrics, LockableBackend } from './backends/types.js';
import type { InvalidationEvent } from './l1/types.js';
import type { MetricsCollector, MetricsConfig } from './metrics/prometheus.js';
import { logError } from './logger.js';
import { L1Cache } from './l1/lru-cache.js';
import { ReliabilityExecutor } from './reliability/executor.js';
import {
  BackgroundRefreshManager,
  type WaitUntil,
  type L1Write,
} from './cache/background-refresh.js';
import {
  decodeCounted,
  encodeCounted,
  resolveSerializerConfig,
  type ObjectCount,
  type SerializerConfig,
} from './serialization/serializer.js';
import {
  envelopeVerdict,
  looksLikeEnvelope,
  maxEnvelopeInputSize,
} from './serialization/envelope.js';
import {
  generateKey,
  generateParamsHash,
  extractNamespace,
  blake2b16Hex,
} from './serialization/key-generator.js';
import {
  generateInteropKey,
  validateInteropSegment,
  encodeInteropValueCounted,
  decodeInteropValueCounted,
} from './serialization/interop.js';
import { createInvalidationEvent } from './invalidation/event.js';
import {
  BackendError,
  ConfigurationError,
  EncryptionError,
  NonceExhaustedError,
  SerializationError,
  ValueTooLargeError,
} from './errors.js';
import { isErrorClassification } from './backends/error-classifier.js';
import {
  DEFAULT_TTL_SECONDS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_WAIT_MS,
  DEFAULT_LOCK_POLL_MS,
  DEFAULT_MAX_DECODED_SIZE,
} from './constants.js';

/**
 * Minimum interval between repeats of each rate-limited warning. Each reports
 * an outcome the caller often never sees as an error, so the SDK reports it
 * through the logger — rate-limited so a hot key can't flood the sink.
 * Module-private on purpose: not a tuning knob.
 */
const WARN_INTERVAL_MS = 60_000;

/**
 * Sentinel for "the lock path did not resolve the miss — compute without
 * it". Distinct from null: the wrapped function may legitimately resolve
 * null, and conflating the two would compute twice under a held lock.
 */
const LOCK_FALLTHROUGH = Symbol('cachekit.lock-fallthrough');

/**
 * AES-256-GCM ciphertext overhead: 12-byte nonce + 16-byte tag around the
 * plaintext (cachekit-core's layout; pinned by a test against the real
 * encryptor). Bounds ciphertext length before decrypt.
 */
const AEAD_OVERHEAD_BYTES = 12 + 16;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Read off globalThis: the build's lib set carries no WebAssembly types, and a
// runtime without WebAssembly has no traps to catch.
const WASM_RUNTIME_ERROR = (globalThis as { WebAssembly?: { RuntimeError?: ErrorConstructor } })
  .WebAssembly?.RuntimeError;

/**
 * A failure inside unpack that is not a verdict on the bytes: a wasm trap
 * (an allocation abort on a Workers isolate surfaces as
 * WebAssembly.RuntimeError, and leaves that instance unusable) or a JS
 * allocation failure copying the output out. Core's own rejections are plain
 * Errors from both bindings.
 */
function isResourceFailure(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    (WASM_RUNTIME_ERROR !== undefined && error instanceof WASM_RUNTIME_ERROR)
  );
}

/**
 * Metrics fallback when the runtime supplies no collector (Workers, or
 * metrics disabled). Duplicates NoopMetrics from metrics/prometheus.js
 * deliberately: that module's graph reaches prom-client (Node-only), so
 * cache-core may only import its types — a value import would trip the
 * workers bundle guard.
 */
const NOOP_METRICS: MetricsCollector = {
  async recordOperation() {},
  async recordHit() {},
  async recordMiss() {},
  async recordError() {},
  async startTimer() {
    return () => {};
  },
  async updateL1Stats() {},
  async updateCircuitBreakerState() {},
};

/**
 * ByteStorage envelope surface (LZ4 + xxHash3-64 + msgpack envelope).
 * Implemented by the NAPI binding on Node and the wasm binding on Workers.
 * Envelopes interoperate both ways; LZ4 output bytes can differ for inputs of
 * about 64 KiB and up.
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
  /** Throws ConfigurationError for a key encrypt/decrypt would reject for size. */
  validateKey(cacheKey: string, compressed?: boolean): void;
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
 * Structural on purpose: no dependency on @cloudflare/workers-types. Any
 * object with a compatible waitUntil satisfies the type; that is not a
 * runtime-support claim. The SDK ships two entries: Node (the `import` /
 * `require` conditions) and workerd (the `workerd` condition and the
 * `/workers` subpath).
 */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

// Public API since cachekit v0.1.4 (the workers entry re-exports it): the
// handle type consumers use to adapt a platform's background-work
// registration to withExecutionContext-style plumbing. Removing it broke
// published imports — keep the re-export.
export type { WaitUntil };

/**
 * Platform pieces injected into CacheImpl. Two implementations: Node
 * (cache.ts — Redis + NAPI) and Cloudflare Workers (workers/index.ts —
 * CachekitIO + wasm). Everything protocol-critical stays in CacheImpl.
 */
export interface CacheRuntime {
  /**
   * Resolve a backend config union to a Backend instance. `stampede` carries
   * the cold-miss protection config so a runtime can select a lock-capable
   * variant (Node picks cachekitioWithLocking for apiKey configs when
   * distributedLock is on); `l1Telemetry` lazily reads the cache's live
   * hit/miss counters so a SaaS backend can auto-wire its telemetry headers.
   * Runtimes without these conveniences may ignore both — users can still
   * pass a fully-configured Backend instance directly.
   */
  resolveBackend(
    config: CacheOptions['backend'],
    stampede?: StampedeConfig,
    l1Telemetry?: () => L1Metrics
  ): Backend;
  /**
   * Create the Prometheus metrics collector. Absent on platforms without
   * prom-client (Workers) — the `metrics` option degrades to a no-op there,
   * mirroring how the Node collector degrades when the optional prom-client
   * peer dependency is missing.
   */
  createMetrics?(config: MetricsConfig | undefined): MetricsCollector;
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
 * A key-free label for a failed L2 delete. Every field of a thrown error —
 * `cause`, `message`, `name`, even `classification` — is written by whoever
 * threw it and can embed the caller's key, so only literals are emitted and
 * `classification` is checked against its known values first. It is read
 * exactly once: a getter could pass the check and then return the key, or
 * throw and turn best-effort invalidation into a rejection.
 */
function describeDeleteFailure(err: unknown): string {
  if (!(err instanceof BackendError)) return err instanceof Error ? 'Error' : 'Unknown error';
  let classification: unknown;
  try {
    classification = err.classification;
  } catch {
    return 'BackendError';
  }
  return isErrorClassification(classification) ? `BackendError(${classification})` : 'BackendError';
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
  private readonly createByteStorage: () => ByteStorageLike;
  /** Lazily-created codec for envelope-tolerant reads on compression-off
   * caches (LAB-1388) — see decodeEntry. */
  private envelopeReader: ByteStorageLike | null = null;
  private readonly serializerConfig: SerializerConfig;
  private readonly defaultTtl: number;
  private readonly invalidationChannel: InvalidationChannelLike | null = null;
  private readonly metrics: MetricsCollector;
  // Live hit/miss counters. Feed both the Prometheus collector and the SaaS
  // X-CacheKit-L1-* telemetry headers (auto-wired via resolveBackend's
  // l1Telemetry hook below).
  private readonly telemetry = { l1Hits: 0, l2Hits: 0, misses: 0 };
  private readonly swrRequiresWaitUntil: boolean;
  /**
   * Mirrors ReliabilityExecutor's own default. Read directly by the
   * decode/encode paths that run outside the executor (L1 decrypt, L2 decode,
   * set encode), so they honour the same fail-open/fail-closed choice.
   */
  private readonly degradationEnabled: boolean;
  private closed = false;
  /** One in-flight cold-miss resolution per cache key (single-flight, LAB-519). */
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly stampede: Required<StampedeConfig>;
  private readonly lockable: LockableBackend | null;

  constructor(options: CacheOptions, runtime: CacheRuntime) {
    // Every config check that can throw ConfigurationError runs before
    // resolveBackend: a URL config opens a reconnecting Redis client there, and
    // a throw after that point would leak it to a caller who catches the error.
    // The one exception is the distributedLock check below, which needs the
    // backend instance.
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

    if (options.invalidation && !runtime.createInvalidationChannel) {
      throw new ConfigurationError(
        'Cross-instance invalidation is not supported in this runtime ' +
          '(Redis Pub/Sub requires Node — remove the invalidation option)'
      );
    }

    // Initialize encryption (its key checks throw ConfigurationError)
    this.encryption = options.encryption ? runtime.createEncryption(options.encryption) : null;

    // Initialize serializer (its bound checks throw ConfigurationError)
    this.serializerConfig = resolveSerializerConfig(options.serializer);

    // Initialize backend. The telemetry getter reads `this` lazily (per
    // request), so constructor field order is safe.
    this.backend = runtime.resolveBackend(options.backend, options.stampede, () => ({
      ...this.telemetry,
      l1Enabled: this.l1 !== null,
    }));

    // Initialize metrics (Prometheus via the runtime; no-op when the
    // platform has no collector or metrics are off)
    const metricsOption = options.metrics ?? false;
    this.metrics =
      metricsOption !== false && runtime.createMetrics
        ? runtime.createMetrics(typeof metricsOption === 'object' ? metricsOption : undefined)
        : NOOP_METRICS;

    // Lock capability. Duck-typed like cachekit-py's hasattr check:
    // user-supplied Backend instances aren't required to declare the
    // LockableBackend interface, only to implement it. On Node, URL and apiKey
    // configs resolve to lock-capable backends, so the distributedLock check
    // cannot fire for them. On Workers, apiKey resolves to a lockless fetch
    // backend that holds no connection, so throwing here leaks nothing.
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
    this.degradationEnabled = options.reliability?.degradation !== false;

    // Initialize background refresh manager (SWR)
    this.backgroundRefresh = new BackgroundRefreshManager();
    this.swrRequiresWaitUntil = runtime.swrRequiresWaitUntil ?? false;

    // Initialize ByteStorage (LZ4 compression + xxHash3-64 integrity). The
    // default honors the backend's advertised preference (LAB-1388), else
    // true. An explicit option wins.
    const compressionEnabled = options.compression ?? this.backend.compressionDefault ?? true;
    this.byteStorage = compressionEnabled ? runtime.createByteStorage() : null;
    // Kept for lazy envelope-tolerant reads (see decodeEntry): a
    // compression-off cache still needs a codec the first time it meets an
    // enveloped entry.
    this.createByteStorage = () => runtime.createByteStorage();

    // Default TTL
    this.defaultTtl = options.defaultTtl ?? DEFAULT_TTL_SECONDS;

    // m1 Fix: Initialize invalidation channel if config provided
    if (options.invalidation && runtime.createInvalidationChannel) {
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

  /** Timestamp of the last set-rejected warning (rate limiting). */
  private lastSetRejectedWarnAt = 0;

  /** Timestamp of the last envelope-unpack-rejected warning (rate limiting). */
  private lastEnvelopeRejectWarnAt = 0;

  /** Timestamp of the last authentication-rejected warning (rate limiting). */
  private lastAuthRejectWarnAt = 0;

  /** Timestamp of the last pack-or-encrypt-failed warning (rate limiting). */
  private lastSetEncryptFailedWarnAt = 0;

  /**
   * Verified unpack of a suspected legacy/foreign ByteStorage envelope on a
   * compression-off cache. Returns null when the bytes aren't treated as an
   * envelope — the caller then decodes them as plain serialized data. A
   * header or core-cap miss rules an envelope out; a checksum/shape rejection
   * from core is ambiguous (look-alike value or damaged envelope), so it is
   * also reported via warnEnvelopeRejected. The codec
   * is created lazily and cached — except after close(), when a throwaway
   * codec is used and freed immediately.
   *
   * @throws {ValueTooLargeError} for an envelope over maxDecodedSize (see
   *   envelopeVerdict) — never unpacked.
   * @throws the codec's RangeError / WebAssembly.RuntimeError when unpack
   *   fails for lack of memory rather than on the bytes (isResourceFailure).
   */
  private tryUnwrapEnvelope(bytes: Uint8Array, key: string): Uint8Array | null {
    // Only an envelope within the ceiling gets as far as unpack. One over it
    // throws rather than falling back: a real envelope served as plain data is
    // the corruption this path exists to prevent.
    if (envelopeVerdict(bytes, this.serializerConfig.maxDecodedSize) === 'not-envelope')
      return null;

    // Codec construction stays OUTSIDE the try: a broken binding must fail
    // loudly (through getEntry's decode-failure path: counted, then a miss or
    // a rethrow per degradation), not be conflated with "not
    // an envelope" — that would silently serve raw envelope tuples, the
    // exact corruption this path exists to prevent (LAB-1768).
    //
    // After close() the cached reader has already been freed — an in-flight
    // read resuming post-shutdown must not resurrect the cache (close() will
    // never free it again), so it gets a throwaway codec freed right here.
    const reader = this.closed
      ? this.createByteStorage()
      : (this.envelopeReader ??= this.createByteStorage());
    try {
      return reader.unpack(bytes);
    } catch (error) {
      // Not a verdict on the bytes (see isResourceFailure). A native NAPI
      // allocation failure aborts the process instead; nothing here catches it.
      if (isResourceFailure(error)) throw error;
      this.warnEnvelopeRejected(key, bytes.length);
      return null;
    } finally {
      if (reader !== this.envelopeReader) this.freeThrowawayCodec(reader);
    }
  }

  /**
   * Pack/unpack through the compression-on codec (`byteStorage`) — or, after
   * close() has freed it, through a throwaway codec freed right here. Same
   * post-shutdown hazard tryUnwrapEnvelope guards: an in-flight operation
   * resuming after close() must neither touch freed wasm memory (a
   * use-after-free on Workers) nor cache a codec nothing will ever free.
   * Callers must have established useEnvelope (byteStorage non-null).
   */
  private withEnvelopeCodec<T>(use: (codec: ByteStorageLike) => T): T {
    const codec = this.closed ? this.createByteStorage() : this.byteStorage!;
    try {
      return use(codec);
    } finally {
      if (codec !== this.byteStorage) this.freeThrowawayCodec(codec);
    }
  }

  /** Free a post-close throwaway codec without masking the caller's result. */
  private freeThrowawayCodec(codec: ByteStorageLike): void {
    try {
      codec.free?.();
    } catch (error) {
      logError(
        `[cachekit] failed to free post-close envelope codec: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * One-line, greppable, rate-limited report of a set() whose value failed to
   * encode — the only reliable signal of the rejection when degradation or a
   * consumer catch-block absorbs the error itself. Covers every encode error,
   * not just size (LAB-1388): depth, collection-size and binary-type
   * rejections, and the plain Error @msgpack/msgpack throws for a function or
   * BigInt, were all dropped silently before (LAB-4845).
   */
  private warnSetRejected(key: string, error: unknown, interop: boolean): void {
    const now = Date.now();
    if (now - this.lastSetRejectedWarnAt < WARN_INTERVAL_MS) return;
    this.lastSetRejectedWarnAt = now;
    // Only a size rejection is fixed by raising a limit, and interop caps are
    // protocol constants serializer config does not govern — the remediation
    // hint only holds for a size rejection on the serializer path
    // (LAB-1768).
    const hint =
      error instanceof ValueTooLargeError && !interop
        ? ' Raise serializer.maxEncodedSize / maxDecodedSize if values this large are expected.'
        : '';
    // Keys are caller-controlled and may embed PII/credentials — log a
    // non-reversible digest, not the key itself. Same key → same digest, so
    // repeated rejections still correlate, and holders of a suspect key can
    // recompute the digest to match it.
    const keyHash = blake2b16Hex(key);
    // The same goes for the error text: never log it. A getter or Proxy trap on
    // the value runs caller code inside the encoder, and that code can throw
    // any error — the SDK's own classes included — with the value or the key
    // in its message. The class only picks a fixed reason, so a spoofed class
    // can at worst mislabel the rejection, never leak through it (LAB-4845).
    const reason =
      error instanceof ValueTooLargeError
        ? 'encoded value exceeds the size limit'
        : error instanceof SerializationError
          ? 'value exceeds maxDepth or maxCollectionSize, or is an unsupported binary type'
          : 'value could not be encoded (an unsupported type, or a getter or proxy threw)';
    logError(`[cachekit] set rejected, value NOT cached (keyHash=${keyHash}): ${reason}.${hint}`);
  }

  /**
   * Rate-limited report of an envelope-shaped read that core refused to unpack
   * (checksum or shape mismatch). The bytes are then decoded as plain data:
   * right for a user value that only looks like an envelope, silent corruption
   * for a damaged real one. The two can't be told apart here, so this report
   * is the only trace either leaves. Core's error text is left out on purpose:
   * on a secure cache these bytes are decrypted plaintext, and its
   * deserialization errors can echo scalars from them. The key is digested
   * for the same reason warnSetRejected gives.
   */
  private warnEnvelopeRejected(key: string, size: number): void {
    const now = Date.now();
    if (now - this.lastEnvelopeRejectWarnAt < WARN_INTERVAL_MS) return;
    this.lastEnvelopeRejectWarnAt = now;
    logError(
      `[cachekit] envelope-shaped value failed verified unpack, read as plain data (keyHash=${blake2b16Hex(key)}, bytes=${size}). Unless the cached value is itself meant to look like an envelope, the entry is corrupt — delete it.`
    );
  }

  /**
   * Rate-limited report of a backend op rejected as `authentication` (a bad or
   * revoked API key, or an edge block). It is never retried and never counts
   * toward the breaker, and degradation turns it into a miss or a no-op, so
   * without this line a misconfigured key is invisible — and once a failed
   * write still fills L1, it hides behind L1 hits too. The error text is left
   * out: it can carry the response body. The key is digested for the reason
   * warnSetRejected gives.
   */
  private warnAuthRejected(operation: string, key: string, error: unknown): void {
    if (!(error instanceof BackendError) || error.classification !== 'authentication') return;
    const now = Date.now();
    if (now - this.lastAuthRejectWarnAt < WARN_INTERVAL_MS) return;
    this.lastAuthRejectWarnAt = now;
    logError(
      `[cachekit] backend rejected ${operation} as an authentication failure (keyHash=${blake2b16Hex(key)}). Check the API key; with degradation on, L2 is being skipped.`
    );
  }

  /**
   * Rate-limited report of a set() whose pack or encrypt step failed while
   * degradation absorbed the error. The failure runs before the reliability
   * executor, so the breaker never sees it, and with metrics off nothing else
   * records it: an exhausted nonce budget would otherwise drop every write on
   * the cache without a trace. The line claims only that L2 was skipped: a
   * plaintext SWR refresh still keeps the value in L1. The error text is left
   * out because EncryptionError wraps native error text, and native text can
   * carry the plaintext it was handed (as warnEnvelopeRejected notes). The key
   * is digested for the reason warnSetRejected gives. NonceExhaustedError is an
   * EncryptionError, so it is matched first.
   */
  private warnSetEncryptFailed(key: string, error: unknown): void {
    const now = Date.now();
    if (now - this.lastSetEncryptFailedWarnAt < WARN_INTERVAL_MS) return;
    this.lastSetEncryptFailedWarnAt = now;
    const reason =
      error instanceof NonceExhaustedError
        ? 'the encryption key exhausted its nonce budget; rotate forward to a NEW master key (runbook: https://docs.cachekit.io/concepts/key-rotation/)'
        : error instanceof ConfigurationError
          ? 'the native bindings are out of step with the SDK version and dropped previousMasterKeys; reinstall dependencies'
          : error instanceof EncryptionError
            ? 'encryption failed (the native bindings did not load, the cache was closed, or the encryptor errored)'
            : 'the value could not be packed into its compressed envelope';
    logError(
      `[cachekit] set failed to encrypt or compress, value NOT written to L2 (keyHash=${blake2b16Hex(key)}): ${reason}.`
    );
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
  private async instrument<T>(operation: string, key: string, fn: () => Promise<T>): Promise<T> {
    const endTimer = await this.metrics.startTimer(operation);
    try {
      const result = await fn();
      void this.metrics.recordOperation(operation, 'success');
      return result;
    } catch (error) {
      this.recordFailure(operation, error);
      this.warnAuthRejected(operation, key, error);
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
  private run<T>(operation: string, key: string, fallback: T, fn: () => Promise<T>): Promise<T> {
    return this.execute(() => this.instrument(operation, key, fn), fallback);
  }

  async get<T>(key: string): Promise<T | null> {
    return this.getEntry(key, false);
  }

  /**
   * Does this entry ride the ByteStorage envelope? Interop entries never do —
   * they are plain MessagePack with AAD compressed=False regardless of the
   * cache-level `compression` option, so py/rs can read them byte-for-byte.
   */
  private useEnvelope(interop: boolean): boolean {
    return !interop && this.byteStorage !== null;
  }

  /**
   * What L1 should hold for an entry: the same ciphertext L2 holds when the
   * cache is encrypted, the decoded value otherwise.
   *
   * Zero-knowledge is a property of every layer, not just the backend
   * (LAB-238) — it is what cachekit-py does (its L1Cache stores bytes and
   * decrypts at read time) and cachekit-rs with it. Holding post-decrypt
   * plaintext here would put the entire L1 working set into any heap dump,
   * core dump, or Node diagnostic report for the full TTL, and that plaintext
   * would outlive the key zeroization in close(), since L1 entries are held
   * independently of tenant keys.
   *
   * The bytes are copied when they are a window into a larger buffer: a Node
   * Buffer from the backend is a view onto a shared 8 KiB pool slab, and
   * retaining one for the entry's TTL pins the whole slab. cachekit-py guards
   * the same edge by refusing memoryview/bytearray in L1Cache.put. This guards
   * slab pinning only — it does NOT defend against a backend that mutates a
   * buffer it already handed over. Every in-tree backend returns an owned,
   * exact-size Uint8Array (redis, memcached, cachekitio, workers-kv,
   * workers-cache-api) and file.ts's narrower header view lands in the copy
   * branch; a third-party Backend that recycles buffers must copy on its side.
   */
  private l1Payload(value: unknown, bytes: Uint8Array): unknown {
    if (!this.encryption) return value;
    return bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes);
  }

  /**
   * Ciphertext (or envelope) bytes to the value they carry: decrypt +
   * AAD-verify against the cache key, unpack the ByteStorage envelope, then
   * deserialize. Shared by the L2 read and the L1 read so the two tiers can
   * never drift into decoding the same entry differently — a real hazard once
   * both paths handle AAD (protocol#12 freezes the v0x03 component set).
   */
  private async decodeEntry<T>(
    bytes: Uint8Array,
    key: string,
    interop: boolean
  ): Promise<{ value: T; serializedSize: number; objects: number }> {
    const useEnvelope = this.useEnvelope(interop);

    let plaintext = bytes;
    if (this.encryption) {
      // Refuse ciphertext longer than any plaintext this cache would decode
      // before the codec copies it in: junk of any length otherwise reaches
      // decrypt, which allocates for all of it before the tag check fails.
      // The AAD binds useEnvelope, so a compression-off entry that decrypts
      // is a plain serialized value, which decode() caps at maxDecodedSize.
      const maxPlaintext = interop
        ? DEFAULT_MAX_DECODED_SIZE // decodeInteropValue's fixed input cap
        : useEnvelope
          ? maxEnvelopeInputSize(this.serializerConfig.maxDecodedSize)
          : this.serializerConfig.maxDecodedSize;
      if (plaintext.length > maxPlaintext + AEAD_OVERHEAD_BYTES) {
        throw new ValueTooLargeError(
          `Ciphertext size ${plaintext.length} exceeds max ${maxPlaintext + AEAD_OVERHEAD_BYTES}`
        );
      }
      plaintext = await this.encryption.decrypt(plaintext, key, useEnvelope);
    }
    if (useEnvelope) {
      if (envelopeVerdict(plaintext, this.serializerConfig.maxDecodedSize) === 'not-envelope') {
        throw new SerializationError(
          `Stored bytes (${plaintext.length} B) are not an envelope core would accept; refused before unpack`
        );
      }
      plaintext = this.withEnvelopeCodec((codec) => codec.unpack(plaintext));
    } else if (!interop && looksLikeEnvelope(plaintext)) {
      // Envelope tolerance (LAB-1388): a compression-off cache can read
      // entries a compression-on writer stored — same store, older SDK
      // default, or a mixed-version fleet mid-rollout. This is NOT optional
      // hygiene: the envelope is itself valid MessagePack (a positional
      // 4-tuple), so a plain decode would "succeed" and serve the envelope
      // structure as the cached value — silent corruption, invisible to
      // degradation. The unpack's xxHash3 check rejects ACCIDENTAL
      // look-alikes; it is keyless, so it is not a defense against an
      // adversarial writer deliberately crafting a valid envelope as its
      // cached value (accepted eyes-open in LAB-1388/LAB-1768). Its blast
      // radius is maxDecodedSize: envelopeVerdict bounds what unpack may
      // allocate before it runs, and maxDepth bounds the decode after it.
      // Bytes that are not an envelope core would accept, or that core
      // rejects, fall back to plain-serialized; an envelope over the ceiling
      // or an allocation failure throws.
      //
      // Encrypted caches never reach this branch for a genuinely mismatched
      // entry: the AAD binds useEnvelope (frozen v0x03 set, protocol#12), so
      // a compression-off secure cache reading a compression-on entry fails
      // AAD verification in decrypt() above — a loud, counted decrypt
      // failure (miss / L1 drop), never a silent wrong decode. Tolerance
      // after a SUCCESSFUL decrypt only sees the same-AAD case: mostly a
      // plaintext user value that happens to look like an envelope, resolved
      // by the verified unpack. An envelope stored under compressed=false
      // whose bytes exceed maxDecodedSize is refused by the ciphertext cap
      // above; a smaller one is unwrapped like any look-alike, and no ts, py
      // or rs writer produces one. We deliberately do NOT retry decrypt() with
      // the flipped AAD flag: that would reintroduce exactly the envelope-
      // mode ambiguity the AAD binding exists to rule out.
      plaintext = this.tryUnwrapEnvelope(plaintext, key) ?? plaintext;
    }
    // The decode's depth pre-scan counts the heap objects on the way, so L1
    // can charge for them without another walk (see L1Cache.set).
    const count: ObjectCount = { objects: 0 };
    const value = interop
      ? decodeInteropValueCounted<T>(plaintext, count)
      : decodeCounted<T>(plaintext, this.serializerConfig, count);
    // The serialized length, not bytes.byteLength: that is the compressed
    // (and maybe encrypted) envelope, several times smaller, and charging L1
    // for it would let L1 grow well past maxMemory.
    return { value, serializedSize: plaintext.length, objects: count.objects };
  }

  /**
   * Decode a value served from L1. For a secure cache that is a decrypt +
   * AAD-verify against the cache key followed by the same unpack/deserialize
   * the L2 path runs — an L1 hit is no longer free, which is the price of not
   * keeping plaintext resident. For a plaintext cache it is a cast.
   *
   * Drops the L1 entry and returns null when a secure entry will not decrypt
   * (rotated key, tampered heap, an entry written under a different envelope
   * mode), so a poisoned L1 copy cannot outlive remediation of L2 — cachekit-py
   * invalidates before applying its fail policy for the same reason. The result
   * is wrapped because a cached value may legitimately BE null: without the
   * wrapper a secure cache holding null would read as a decrypt failure on
   * every hit, invalidating and re-fetching a perfectly good entry forever.
   *
   * Fail policy follows `reliability.degradation`, the same lever that governs
   * an L2 decrypt failure (decoded after run() in getEntry, so never retried
   * or counted by the breaker): degradation on absorbs
   * the failure and falls through to L2, degradation off rethrows so a tamper
   * signal reaches the caller. Either way it is counted and logged, never
   * silently swallowed.
   */
  private async decodeL1Entry<T>(
    key: string,
    stored: unknown,
    interop: boolean
  ): Promise<{ value: T } | null> {
    if (!this.encryption) return { value: stored as T };

    try {
      if (!(stored instanceof Uint8Array)) {
        throw new Error(
          `L1 entry for a secure cache is not ciphertext bytes (got ${typeof stored})`
        );
      }
      return { value: (await this.decodeEntry<T>(stored, key, interop)).value };
    } catch (error) {
      this.l1?.invalidateByKey(key);
      this.recordFailure('l1_decrypt', error);
      logError(
        '[cachekit] L1 decrypt failed — entry dropped:',
        error instanceof Error ? error.message : 'Unknown error'
      );
      if (!this.degradationEnabled) throw error;
      return null;
    }
  }

  /**
   * L1 + L2 read. Interop entries (interop=true) are plain MessagePack —
   * no ByteStorage envelope and AAD compressed=False — regardless of the
   * cache-level `compression` option. `ttlSeconds` (when known, i.e. from
   * wrap()) bounds the L1 repopulation lifetime so an entry never outlives
   * its declared TTL in L1 long after L2 and the other SDKs expired it.
   * On backends that surface the remaining TTL on read (getWithTtl), the
   * bound tightens to the entry's actual remaining lifetime — a plain get()
   * at t=29s of a 30s entry re-populates L1 for 1s, not defaultTtl
   * (LAB-1388).
   */
  private async getEntry<T>(key: string, interop: boolean, ttlSeconds?: number): Promise<T | null> {
    this.ensureNotClosed();

    // Check L1 first. A secure cache holds ciphertext here, so the hit costs a
    // decrypt + AAD verify; an entry that fails to verify is dropped and this
    // falls through to L2 rather than serving or throwing.
    if (this.l1) {
      const l1Result = this.l1.get(key);
      if (l1Result !== null) {
        const decoded = await this.decodeL1Entry<T>(key, l1Result, interop);
        if (decoded !== null) {
          this.recordHit('l1');
          return decoded.value;
        }
      }
    }

    // Reserved-key and key-size pre-flight — see Backend.validateKey and
    // EncryptionManagerCore.validateKey.
    this.backend.validateKey?.(key);
    this.encryption?.validateKey(key, this.useEnvelope(interop));

    // Fetch from L2 (backend). Only the round trip runs inside the reliability
    // executor; decode runs after it. A decode or decrypt failure is a
    // deterministic property of the stored bytes (rotated key without
    // previousMasterKeys, an envelope-mode flip the AAD binds, a foreign or
    // corrupt entry): retrying re-fetches the same bytes and sleeps the backoff
    // for nothing, and the circuit breaker would count it as a backend failure
    // — five poisoned reads in a window would open the breaker and degrade
    // every key on this cache (LAB-7079, the read-side mirror of LAB-5139).
    // A first-use native-binding load failure inside decrypt is no longer
    // retried either; it self-heals on the next read (initPromise resets).
    const fetched = await this.run('get', key, null, async () => {
      // When L1 will be re-populated, prefer the TTL-carrying read (same
      // storage round trip — see Backend.getWithTtl) so the L1 copy can be
      // capped at the entry's remaining lifetime below (LAB-1388).
      let data: Uint8Array | null;
      let remainingTtl: number | null = null;
      if (this.l1 && this.backend.getWithTtl) {
        const result = await this.backend.getWithTtl(key);
        data = result?.value ?? null;
        remainingTtl = result?.ttlSeconds ?? null;
      } else {
        data = await this.backend.get(key);
      }
      if (data === null) {
        this.recordMiss();
        return null;
      }
      return { data, remainingTtl };
    });
    // A miss (counted above) or a backend failure degradation absorbed.
    if (fetched === null) return null;
    const { data, remainingTtl } = fetched;

    // Decrypt, unpack, deserialize — the same sequence an L1 hit runs. The
    // failure keeps the degradation contract it had inside the executor:
    // counted, then thrown with degradation off, a miss with it on.
    let value: T;
    let serializedSize: number;
    let objects: number;
    try {
      ({ value, serializedSize, objects } = await this.decodeEntry<T>(data, key, interop));
    } catch (error) {
      // Its own operation label, like 'l1_decrypt': the fetch already
      // recorded a successful 'get', so counting this under 'get' too would
      // report one read as two operations.
      this.recordFailure('l2_decode', error);
      if (!this.degradationEnabled) throw error;
      return null;
    }

    // Populate L1 with `data` — the bytes the backend returned, still
    // encrypted — not the plaintext `value` decoded above. Interop keys are
    // {namespace}:{operation}:{hash} — group under the user-facing namespace
    // segment so namespace-level invalidation matches entries written
    // through wrap(). The lifetime is the declared TTL (or defaultTtl on a
    // plain get), capped at the L2 entry's remaining TTL when the backend
    // surfaced it — so the L1 copy never outlives the entry it was read
    // from (LAB-1388).
    if (this.l1) {
      const namespace = interop ? key.slice(0, key.indexOf(':')) : extractNamespace(key);
      const capSeconds = ttlSeconds ?? this.defaultTtl;
      // ttl <= 0 means "no expiry" (ts-wide Backend contract) — treat it
      // as infinite here so Math.min still caps to a real remainingTtl
      // when the backend reports one, instead of collapsing to 0 and
      // tripping the skip-guard below for an entry that should never
      // expire in L1 (LAB-1388).
      const capOrForever = capSeconds > 0 ? capSeconds : Infinity;
      const l1TtlSeconds =
        remainingTtl !== null ? Math.min(capOrForever, remainingTtl) : capOrForever;
      if (l1TtlSeconds > 0) {
        // Hand L1 its own canonical no-expiry encoding (ttl <= 0), never
        // Infinity ms: an Infinity originalTtl turns getWithSwr's
        // freshness check into `Infinity > Infinity` — permanently stale,
        // arming a spurious background refresh per marker window, forever
        // (LAB-1768).
        const l1TtlMs = Number.isFinite(l1TtlSeconds) ? l1TtlSeconds * 1000 : 0;
        this.l1.set(key, this.l1Payload(value, data), l1TtlMs, namespace, serializedSize, objects);
        this.publishL1Stats();
      }
    }

    this.recordHit('l2');
    return value;
  }

  async set<T>(key: string, value: T, options?: SetOptions): Promise<void> {
    await this.setEntry(key, value, options, false);
  }

  /**
   * L1 + L2 write. Interop entries (interop=true) serialize to canonical
   * plain MessagePack — never the ByteStorage envelope — and encrypt with
   * AAD compressed=False, matching the Python and Rust SDKs byte-for-byte.
   *
   * Returns the payload L1 should hold for this entry, so the SWR refresh
   * path (which defers its L1 write to completeRefresh's version check) can
   * store the ciphertext this produced instead of the caller's plaintext.
   * Null only when an encrypted cache produced no ciphertext — see
   * `unencoded`.
   */
  private async setEntry<T>(
    key: string,
    value: T,
    options: SetOptions | undefined,
    interop: boolean,
    updateL1 = true
  ): Promise<L1Write | null> {
    this.ensureNotClosed();

    const ttl = options?.ttl ?? this.defaultTtl;

    // Validate TTL
    if (!Number.isFinite(ttl) || ttl < 0) {
      throw new ConfigurationError(`Invalid TTL: ${ttl}. Must be a non-negative finite number.`);
    }

    // A backend with hard TTL bounds (CachekitIO: reject 0 / > 30 days per
    // protocol) or a key it cannot address (CachekitIO's reserved path
    // segments) rejects here, synchronously — for the same reason as the
    // interop rejection below: inside `run`, degradation would swallow the
    // deterministic caller error (set() would silently never store) and
    // retry/circuit-breaker would count it as backend failures.
    this.backend.validateTtl?.(ttl);
    this.backend.validateKey?.(key);

    const namespace = options?.namespace ?? extractNamespace(key);
    const useEnvelope = this.useEnvelope(interop);
    // A key too long for the encryption AAD fails the same way, for the same
    // reason (see EncryptionManagerCore.validateKey).
    this.encryption?.validateKey(key, useEnvelope);

    // What L1 may hold when the value never becomes bytes (an encode, pack or
    // encrypt failure): the value itself on a plaintext cache, nothing on an
    // encrypted one, whose L1 holds only ciphertext. Only the SWR refresh path
    // stores it; a direct write returns before its L1 update.
    const unencoded: L1Write | null = this.encryption ? null : { l1: value };

    // Serialize before the reliability executor. An encode rejection is a
    // deterministic caller error: retrying it re-encodes the same value for
    // nothing, and the circuit breaker would count it as a backend failure —
    // five oversized values in a window would open the breaker and degrade
    // every key on this cache (LAB-5139). Interop rejection always throws
    // (spec: values outside the data model MUST error). Auto-mode rejection
    // keeps the degradation contract it had inside the executor: counted,
    // then thrown with degradation off, absorbed with it on — never written
    // to L2, though an SWR refresh on a plaintext cache still repopulates L1
    // from `unencoded`, as a degraded backend write does. An auto-mode
    // rejection, or an interop size rejection, emits one rate-limited warning
    // either way (LAB-1388, LAB-4845).
    // Normalizing (auto mode) and the header encoders (interop) count the
    // heap objects on the way, so L1 can charge for them without another walk.
    const count: ObjectCount = { objects: 0 };
    let serialized: Uint8Array;
    try {
      serialized = interop
        ? encodeInteropValueCounted(value, count)
        : encodeCounted(value, this.serializerConfig, count);
    } catch (error) {
      // Interop stays size-only: its rejection always throws to the caller, and
      // its messages can carry value content (an out-of-range integer) that a
      // log line must not.
      if (!interop || error instanceof ValueTooLargeError)
        this.warnSetRejected(key, error, interop);
      if (interop) throw error;
      this.recordFailure('set', error);
      if (!this.degradationEnabled) throw error;
      return unencoded;
    }

    // Compress (ByteStorage envelope, before encryption) and encrypt before
    // the executor too: an open breaker rejects before the write closure runs,
    // so the bytes L1 keeps must exist before `run`. A pack or encrypt failure
    // is not a backend failure either — a retry repeats the same local work,
    // and the breaker would count it as an outage — so it is counted, then
    // thrown with degradation off and absorbed with it on (with one
    // rate-limited warning), and never written to L2. Interop entries get the
    // same handling: the spec's always-throw covers encoding, not encryption.
    let data: Uint8Array;
    try {
      data = useEnvelope ? this.withEnvelopeCodec((codec) => codec.pack(serialized)) : serialized;
      if (this.encryption) data = await this.encryption.encrypt(data, key, useEnvelope);
    } catch (error) {
      this.recordFailure('set', error);
      if (!this.degradationEnabled) throw error;
      this.warnSetEncryptFailed(key, error);
      // The value did serialize, so its size and count are known.
      return (
        unencoded && { ...unencoded, serializedSize: serialized.length, objects: count.objects }
      );
    }
    // Exists before the backend write, so a write that the breaker skips or
    // degradation absorbs still yields it. Otherwise an encrypted cache's SWR
    // refresh gets nothing to store, the stale entry stays, and the refresh
    // re-runs the origin once per refresh-marker window.
    const l1Write: L1Write = {
      l1: this.l1Payload(value, data),
      serializedSize: serialized.length,
      objects: count.objects,
    };

    // Only the backend write runs under retry, the breaker and degradation.
    await this.run('set', key, undefined, () => this.backend.set(key, data, ttl));

    // Update L1 for direct writes — after `run`, so a backend write that
    // degradation absorbed still fills it, as cachekit-py's sync path does.
    // Otherwise every wrap() during an L2 outage or a 401/403 recomputes the
    // origin and re-pays the doomed round trips. With degradation off `run`
    // throws and L1 stays empty. On an encrypted cache L1 gets the ciphertext,
    // never the caller's plaintext. The SWR refresh path passes updateL1=false
    // and writes L1 only through completeRefresh, whose version token discards
    // the refresh if an explicit write or invalidation landed meanwhile — the
    // guard is authoritative for L1 ONLY. The backend.set above is
    // unconditional last-write-wins: an interleaved explicit set() survives in
    // L1 but is overwritten in L2 by the refresh's value until the entry next
    // expires or refreshes (a conditional L2 write would need CAS the Backend
    // contract doesn't have).
    if (updateL1 && this.l1) {
      this.l1.set(key, l1Write.l1, ttl * 1000, namespace, l1Write.serializedSize, l1Write.objects);
      this.publishL1Stats();
    }

    return l1Write;
  }

  async delete(key: string): Promise<boolean> {
    this.ensureNotClosed();
    this.backend.validateKey?.(key); // see Backend.validateKey

    // Invalidate L1 after the L2 attempt whatever its outcome — a failed
    // write still fills L1 (setEntry), so an L1 eviction gated on L2 success
    // would serve the deleted value for its full TTL. Not before: get()
    // refills L1 from L2 unguarded, so evicting first lets a concurrent read
    // put the old value back before the backend delete lands.
    try {
      return await this.run('delete', key, false, () => this.backend.delete(key));
    } finally {
      if (this.l1) {
        this.l1.invalidateByKey(key);
        this.publishL1Stats();
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    this.ensureNotClosed();
    this.backend.validateKey?.(key); // see Backend.validateKey

    // Check L1 first. Presence alone is not an answer for a secure cache: L1
    // holds ciphertext, and after a key rotation every resident entry is
    // undecryptable, so a bare `get() !== null` would report present for
    // entries get() verifies, rejects and drops. Decode so exists() and get()
    // cannot disagree, and so the poisoned entry is dropped here too.
    if (this.l1) {
      const l1Value = this.l1.get(key);
      if (l1Value !== null && (await this.decodeL1Entry(key, l1Value, false)) !== null) {
        this.recordHit('l1');
        return true;
      }
    }

    // Record the L2 outcome too — the L1 path above already counts hits, so
    // skipping L2 here would skew the hit/miss counters (and the SaaS L1
    // telemetry headers they feed) for L2-only existence checks.
    return this.run('exists', key, false, async () => {
      const exists = await this.backend.exists(key);
      if (exists) this.recordHit('l2');
      else this.recordMiss();
      return exists;
    });
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
      // Re-encoding backends (e.g. the Cloudflare Cache API maps keys to
      // synthetic URLs) can't express the transform as a keyPrefix, but they
      // break interop for the same reason — the key never reaches the store
      // byte-identical to py/rs. Fail closed; see Backend.transformsKeys.
      if (this.backend.transformsKeys) {
        throw new ConfigurationError(
          `Interop operation "${interopOperation}" cannot run on a backend that transforms keys ` +
            '(e.g. the Cloudflare Cache API maps each key onto a synthetic URL). Use a verbatim-key ' +
            'backend (Redis / CachekitIO / Workers KV) for interop caches; see Backend.transformsKeys.'
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
      if (interop && (this.backend.keyPrefix || this.backend.transformsKeys)) {
        throw new ConfigurationError(
          `Interop operation "${interopOperation}" cannot run on a backend with a key prefix ` +
            'or key transform — see Backend.keyPrefix / Backend.transformsKeys'
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
            const decoded = await this.decodeL1Entry<TResult>(cacheKey, l1Value, interop);
            if (decoded !== null) {
              this.recordHit('l1');
              return decoded.value;
            }
          }
        } else {
          const swrResult = this.l1.getWithSwr(cacheKey);

          if (swrResult.value !== null) {
            // Decode before scheduling: an entry that will not decrypt is
            // already gone, so refreshing it would race the cold path that is
            // about to recompute the same key.
            let decoded: { value: TResult } | null = null;
            try {
              decoded = await this.decodeL1Entry<TResult>(cacheKey, swrResult.value, interop);
            } finally {
              // Decode failed — by rethrow (degradation off) or by null
              // (degradation on) — so the entry is dropped either way, and the
              // marker getWithSwr took on our behalf must not outlive it:
              // release the slot rather than strand it for the marker TTL.
              if (decoded === null && swrResult.shouldRefresh) this.l1.cancelRefresh(cacheKey);
            }
            if (decoded !== null) {
              // Trigger background refresh if needed
              if (swrResult.shouldRefresh) {
                this.backgroundRefresh.scheduleRefresh(
                  cacheKey,
                  () => fn(...args),
                  { ttl: options.ttl, namespace: options.namespace },
                  swrResult.versionToken,
                  this.l1,
                  (key, value, opts) =>
                    this.setEntry(
                      key,
                      value,
                      { ttl: opts.ttl, namespace: opts.namespace },
                      interop,
                      false
                    ),
                  waitUntil
                );
              }
              this.recordHit('l1');
              return decoded.value;
            }
          }
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

  secure: SecureCache['secure'] = { wrap: (fn, options) => this.secureWrap(fn, options) };

  /**
   * Both `secure.wrap` sites (instance and `withExecutionContext` view) route
   * here. Fails closed at wrap time: every intent is typed `SecureCache`, so
   * `.secure` exists on caches with no `encryption` configured, and this guard
   * is all that stands between a "secure" registration and plaintext at rest
   * (LAB-513). Deliberately no opt-in to run unencrypted — an escape hatch
   * under a security-labelled path is the downgrade this closes. Plaintext
   * callers use `wrap()`.
   */
  private secureWrap<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    options: WrapOptions,
    waitUntil?: WaitUntil
  ): (...args: TArgs) => Promise<TResult> {
    if (!this.encryption) {
      throw new ConfigurationError(
        'cache.secure.wrap() requires encryption, but this cache has none configured. ' +
          'Create it with createCache.secure() or pass `encryption` in CacheOptions; ' +
          'for unencrypted caching call cache.wrap() instead.'
      );
    }
    return this.wrap(fn, options, waitUntil);
  }

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
      secure: { wrap: (fn, options) => this.secureWrap(fn, options, waitUntil) },
      invalidate: (level, options) => this.invalidate(level, options),
      close: () => this.close(),
    };
  }

  async invalidate(
    level: 'global' | 'namespace' | 'params',
    options?: { namespace?: string; key?: string }
  ): Promise<void> {
    this.ensureNotClosed();

    if (level === 'namespace' && (typeof options?.namespace !== 'string' || !options.namespace)) {
      // Nothing to invalidate here and nothing a peer could act on, so this
      // would publish an event every subscriber must discard. Report it in
      // the process that made the call — the only one that can fix it —
      // rather than fanning a log line across the fleet.
      logError('[cachekit] invalidate("namespace") called with no namespace; nothing invalidated');
      return;
    }

    if (level === 'params' && (typeof options?.key !== 'string' || !options.key)) {
      logError('[cachekit] invalidate("params") called with no key; nothing invalidated');
      return;
    }

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
      } catch (err) {
        // Best-effort L2 invalidation - don't fail the operation, but don't
        // hide it either. The entry stays stale in L2 until its TTL, so name
        // it — by the same digest warnSetRejected logs, never the
        // caller-supplied key itself.
        logError(
          `[cachekit] invalidate("params") L2 delete failed (keyHash=${blake2b16Hex(options.key)}):`,
          describeDeleteFailure(err)
        );
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

    // Drop single-flight registrations (in-flight promises settle on their
    // own; callers already awaiting them get the result or a closed-backend
    // error)
    attempt(() => this.inflight.clear());

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

    // Release the envelope codecs (zeroizes/frees wasm resources on Workers;
    // no-op for the GC-managed NAPI binding)
    // envelopeReader is also nulled: a freed-but-dangling wasm codec behind a
    // non-null reference is an instant use-after-free for any future caller
    // that forgets the `closed` check. byteStorage is readonly and cannot be
    // nulled — its callers route through withEnvelopeCodec, which checks
    // `closed` before touching it.
    attempt(() => this.byteStorage?.free?.());
    attempt(() => {
      this.envelopeReader?.free?.();
      this.envelopeReader = null;
    });

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
      throw new BackendError('Cache has been closed', 'permanent');
    }
  }
}

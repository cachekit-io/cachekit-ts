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
import { L1Cache, type L1Entry } from './l1/lru-cache.js';
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
  ENVELOPE_REJECTIONS,
  looksLikeEnvelope,
  maxEnvelopeInputSize,
} from './serialization/envelope.js';
import {
  generateParamsHash,
  extractNamespace,
  blake2b16Hex,
} from './serialization/key-generator.js';
import { AutoKeys, type UnrefTimeout } from './serialization/auto-keys.js';
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
import { validateStaleTtl, validateTtl } from './backends/cachekitio.js';
import {
  DEFAULT_TTL_SECONDS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_WAIT_MS,
  DEFAULT_LOCK_POLL_MS,
  DEFAULT_MAX_DECODED_SIZE,
  SWR_REFRESH_MARKER_TTL_MS,
} from './constants.js';

/**
 * Minimum interval between repeats of each rate-limited warning. Each reports
 * an outcome the caller often never sees as an error, so the SDK reports it
 * through the logger — rate-limited so a hot key can't flood the sink.
 * Module-private on purpose: not a tuning knob.
 */
const WARN_INTERVAL_MS = 60_000;

/**
 * Bounds on a cache's pending L2 writes (write-behind, and on Node
 * stale-grace revalidation), matching cachekit-py's write_behind queue (64
 * entries, 16 MiB). A write-behind that would take the pending set past
 * either bound runs on the caller's path instead (tryWriteBehind); a
 * revalidation write is dropped (queueRevalidationWrite). Module-private on
 * purpose: not a tuning knob.
 */
const MAX_PENDING_WRITES = 64;
const MAX_PENDING_WRITE_BYTES = 16 * 1024 * 1024;

/**
 * How long an L2 op waits behind a key's pending write on a runtime that
 * cancels unregistered work (Workers), before it runs anyway. There a
 * pending write can never settle: workerd cancels a waitUntil past its 30 s
 * limit, and the continuation of a request that went away. Without a cap,
 * every later op on the key, and close(), would wait forever. Node needs
 * none: its backend timeouts settle every write. A write that never settles
 * also stays counted against the bound, so enough of them send later writes
 * to the caller's path: slower, never wrong.
 */
const KEY_WAIT_CAP_MS = 30_000;

/**
 * An L2 write taken off the caller's path: a wrap() cold miss with
 * `writeBehind` (the flight leader's waitUntil), or a stale-grace
 * revalidation's write. See setEntry.
 */
type DeferredWrite =
  { kind: 'write-behind'; waitUntil: WaitUntil | undefined } | { kind: 'revalidation' };

/**
 * What a write does to L1 (see setEntry): `fill` stores the value there;
 * `skip` leaves L1 alone (a wrap() call with skipL1, a stale-grace
 * revalidation); `refresh` is an SWR refresh, which leaves the L1 write to
 * completeRefresh's version check.
 */
type L1Mode = 'fill' | 'skip' | 'refresh';

/**
 * Sentinel for "the lock path did not resolve the miss — compute without
 * it". Distinct from null: the wrapped function may legitimately resolve
 * null, and conflating the two would compute twice under a held lock.
 */
const LOCK_FALLTHROUGH = Symbol('cachekit.lock-fallthrough');

/**
 * Out-parameter of getEntry for the reads of one wrap() call. A read given a
 * probe counts nothing in the hit/miss counters; the call counts its one
 * outcome (see wrapRead and computeAndStore).
 *
 * `cleanMiss` is set only where the backend itself answered "no entry".
 * getEntry returns null for a miss and for an absorbed read failure alike;
 * the lock path needs the difference, because after a failed read the entry
 * may still be live and the post-grant double-check is its only retry
 * (cachekit-py's probe_l2_miss). `servedBy` names the layer that served a
 * hit, and `stale` is set when L2 served it from the server's stale window.
 */
interface L2ReadProbe {
  cleanMiss: boolean;
  servedBy: 'l1' | 'l2' | null;
  stale: boolean;
}

/**
 * A wrap() call's server stale-grace (WrapOptions.staleTtl), passed to every
 * read and write of the call; null when the wrap does not opt in.
 */
interface StaleGrace {
  /** The stale window every write of the key re-sends (API-55). */
  readonly staleTtl: number;
  /**
   * Starts the key's background revalidation, or null where none can run
   * (Workers without a bound waitUntil): a stale hit is then a miss.
   */
  readonly revalidate: (() => void) | null;
}

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
   * wedging. Write-behind follows the same rule: without a handle, its L2
   * write stays on the caller's path. Unset on Node, where fire-and-forget
   * is safe.
   */
  swrRequiresWaitUntil?: boolean;
  /**
   * Run `callback` once, `ms` milliseconds from now, without holding the
   * process open, and return a function that cancels it. A wrapped function's
   * key memo needs one to empty itself on time (see AutoKeys), so a runtime
   * without one keeps no memo: Workers, which can cancel a timer when the
   * request that set it ends.
   */
  setUnrefTimeout?: UnrefTimeout;
}

/**
 * A key-free label for a failed L2 delete or write. Every field of a thrown error —
 * `cause`, `message`, `name`, even `classification` — is written by whoever
 * threw it and can embed the caller's key, so only literals are emitted and
 * `classification` is checked against its known values first. It is read
 * exactly once: a getter could pass the check and then return the key, or
 * throw and turn best-effort invalidation into a rejection.
 */
function describeBackendFailure(err: unknown): string {
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
  /** Lazily-created codec for envelope-tolerant reads on unencrypted
   * compression-off caches — see decodeEntry. */
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
  private readonly setUnrefTimeout: UnrefTimeout | undefined;
  /**
   * Mirrors ReliabilityExecutor's own default. Read directly by the
   * decode/encode paths that run outside the executor (L1 decrypt, L2 decode,
   * set encode), so they honour the same fail-open/fail-closed choice.
   */
  private readonly degradationEnabled: boolean;
  private closed = false;
  /** The first close()'s promise: every later call waits on the same drain. */
  private closing: Promise<void> | null = null;
  /** One in-flight cold-miss resolution per cache key (single-flight). */
  private readonly inflight = new Map<string, Promise<unknown>>();
  /**
   * Keys with a background revalidation of a server-stale hit in flight, or
   * held off after one stood down, to the time their marker lapses. The
   * marker expires (SWR_REFRESH_MARKER_TTL_MS) so a recompute that never
   * settles cannot stop the key revalidating for the life of the cache; a
   * lapsed marker only risks a duplicate revalidation.
   */
  private readonly revalidating = new Map<string, number>();
  /** revalidating size at which revalidate() next sweeps out lapsed markers. */
  private revalidatingPruneAt = 64;
  /**
   * The key memos of this cache's wrapped functions (see AutoKeys), held weakly
   * so that a wrapped function nobody holds takes its memo with it, once the
   * memo's pending timer has run: one second or less after it was set, though
   * it can run late (see AutoKeys).
   */
  private readonly keyMemos = new Set<WeakRef<AutoKeys>>();
  /** keyMemos size at which wrap() next drops the references to collected memos. */
  private keyMemosPruneAt = 64;
  private readonly stampede: Required<StampedeConfig>;
  private readonly lockable: LockableBackend | null;
  /**
   * Per key with a pending L2 write (write-behind, or on Node a stale-grace
   * revalidation), the promise that settles
   * when the last write or delete queued for that key settles (see
   * inKeyOrder). Never rejects. A key leaves the map once its tail settles.
   */
  private readonly keyTails = new Map<string, Promise<void>>();
  /** Pending L2 writes (write-behind and revalidation) not yet settled, and their bytes. */
  private pendingWrites = 0;
  private pendingWriteBytes = 0;
  /**
   * Per key, the L2 writes and deletes running on an idle key (no tail), so
   * not in keyTails. A write-behind of such a key is refused and runs on the
   * caller's path, concurrently, as with the option off: its early L1 fill
   * could otherwise land before the running op's later one, leaving L1
   * older than L2. Kept out of keyTails so that an op workerd cancels never
   * leaves a tail that never settles; a count it leaks only keeps that key's
   * writes on the caller's path.
   */
  private readonly keysInFlight = new Map<string, number>();

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

    // Initialize L1 cache (its maxMemory check throws ConfigurationError)
    this.l1 = options.l1?.enabled !== false ? new L1Cache(options.l1) : null;

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
    this.setUnrefTimeout = runtime.setUnrefTimeout;

    // Initialize ByteStorage (LZ4 compression + xxHash3-64 integrity). The
    // default honors the backend's advertised preference, else
    // true. An explicit option wins.
    const compressionEnabled = options.compression ?? this.backend.compressionDefault ?? true;
    this.byteStorage = compressionEnabled ? runtime.createByteStorage() : null;
    // Kept for lazy envelope-tolerant reads (see decodeEntry): a
    // compression-off cache still needs a codec the first time it meets an
    // enveloped entry.
    this.createByteStorage = () => runtime.createByteStorage();

    // Default TTL
    this.defaultTtl = options.defaultTtl ?? DEFAULT_TTL_SECONDS;

    // Initialize invalidation channel if config provided
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
        this.forgetKeyArguments();
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

  /** Timestamp of the last write-behind-failed warning (rate limiting). */
  private lastWriteBehindFailedWarnAt = 0;

  /** Timestamp of the last revalidation-failed warning (rate limiting). */
  private lastRevalidateFailedWarnAt = 0;

  /** Timestamp of the last revalidation-dropped warning (rate limiting). */
  private lastRevalidateDroppedWarnAt = 0;

  /**
   * Verified unpack of a suspected legacy/foreign ByteStorage envelope on an
   * unencrypted compression-off cache. Returns null when the bytes aren't treated as an
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
    if (envelopeVerdict(bytes, this.serializerConfig.maxDecodedSize) !== 'unpack') return null;

    // Codec construction stays OUTSIDE the try: a broken binding must fail
    // loudly (through getEntry's decode-failure path: counted, then a miss or
    // a rethrow per degradation), not be conflated with "not
    // an envelope" — that would silently serve raw envelope tuples, the
    // exact corruption this path exists to prevent.
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
   * not just size: depth, collection-size and binary-type
   * rejections, and the plain Error @msgpack/msgpack throws for a function or
   * BigInt, were all dropped silently before.
   */
  private warnSetRejected(key: string, error: unknown, interop: boolean): void {
    const now = Date.now();
    if (now - this.lastSetRejectedWarnAt < WARN_INTERVAL_MS) return;
    this.lastSetRejectedWarnAt = now;
    // Only a size rejection is fixed by raising a limit, and interop caps are
    // protocol constants serializer config does not govern — the remediation
    // hint only holds for a size rejection on the serializer path.
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
    // can at worst mislabel the rejection, never leak through it.
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
   * its deserialization errors can echo scalars from the cached value. The key
   * is digested for the same reason warnSetRejected gives.
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

  /**
   * Count and report a write-behind L2 write once it settles. The caller got
   * its value long before, so this line and the `write_behind` operation
   * counter are the only places a failure shows: degradation absorbed it,
   * and the breaker and the per-attempt `set` counters saw it as any write
   * failure. On Workers, with no Prometheus, the line is the only signal, so
   * it names the cause: the last attempt's error class, never its text
   * (describeBackendFailure), or the breaker when no attempt ran.
   * Rate-limited, and the key is digested, for the reasons warnSetRejected
   * gives. `heldInL1` is false when the write filled no L1 copy (L1 off, or
   * a skipL1 call), so the line does not claim one.
   */
  private writeBehindSettled(
    key: string,
    stored: boolean,
    lastError: unknown,
    heldInL1: boolean
  ): void {
    void this.metrics.recordOperation('write_behind', stored ? 'success' : 'error');
    if (stored) return;
    const now = Date.now();
    if (now - this.lastWriteBehindFailedWarnAt < WARN_INTERVAL_MS) return;
    this.lastWriteBehindFailedWarnAt = now;
    const cause =
      lastError === undefined
        ? 'not attempted: circuit breaker open'
        : describeBackendFailure(lastError);
    const held = heldInL1 ? "value held in this process's L1 only" : 'value not cached';
    logError(
      `[cachekit] write-behind L2 write failed, ${held} (keyHash=${blake2b16Hex(key)}): ${cause}.`
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
   * The cache key the encryption AAD binds: the key passed to the backend,
   * Backend.keyPrefix included, so ciphertext copied between two prefixes on
   * one store fails authentication. Interop caches reject any
   * prefix, so their AAD key stays the bare cross-SDK key.
   */
  private aadKey(key: string): string {
    return (this.backend.keyPrefix ?? '') + key;
  }

  /**
   * What L1 should hold for an entry: the same ciphertext L2 holds when the
   * cache is encrypted, the decoded value otherwise.
   *
   * Zero-knowledge is a property of every layer, not just the backend:
   * it is what cachekit-py does (its L1Cache stores bytes and
   * decrypts at read time) and cachekit-rs with it. Holding post-decrypt
   * plaintext here would put the entire L1 working set into any heap dump,
   * core dump, or Node diagnostic report for the full TTL, and that plaintext
   * would outlive the key release in close(), since L1 entries are held
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
  ): Promise<{ value: T; serializedSize: number; count: ObjectCount }> {
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
      // The AAD binds useEnvelope (frozen v0x03 set, protocol#12), so an entry
      // written under the other compression setting fails here — a loud,
      // counted decrypt failure, never a silent wrong decode. We deliberately
      // do NOT retry with the flipped flag: that would reintroduce exactly the
      // envelope-mode ambiguity the AAD binding exists to rule out.
      plaintext = await this.encryption.decrypt(plaintext, this.aadKey(key), useEnvelope);
    }
    if (useEnvelope) {
      const verdict = envelopeVerdict(plaintext, this.serializerConfig.maxDecodedSize);
      if (verdict !== 'unpack') {
        throw new SerializationError(
          `Stored bytes (${plaintext.length} B) ${ENVELOPE_REJECTIONS[verdict]}; refused before unpack`
        );
      }
      plaintext = this.withEnvelopeCodec((codec) => codec.unpack(plaintext));
    } else if (!interop && !this.encryption && looksLikeEnvelope(plaintext)) {
      // Envelope tolerance: a compression-off cache can read
      // entries a compression-on writer stored — same store, older SDK
      // default, or a mixed-version fleet mid-rollout. This is NOT optional
      // hygiene: the envelope is itself valid MessagePack (a positional
      // 4-tuple), so a plain decode would "succeed" and serve the envelope
      // structure as the cached value — silent corruption, invisible to
      // degradation. The unpack's xxHash3 check rejects ACCIDENTAL
      // look-alikes; it is keyless, so it is not a defense against an
      // adversarial writer deliberately crafting a valid envelope as its
      // cached value (an accepted risk). Its blast
      // radius is maxDecodedSize: envelopeVerdict bounds what unpack may
      // allocate before it runs, and maxDepth bounds the decode after it.
      // Bytes that are not an envelope core would accept, or that core
      // rejects, fall back to plain-serialized; an envelope over the ceiling
      // or an allocation failure throws.
      //
      // Unencrypted caches only: the protocol selects the post-decryption
      // container from the reader's configuration, never by sniffing the
      // decrypted bytes (spec/encryption.md).
      plaintext = this.tryUnwrapEnvelope(plaintext, key) ?? plaintext;
    }
    // The decode's depth pre-scan counts the heap objects and values on the
    // way, so L1 can charge for them without another walk (see L1Cache.set).
    const count: ObjectCount = { objects: 0, values: 0 };
    const value = interop
      ? decodeInteropValueCounted<T>(plaintext, count)
      : decodeCounted<T>(plaintext, this.serializerConfig, count);
    // The serialized length, not bytes.byteLength: that is the compressed
    // (and maybe encrypted) envelope, several times smaller, and charging L1
    // for it would let L1 grow well past maxMemory.
    return { value, serializedSize: plaintext.length, count };
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
   * at t=29s of a 30s entry re-populates L1 for 1s, not defaultTtl.
   * On CachekitIO the server's freshness headers bound it the
   * same way, and a stale read never re-populates L1. `readFreshness` asks
   * for those headers even with L1 off, so a stale-grace wrap sees the label.
   * `useL1` false (a wrap() call with skipL1) reads as if L1 were off: L1 is
   * neither read nor re-populated.
   */
  private async getEntry<T>(
    key: string,
    interop: boolean,
    ttlSeconds?: number,
    probe?: L2ReadProbe,
    readFreshness = false,
    useL1 = true
  ): Promise<T | null> {
    this.ensureNotClosed();
    const l1 = useL1 ? this.l1 : null;

    // Check L1 first. A secure cache holds ciphertext here, so the hit costs a
    // decrypt + AAD verify; an entry that fails to verify is dropped and this
    // falls through to L2 rather than serving or throwing.
    if (l1) {
      const l1Result = l1.get(key);
      if (l1Result !== null) {
        const decoded = await this.decodeL1Entry<T>(key, l1Result, interop);
        if (decoded !== null) {
          if (probe) probe.servedBy = 'l1';
          else this.recordHit('l1');
          return decoded.value;
        }
      }
    }

    // Reserved-key and key-size pre-flight — see Backend.validateKey and
    // EncryptionManagerCore.validateKey.
    this.backend.validateKey?.(key);
    this.encryption?.validateKey(this.aadKey(key), this.useEnvelope(interop));

    // Fetch from L2 (backend). Only the round trip runs inside the reliability
    // executor; decode runs after it. A decode or decrypt failure is a
    // deterministic property of the stored bytes (rotated key without
    // previousMasterKeys, an envelope-mode flip the AAD binds, a foreign or
    // corrupt entry): retrying re-fetches the same bytes and sleeps the backoff
    // for nothing, and the circuit breaker would count it as a backend failure
    // — five poisoned reads in a window would open the breaker and degrade
    // every key on this cache (the read-side mirror of set()'s encode bypass).
    // A first-use native-binding load failure inside decrypt is no longer
    // retried either; it self-heals on the next read (initPromise resets).
    const fetched = await this.run('get', key, null, async () => {
      // When L1 will be re-populated, prefer the TTL-carrying read (same
      // storage round trip — see Backend.getWithTtl); the bounds it returns
      // cap the L1 copy below.
      let data: Uint8Array | null;
      let l1Bound = Infinity;
      let isStale = false;
      if ((l1 || readFreshness) && this.backend.getWithTtl) {
        const result = await this.backend.getWithTtl(key);
        data = result?.value ?? null;
        l1Bound = Math.min(result?.ttlSeconds ?? Infinity, result?.freshFor ?? Infinity);
        isStale = result?.isStale === true;
      } else {
        data = await this.backend.get(key);
      }
      // The bounds count from receipt, not from the L1 write after decode.
      const receivedAt = Date.now();
      if (data === null) {
        if (probe) probe.cleanMiss = true;
        else this.recordMiss();
        return null;
      }
      return { data, l1Bound, isStale, receivedAt };
    });
    // A miss (counted above unless probed) or a backend failure degradation
    // absorbed.
    if (fetched === null) return null;
    const { data, l1Bound, isStale, receivedAt } = fetched;

    // Decrypt, unpack, deserialize — the same sequence an L1 hit runs. The
    // failure keeps the degradation contract it had inside the executor:
    // counted, then thrown with degradation off, a miss with it on.
    let value: T;
    let serializedSize: number;
    let count: ObjectCount;
    try {
      ({ value, serializedSize, count } = await this.decodeEntry<T>(data, key, interop));
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
    // from — and at the server's remaining freshness. A stale read
    // or a zero bound is never backfilled: the spec forbids local service of
    // it in any form, and L1's hard expiry is what keeps getWithSwr inside the
    // bound too (protocol spec/saas-api.md § Remaining Freshness).
    // The bound decays by the time spent since receipt: a slow decode (a cold
    // native load, a decrypt) must not restart the server's clock.
    if (l1 && !isStale) {
      const namespace = interop ? key.slice(0, key.indexOf(':')) : extractNamespace(key);
      const capSeconds = ttlSeconds ?? this.defaultTtl;
      // ttl <= 0 means "no expiry" (ts-wide Backend contract) — treat it
      // as infinite here so Math.min still caps to a real l1Bound
      // when the backend reports one, instead of collapsing to 0 and
      // tripping the skip-guard below for an entry that should never
      // expire in L1.
      const capOrForever = capSeconds > 0 ? capSeconds : Infinity;
      const l1TtlSeconds = Math.min(capOrForever, l1Bound - (Date.now() - receivedAt) / 1000);
      if (l1TtlSeconds > 0) {
        // Hand L1 its own canonical no-expiry encoding (ttl <= 0), never
        // Infinity ms: an Infinity originalTtl turns getWithSwr's
        // freshness check into `Infinity > Infinity` — permanently stale,
        // arming a spurious background refresh per marker window, forever.
        const l1TtlMs = Number.isFinite(l1TtlSeconds) ? l1TtlSeconds * 1000 : 0;
        l1.set(key, this.l1Payload(value, data), l1TtlMs, namespace, serializedSize, count);
        this.publishL1Stats();
      }
    }

    if (probe) {
      probe.servedBy = 'l2';
      probe.stale = isStale;
    } else this.recordHit('l2');
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
   * Null when the value failed to encode, when an encrypted cache
   * produced no ciphertext, when a Workers SWR refresh is skipped because
   * the key has a write pending (see below), and when a revalidation write
   * is dropped (see queueRevalidationWrite). A positive `staleTtl` (a
   * stale-grace wrap, checked at wrap time) rides the write as the server's
   * stale window.
   *
   * `deferred` takes the L2 write off the caller's path: a wrap() cold miss
   * with `writeBehind` on fills L1 first (unless `l1Mode` is `skip`) and
   * returns without waiting for the L2 write, when tryWriteBehind() takes it;
   * a stale-grace revalidation queues its write (queueRevalidationWrite).
   */
  private async setEntry<T>(
    key: string,
    value: T,
    options: SetOptions | undefined,
    interop: boolean,
    l1Mode: L1Mode = 'fill',
    staleTtl = 0,
    deferred?: DeferredWrite
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
    this.encryption?.validateKey(this.aadKey(key), useEnvelope);

    // Serialize before the reliability executor. An encode rejection is a
    // deterministic caller error: retrying it re-encodes the same value for
    // nothing, and the circuit breaker would count it as a backend failure —
    // five oversized values in a window would open the breaker and degrade
    // every key on this cache. Interop rejection always throws
    // (spec: values outside the data model MUST error). Auto-mode rejection
    // keeps the degradation contract it had inside the executor: counted,
    // then thrown with degradation off, absorbed with it on — never written
    // to L2, nor to L1: the refresh path gets null, as a direct write and a
    // cold miss store nothing for this value either. L1 could only charge it
    // the JSON estimate, which under-counts the object-heavy values an encode
    // most often rejects (too many entries, too deep), and a refill would keep
    // renewing it for as long as reads keep it stale. An auto-mode
    // rejection, or an interop size rejection, emits one rate-limited warning
    // either way.
    // Normalizing (auto mode) and the header encoders (interop) count the
    // heap objects and values on the way, so L1 can charge for them without
    // another walk.
    const count: ObjectCount = { objects: 0, values: 0 };
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
      return null;
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
      if (this.encryption)
        data = await this.encryption.encrypt(data, this.aadKey(key), useEnvelope);
    } catch (error) {
      this.recordFailure('set', error);
      if (!this.degradationEnabled) throw error;
      this.warnSetEncryptFailed(key, error);
      // The value did serialize, so L1 can charge it honestly, as it charges a
      // degraded backend write. Only the SWR refresh path stores this; a
      // direct write returns before its L1 update. An encrypted cache's L1
      // holds only ciphertext, so it gets nothing.
      return this.encryption ? null : { l1: value, serializedSize: serialized.length, count };
    }
    // Exists before the backend write, so a write that the breaker skips or
    // degradation absorbs still yields it. Otherwise an encrypted cache's SWR
    // refresh gets nothing to store, the stale entry stays, and the refresh
    // re-runs the origin once per refresh-marker window.
    const l1Write: L1Write = {
      l1: this.l1Payload(value, data),
      serializedSize: serialized.length,
      count,
    };

    // The L2 write, under retry, the breaker and degradation; the stale
    // window rides it on a stale-grace wrap.
    const writeL2 = (): Promise<void> =>
      staleTtl > 0
        ? this.backend.setWithStaleTtl!(key, data, ttl, staleTtl)
        : this.backend.set(key, data, ttl);

    // A stale-grace revalidation never fills L1 (its l1Mode is skip), and may
    // be dropped: the stale entry still serves.
    if (deferred?.kind === 'revalidation') {
      const queued = this.queueRevalidationWrite(key, data.length, writeL2);
      if (queued === null) return null;
      await queued;
      return l1Write;
    }

    // Write-behind: L1 is filled as the write starts, before its PUT is sent
    // (the PUT goes out after the reliability stack's first await), so this
    // process serves the value while the write is pending. Encode and encrypt
    // above stay on the caller's path, so their errors still reach it, and L1
    // holds the bytes the write sends. If the background write fails, L1
    // keeps the value, as it keeps a degraded write's below. A write sent
    // back to the caller fills L1 after its L2 write, as with the option off.
    // A skipL1 call fills L1 in neither case, so until its write lands this
    // process misses the key.
    const fillsL1 = l1Mode === 'fill' && this.l1 !== null;
    const wroteBehind =
      deferred?.kind === 'write-behind' &&
      this.tryWriteBehind(key, data.length, writeL2, deferred.waitUntil, fillsL1);
    if (wroteBehind) {
      if (l1Mode === 'fill') this.fillL1(key, l1Write, ttl, namespace);
      return l1Write;
    }

    // An SWR refresh (l1Mode refresh) on Workers runs inside its request's
    // waitUntil, which workerd caps at 30 s: queued behind a key's pending
    // write it would wait out KEY_WAIT_CAP_MS and be cancelled as it sends,
    // leaving its marker stranded and a new tail that never settles. Skip
    // it; null makes the refresh manager defer the key (one retry a minute).
    if (l1Mode === 'refresh' && this.swrRequiresWaitUntil && this.keyTails.has(key)) return null;

    // Update L1 for direct writes — after `run`, so a backend write that
    // degradation absorbed still fills it, as cachekit-py's sync path does.
    // Otherwise every wrap() during an L2 outage or a 401/403 recomputes the
    // origin and re-pays the doomed round trips. With degradation off `run`
    // throws and L1 stays empty. On an encrypted cache L1 gets the ciphertext,
    // never the caller's plaintext. The fill runs inside the op inKeyOrder
    // tracks, so the key stays pending or in flight until L1 holds this
    // value: a write-behind admitted between this L2 write and its L1 fill
    // would publish a newer value that this fill then overwrites. The SWR
    // refresh path passes l1Mode refresh
    // and writes L1 only through completeRefresh, whose version token discards
    // the refresh if an explicit write or invalidation landed meanwhile — the
    // guard is authoritative for L1 ONLY. The backend.set above is
    // unconditional last-write-wins: an interleaved explicit set() survives in
    // L1 but is overwritten in L2 by the refresh's value until the entry next
    // expires or refreshes (a conditional L2 write would need CAS the Backend
    // contract doesn't have).
    await this.inKeyOrder(key, async () => {
      await this.run('set', key, undefined, writeL2);
      if (l1Mode === 'fill') this.fillL1(key, l1Write, ttl, namespace);
    });

    return l1Write;
  }

  private fillL1(key: string, l1Write: L1Write, ttl: number, namespace: string): void {
    if (!this.l1) return;
    this.l1.set(key, l1Write.l1, ttl * 1000, namespace, l1Write.serializedSize, l1Write.count);
    this.publishL1Stats();
  }

  /**
   * Start `key`'s L2 write in the background and return true, or start
   * nothing and return false when the write must stay on the caller's path:
   * the key already has a write or delete pending or in flight, or the
   * runtime cancels unregistered work (Workers) and no waitUntil is bound,
   * or registering with it throws, or the write would take the pending
   * writes past the bound (queueFull). A write sent back to the
   * caller waits behind the key's pending ops (inKeyOrder), so the older
   * value can never land last.
   *
   * A background write never queues behind another op. Queued, it would
   * fill L1 before ops queued ahead of it that fill L1 after their L2 write,
   * leaving L1 older than L2; and on Workers it would wait out
   * KEY_WAIT_CAP_MS inside its own 30 s waitUntil budget and be cancelled as
   * it sends. Every later write or delete of the key queues behind it, so a
   * set(), delete() or invalidate('params') issued after wrap() returns is
   * not overtaken. close() waits for it. Its outcome is counted and a
   * failure reported (writeBehindSettled); it never rejects.
   */
  private tryWriteBehind(
    key: string,
    bytes: number,
    writeL2: () => Promise<void>,
    waitUntil: WaitUntil | undefined,
    heldInL1: boolean
  ): boolean {
    // After close() began, the drain may already have run: a write started
    // now would outlive it.
    if (this.closed || this.keyTails.has(key) || this.keysInFlight.has(key)) return false;
    if (this.swrRequiresWaitUntil && !waitUntil) return false;
    if (this.queueFull(bytes)) return false;
    // Register before starting, so a stale ctx (waitUntil throws) sends the
    // write back to the caller instead of leaving it to be cancelled.
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    if (waitUntil) {
      try {
        waitUntil(settled);
      } catch (error) {
        logError(
          '[cachekit] Failed to register write-behind with waitUntil, writing in the foreground:',
          error instanceof Error ? error.message : 'Unknown error'
        );
        return false;
      }
    }

    // The fallback tells a write degradation absorbed from one that landed;
    // lastError keeps the cause degradation discards.
    let lastError: unknown;
    const send = (): Promise<boolean> =>
      this.run('set', key, false, async () => {
        try {
          await writeL2();
        } catch (error) {
          lastError = error;
          throw error;
        }
        return true;
      });
    void this.startPendingWrite(key, bytes, () =>
      send()
        .then(
          (stored) => this.writeBehindSettled(key, stored, lastError, heldInL1),
          (error: unknown) => this.writeBehindSettled(key, false, error, heldInL1)
        )
        .finally(settle)
    );
    return true;
  }

  /** Would a background write of `bytes` take the pending writes past the bound? */
  private queueFull(bytes: number): boolean {
    return (
      this.pendingWrites >= MAX_PENDING_WRITES ||
      this.pendingWriteBytes + bytes > MAX_PENDING_WRITE_BYTES
    );
  }

  /**
   * Count a background write against the bound until it settles, and make
   * it the key's tail. The one place the pending counters move, so the two
   * kinds of background write cannot drift apart.
   */
  private startPendingWrite<T>(key: string, bytes: number, start: () => Promise<T>): Promise<T> {
    this.pendingWrites++;
    this.pendingWriteBytes += bytes;
    const write = start().finally(() => {
      this.pendingWrites--;
      this.pendingWriteBytes -= bytes;
    });
    this.setKeyTail(key, write);
    return write;
  }

  /**
   * Would a revalidation of `key` be dropped before it writes? Checked before
   * its lease and its recompute, so a full queue costs no origin call: the
   * write count (the byte bound needs the value, and is checked again when
   * the write is queued), and on Workers a key with an op queued.
   */
  private revalidationWouldDrop(key: string): boolean {
    return (
      this.pendingWrites >= MAX_PENDING_WRITES ||
      (this.swrRequiresWaitUntil && this.keyTails.has(key))
    );
  }

  /**
   * Count a dropped revalidation write and report it, rate-limited, by key
   * digest. Workers has no Prometheus, so the line is its only trace there.
   */
  private revalidationDropped(key: string): void {
    void this.metrics.recordOperation('revalidate_dropped', 'error');
    const now = Date.now();
    if (now - this.lastRevalidateDroppedWarnAt < WARN_INTERVAL_MS) return;
    this.lastRevalidateDroppedWarnAt = now;
    logError(
      `[cachekit] stale revalidation dropped, the stale value stays: the write queue is full or the key has a write queued (keyHash=${blake2b16Hex(key)}).`
    );
  }

  /**
   * Queue a stale-grace revalidation's L2 write and return the promise of it
   * settling, or drop it (revalidationDropped) and return null. Unlike a
   * write-behind it may be dropped, because the stale entry still serves and
   * a later stale read revalidates again: it is dropped when the pending
   * writes would pass the bound (queueFull), after close() began, and on
   * Workers when the key has an op queued. It is never put on a caller's
   * path: the revalidation runs in the background already.
   *
   * On Node it queues behind the key's pending ops (it fills no L1, so
   * queuing cannot leave L1 older than L2), counts against the bound, and
   * becomes the key's tail: a later set(), delete() or invalidate('params')
   * orders after it, and close() drains it.
   *
   * On Workers it runs as an idle-key op does, counted in keysInFlight only:
   * it starts after the lease and the recompute, inside the stale reader's
   * one 30 s waitUntil budget, so workerd can cancel it. As a tail it would
   * then never settle and stall every later op on the key; counted against
   * the bound, its slot would leak. So on Workers it is unordered against a
   * later op and not drained by close(), as before write-behind existed.
   *
   * Either way the revalidation awaits it, so its server lease is released
   * only after this PUT settles.
   */
  private queueRevalidationWrite(
    key: string,
    bytes: number,
    writeL2: () => Promise<void>
  ): Promise<void> | null {
    if (
      this.closed ||
      this.queueFull(bytes) ||
      (this.swrRequiresWaitUntil && this.keyTails.has(key))
    ) {
      this.revalidationDropped(key);
      return null;
    }
    const send = (): Promise<void> => this.run('set', key, undefined, writeL2);
    // On Workers no tail exists here (checked above), so inKeyOrder counts it in flight.
    if (this.swrRequiresWaitUntil) return this.inKeyOrder(key, send);
    return this.startPendingWrite(key, bytes, () => {
      const tail = this.keyTails.get(key);
      return tail ? tail.then(send) : send();
    });
  }

  /**
   * Run an L2 write or delete of `key` after everything already queued for
   * the key, and make it the key's new tail. An op on an idle key runs at
   * once, as before write-behind existed, counted in keysInFlight while it
   * runs.
   */
  private inKeyOrder<T>(key: string, op: () => Promise<T>): Promise<T> {
    const tail = this.keyTails.get(key);
    if (tail === undefined) return this.countInFlight(key, op);
    const result = this.afterTail(tail).then(op);
    this.setKeyTail(key, result);
    return result;
  }

  private countInFlight<T>(key: string, op: () => Promise<T>): Promise<T> {
    this.keysInFlight.set(key, (this.keysInFlight.get(key) ?? 0) + 1);
    const release = (): void => {
      const left = (this.keysInFlight.get(key) ?? 1) - 1;
      if (left > 0) this.keysInFlight.set(key, left);
      else this.keysInFlight.delete(key);
    };
    let running: Promise<T>;
    try {
      running = op();
    } catch (error) {
      release();
      throw error;
    }
    return running.finally(release);
  }

  /** A key's tail, capped at KEY_WAIT_CAP_MS where it may never settle. */
  private afterTail(tail: Promise<void>): Promise<void> {
    if (!this.swrRequiresWaitUntil) return tail;
    return Promise.race([tail, sleep(KEY_WAIT_CAP_MS)]);
  }

  private setKeyTail(key: string, op: Promise<unknown>): void {
    const tail = op.then(
      () => {},
      () => {}
    );
    this.keyTails.set(key, tail);
    void tail.then(() => {
      if (this.keyTails.get(key) === tail) this.keyTails.delete(key);
    });
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
      return await this.inKeyOrder(key, () =>
        this.run('delete', key, false, () => this.backend.delete(key))
      );
    } finally {
      if (this.l1) {
        this.l1.invalidateByKey(key);
        this.publishL1Stats();
      }
      this.forgetKeyArguments();
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
   * refreshes triggered by the wrapped function, the distributed lock's
   * release, and write-behind L2 writes ride the platform's background-work
   * registration instead of firing fire-and-forget.
   */
  wrap<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    options: WrapOptions,
    waitUntil?: WaitUntil
  ): (...args: TArgs) => Promise<TResult> {
    const interopOperation = options.interop;
    const interop = interopOperation !== undefined;
    const interopArity = options.interopArity;
    if (options.writeBehind && !this.degradationEnabled) {
      // With degradation off a failed L2 write must reach the caller, and a
      // write the caller no longer waits for cannot.
      throw new ConfigurationError(
        'writeBehind requires reliability.degradation (on by default): a background L2 write ' +
          'cannot report its failure to the caller'
      );
    }
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
      // every cross-SDK access silently misses, and the encryption AAD would
      // bind a prefixed key no other SDK computes.
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

    const staleTtl = this.resolveStaleTtl(options);

    // A cache that encrypts keeps no plaintext argument, and with L1 off a
    // memoised key would save nothing a network call does not dwarf. A memo also
    // needs the runtime's timer to empty itself on time; without one it keeps none.
    const autoKeys = new AutoKeys<L1Entry<unknown>>(
      !interop && !this.encryption && this.l1 !== null ? this.setUnrefTimeout : undefined
    );
    if (autoKeys.memoising) this.trackKeyMemo(autoKeys);
    return async (...args: TArgs): Promise<TResult> => {
      // First, and before keying in particular: keying puts the arguments in the
      // key memo, which close() has emptied, and only the timer of a new window
      // would empty it again. The flag is read here because calling
      // ensureNotClosed() on every call cost an L1 hit about 100 instructions,
      // measured.
      if (this.closed) this.ensureNotClosed();
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
      // The options are the caller's object, so reading one can run the
      // caller's code (a getter): read them before the clock, not after.
      const namespace = options.namespace;
      const useL1 = !options.skipL1;
      const ttl = options.ttl ?? this.defaultTtl;
      // `now` serves only the memo's window and a held-entry hit; no caller
      // code runs between this read and either (primitive arguments only).
      const now = Date.now();
      const slot = interop ? undefined : autoKeys.slot(namespace, args, useL1, ttl, now);
      const cacheKey = interop ? generateInteropKey(namespace, interopOperation, args) : slot!.key;

      // A memoised call holds the L1 entry it was last served from: while L1
      // still holds that entry and it is above its SWR jitter band, serve it on that one check,
      // with no lookup by key. Only a memo keeps an entry, and a memo means an
      // unencrypted cache with L1 on, so the stored object is the value.
      const held = slot?.entry;
      if (held !== undefined && this.l1!.hit(held, now)) {
        this.recordHit('l1');
        return held.value as TResult;
      }

      // Check L1 with SWR. On platforms that cancel fire-and-forget work at
      // response return (Workers), SWR only runs when a per-request
      // waitUntil handle is bound — otherwise fall back to a plain L1 read:
      // no refresh marker is taken, so nothing can wedge, and the entry
      // simply expires and recomputes in the request path (fail-safe
      // no-SWR).
      if (this.l1 && useL1) {
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
          // getWithSwr reads the clock itself: keying a call in full can run
          // the caller's code (an object argument's getters), so `now` may be
          // stale here.
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
                  // A JavaScript caller can omit the typed-required ttl; resolve it as
                  // setEntry does, or the refreshed L1 copy gets NaN ms and never expires.
                  { ttl: options.ttl ?? this.defaultTtl, namespace: options.namespace },
                  swrResult.versionToken,
                  this.l1,
                  // The refresh re-sends the stale window: a PUT replaces the
                  // entry's timing metadata whole (API-55).
                  (key, value, opts) =>
                    this.setEntry(
                      key,
                      value,
                      { ttl: opts.ttl, namespace: opts.namespace },
                      interop,
                      'refresh',
                      staleTtl
                    ),
                  waitUntil
                );
              }
              // Hold the entry for the memo's next call (see above). A call the
              // memo does not keep (an object argument, say) has a slot of its
              // own, discarded with the entry: one Map lookup, against the key
              // generation that call has already paid for.
              if (autoKeys.memoising) slot!.entry = this.l1.entry(cacheKey);
              this.recordHit('l1');
              return decoded.value;
            }
          }
        }
      }

      // Cold path (L1 miss): single-flight per key per process. The flight
      // covers the L2 read too, not just the compute — the L2 GET-miss is
      // the billed event under metered-misses, so N concurrent cold callers
      // must share one read, one compute, and one write.
      const existing = this.inflight.get(cacheKey);
      if (existing) {
        // Served in process without a backend request, as cachekit-py
        // counts a joined caller: one L1 hit. A flight that rejects counts
        // nothing for its joiners.
        const joined = (await existing) as TResult;
        this.recordHit('l1');
        return joined;
      }
      const flight = this.resolveMiss<TResult>(
        cacheKey,
        interop,
        () => fn(...args),
        options,
        staleTtl,
        waitUntil
      );
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
   * `waitUntil` is the flight leader's: the herd shares one lock, so its
   * release rides the request that took it, as does a revalidation of a
   * server-stale hit (`staleTtl` > 0, see wrapRead).
   */
  private async resolveMiss<TResult>(
    cacheKey: string,
    interop: boolean,
    compute: () => Promise<TResult>,
    options: WrapOptionsBase,
    staleTtl: number,
    waitUntil?: WaitUntil
  ): Promise<TResult> {
    // Workers cancel unregistered background work at response return, so
    // without a bound waitUntil there is no revalidation: fail safe to the
    // plain miss path (the same rule as L1 SWR, see swrRequiresWaitUntil).
    const grace: StaleGrace | null =
      staleTtl > 0
        ? {
            staleTtl,
            revalidate:
              this.swrRequiresWaitUntil && !waitUntil
                ? null
                : () => this.revalidate(cacheKey, interop, compute, options, staleTtl, waitUntil),
          }
        : null;
    const read: L2ReadProbe = { cleanMiss: false, servedBy: null, stale: false };
    const cached = await this.wrapRead<TResult>(cacheKey, interop, options, grace, read);
    if (cached !== null) {
      return cached;
    }

    if (this.lockable && this.stampede.distributedLock) {
      const locked = await this.resolveUnderLock<TResult>(
        cacheKey,
        interop,
        compute,
        options,
        grace,
        read.cleanMiss,
        waitUntil
      );
      if (locked !== LOCK_FALLTHROUGH) {
        return locked;
      }
    }

    // Not under the lock: write-behind applies here, also after the lock fell
    // through, since no lease is held.
    return this.computeAndStore(
      cacheKey,
      interop,
      compute,
      options,
      staleTtl,
      options.writeBehind ? { kind: 'write-behind', waitUntil } : undefined
    );
  }

  /**
   * Cross-process miss arbitration, mirroring cachekit-py's miss path
   * (wrapper.py): acquire → double-check L2 → compute → write → release.
   * The double-check is skipped when the first acquire won after a clean
   * miss: nobody held the lock when we asked, so the GET would almost always
   * miss again, and be billed as one. A fill that landed between our miss
   * and our grant is recomputed; last write wins (spec saas-api.md:
   * duplicate fills are benign). After a waited grant or a failed first read
   * the double-check stays. cachekit-py skips it on CachekitIO only; ts skips
   * it on every lockable backend, Redis included. acquireLock never blocks on contention, so
   * "waiting" is retrying the lock on an interval bounded by lockWaitMs —
   * deliberately NOT polling get(), because on a metered-misses backend
   * every poll GET against a still-cold key is itself a billed miss,
   * while contested lock calls are not.
   *
   * Returns LOCK_FALLTHROUGH when the lock never resolved the miss
   * (acquire error, or contested past the wait budget): the lease is
   * best-effort stampede mitigation, never a correctness gate, so lock
   * failure degrades to computing without it. The write stays on the
   * caller's path while the lease is held, write-behind or not, as
   * cachekit-py's locked path writes inside its lock: a write deferred past
   * the release would send each waiter's double-check to an empty L2, and
   * each would recompute. Once we have waited on a
   * holder (the deadline exit, or an acquire error after a contested
   * attempt), L2 is read once more first, as cachekit-py does after its lock
   * wait times out: the holder has usually written by then. An acquire error
   * on the first attempt comes straight after our own miss, so it does not
   * re-read.
   */
  private async resolveUnderLock<TResult>(
    cacheKey: string,
    interop: boolean,
    compute: () => Promise<TResult>,
    options: WrapOptionsBase,
    grace: StaleGrace | null,
    cleanMiss: boolean,
    waitUntil?: WaitUntil
  ): Promise<TResult | typeof LOCK_FALLTHROUGH> {
    const lockable = this.lockable!;
    const { lockTimeoutMs, lockWaitMs, lockPollMs } = this.stampede;
    const deadline = Date.now() + lockWaitMs;
    const recheck = async (): Promise<TResult | typeof LOCK_FALLTHROUGH> => {
      const filled = await this.wrapRead<TResult>(cacheKey, interop, options, grace);
      return filled !== null ? filled : LOCK_FALLTHROUGH;
    };

    for (let attempt = 0; ; attempt++) {
      let lockId: string | null;
      try {
        // Deliberately outside the reliability executor: retry would stack
        // latency onto a best-effort call, and counting lock failures
        // against the circuit breaker could open it for data operations.
        lockId = await lockable.acquireLock(cacheKey, lockTimeoutMs);
      } catch {
        return attempt === 0 ? LOCK_FALLTHROUGH : recheck();
      }

      if (lockId !== null) {
        try {
          // Double-check: the holder we waited on may have written
          // between our miss and this grant — one GET that hits, instead
          // of a duplicate compute + write. After a failed first read it
          // retries that read instead. Skipped after an uncontended grant
          // on a clean miss (see above).
          // A stale double-check is a miss here: we hold the lease, so this
          // call is the revalidation, and a background one would contend with
          // our own lease and stand down.
          if (attempt > 0 || !cleanMiss) {
            const filled = await this.wrapRead<TResult>(
              cacheKey,
              interop,
              options,
              grace && { ...grace, revalidate: null }
            );
            if (filled !== null) {
              return filled;
            }
          }
          return await this.computeAndStore(
            cacheKey,
            interop,
            compute,
            options,
            grace?.staleTtl ?? 0
          );
        } finally {
          // Best-effort; the lease auto-expires. On Workers an unregistered
          // release can be cancelled at response return, so register it. A
          // stale ctx makes waitUntil throw, which must not replace the result.
          const release = lockable.releaseLock(cacheKey, lockId).catch(() => {});
          try {
            waitUntil?.(release);
          } catch (error) {
            logError(
              '[cachekit] Failed to register lock release with waitUntil:',
              error instanceof Error ? error.message : 'Unknown error'
            );
          }
        }
      }

      if (Date.now() + lockPollMs > deadline) {
        return recheck();
      }
      await sleep(lockPollMs);
    }
  }

  /**
   * One read of a wrap() call (the first L2 read, the post-grant
   * double-check, the deadline re-check). The read counts nothing itself: a
   * hit counts the call's one outcome, by the layer that served it, and a
   * call that finds nothing counts its one miss in computeAndStore.
   *
   * Under stale-grace, a hit L2 served from its stale window (protocol
   * spec/saas-api.md § Reading a stale entry) is returned at once and starts
   * the key's revalidation; it counts as an L2 hit. Where no revalidation can
   * run, it is a miss (not a clean one) and the call computes. A wrap without
   * stale-grace serves stale bytes as an ordinary hit, as before; either way
   * getEntry never backfills L1 from a stale read. A skipL1 call's read
   * neither reads L1 nor backfills it.
   */
  private async wrapRead<TResult>(
    cacheKey: string,
    interop: boolean,
    options: WrapOptionsBase,
    grace: StaleGrace | null,
    probe: L2ReadProbe = { cleanMiss: false, servedBy: null, stale: false }
  ): Promise<TResult | null> {
    const value = await this.getEntry<TResult>(
      cacheKey,
      interop,
      options.ttl,
      probe,
      grace !== null,
      !options.skipL1
    );
    if (value === null) return null;
    if (probe.stale && grace) {
      if (!grace.revalidate) return null;
      grace.revalidate();
    }
    if (probe.servedBy !== null) this.recordHit(probe.servedBy);
    return value;
  }

  private async computeAndStore<TResult>(
    cacheKey: string,
    interop: boolean,
    compute: () => Promise<TResult>,
    options: WrapOptionsBase,
    staleTtl: number,
    deferred?: DeferredWrite
  ): Promise<TResult> {
    // The call runs the function: its one miss, counted before the write so
    // the write's telemetry headers carry it.
    this.recordMiss();
    const result = await compute();
    await this.setEntry(
      cacheKey,
      result,
      { ttl: options.ttl, namespace: options.namespace },
      interop,
      options.skipL1 ? 'skip' : 'fill',
      staleTtl,
      deferred
    );
    return result;
  }

  /**
   * The wire stale window for a wrap() that sets `staleTtl`, or 0 when it is
   * off. Checked at wrap time so a misconfiguration fails at registration, not
   * on the first stale read: refused on an encrypted cache, where TTL is often
   * a revocation boundary (spec: such caches SHOULD NOT set a stale window),
   * and on a backend that cannot both write the window and report a stale
   * read (Backend.setWithStaleTtl).
   */
  private resolveStaleTtl(options: WrapOptionsBase): number {
    const staleTtl = options.staleTtl;
    if (staleTtl === undefined || staleTtl === 0) return 0;
    if (this.encryption) {
      throw new ConfigurationError(
        'staleTtl is refused on an encrypted cache: a stale window serves values past their TTL, ' +
          'and on a secure cache the TTL is often a revocation boundary. Remove staleTtl.'
      );
    }
    if (!this.backend.setWithStaleTtl || !this.backend.getWithTtl) {
      throw new ConfigurationError(
        'staleTtl requires a backend that writes a stale window and reports stale reads ' +
          '(CachekitIO); the configured backend has no setWithStaleTtl/getWithTtl'
      );
    }
    return validateStaleTtl(staleTtl, validateTtl(options.ttl ?? this.defaultTtl));
  }

  /**
   * Start the background revalidation of a server-stale hit, one at a time
   * per key in this cache; a revalidation still running after
   * SWR_REFRESH_MARKER_TTL_MS no longer blocks a new one (protocol
   * spec/saas-api.md § Revalidation flow). On a
   * lock-capable backend it runs only under the server lease: a contested
   * lease means another client is revalidating, so this one stands down
   * without waiting or retrying (API-62). The revalidation re-sends the TTL
   * and stale window (API-55), counts no miss (API-63), and on failure leaves
   * the entry as it was: a later stale read tries again, until the store
   * evicts the entry. Its write skips L1, which holds no copy of the key (a
   * stale read is never backfilled): a delete, invalidation or explicit set()
   * during the recompute must not be overwritten there, and L1's version
   * token cannot see a delete of an absent key. The next read takes the fresh
   * entry from L2, bounded by its Fresh-For.
   */
  private revalidate<TResult>(
    cacheKey: string,
    interop: boolean,
    compute: () => Promise<TResult>,
    options: WrapOptionsBase,
    staleTtl: number,
    waitUntil?: WaitUntil
  ): void {
    const now = Date.now();
    if ((this.revalidating.get(cacheKey) ?? 0) > now) return;
    // A lapsed hold is not deleted when it lapses, so sweep before growing:
    // otherwise every key ever read stale while another client held the lease
    // would keep an entry for the life of the cache. Doubling the threshold
    // keeps the sweep amortised O(1) per insert.
    if (this.revalidating.size >= this.revalidatingPruneAt) {
      for (const [key, until] of this.revalidating) if (until <= now) this.revalidating.delete(key);
      this.revalidatingPruneAt = Math.max(64, 2 * this.revalidating.size);
    }
    const marker = now + SWR_REFRESH_MARKER_TTL_MS;
    this.revalidating.set(cacheKey, marker);
    // Started here, in the request that read the stale entry: on workerd the
    // revalidation's I/O belongs to the request whose waitUntil it rides.
    const task = this.runRevalidation(cacheKey, interop, compute, options, staleTtl).then((ran) => {
      // A revalidation that outlived its marker leaves a newer one alone.
      if (this.revalidating.get(cacheKey) !== marker) return;
      // One that stood down (another client holds the lease) or could not
      // reach the lock endpoint holds the key off for as long as that lease
      // can last: otherwise every stale read of a hot key would send
      // another lock request the server turns away.
      if (ran) this.revalidating.delete(cacheKey);
      else
        this.revalidating.set(
          cacheKey,
          Date.now() + Math.min(this.stampede.lockTimeoutMs, SWR_REFRESH_MARKER_TTL_MS)
        );
    });
    // The task never rejects. A stale ctx makes waitUntil throw, which must
    // cost only this revalidation, never the read that has a value to return.
    try {
      waitUntil?.(task);
    } catch (error) {
      logError(
        '[cachekit] Failed to register stale revalidation with waitUntil:',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /** Resolves false when nothing was written by design: the lease was
   * contested or the lock endpoint unreachable, or the write was dropped (a
   * full queue, or on Workers a key with an op queued). A recompute or write
   * that failed still resolves true, so a later stale read retries it at once
   * rather than after a lease-length hold. */
  private async runRevalidation<TResult>(
    cacheKey: string,
    interop: boolean,
    compute: () => Promise<TResult>,
    options: WrapOptionsBase,
    staleTtl: number
  ): Promise<boolean> {
    // Dropped before the lease and the recompute when its write would be:
    // under a full queue every stale read of a hot key would otherwise take
    // the lease, run the origin and throw the result away.
    if (this.revalidationWouldDrop(cacheKey)) {
      this.revalidationDropped(cacheKey);
      return false;
    }
    const lockable = this.lockable;
    let lockId: string | null = null;
    let ran = true;
    if (lockable) {
      try {
        // acquireLock returns a lease only for a non-empty lock_id (API-65).
        lockId = await lockable.acquireLock(cacheKey, this.stampede.lockTimeoutMs);
      } catch (error) {
        // Not contention, and not a failed revalidation: this attempt is
        // abandoned (API-62) and counted, never logged per stale read.
        if (!this.closed) this.recordFailure('lock_acquire', error);
        return false;
      }
      if (lockId === null) return false;
    }
    try {
      const result = await compute();
      // Null when the write was dropped (or the value would not encode):
      // report nothing ran, so revalidate() holds the key off instead of
      // letting the next stale read repeat the lease and the recompute.
      const stored = await this.setEntry(
        cacheKey,
        result,
        { ttl: options.ttl, namespace: options.namespace },
        interop,
        'skip',
        staleTtl,
        { kind: 'revalidation' }
      );
      ran = stored !== null;
    } catch (error) {
      // After close() every write throws; that is shutdown, not a failure.
      if (!this.closed) {
        this.recordFailure('revalidate', error);
        this.warnRevalidateFailed(cacheKey, error);
      }
    } finally {
      // Best-effort: the lease expires on its own. Counted, so a lock endpoint
      // that keeps failing shows in the error metrics.
      if (lockId !== null) {
        await lockable!
          .releaseLock(cacheKey, lockId)
          .catch((error) => this.recordFailure('lock_release', error));
      }
    }
    return ran;
  }

  /**
   * Rate-limited report of a failed revalidation. The caller already has the
   * stale value and sees no error, so this line and the error counter are the
   * only trace. The error text is left out (the wrapped function's errors can
   * carry anything) and the key is digested, for the reasons warnSetRejected
   * gives.
   */
  private warnRevalidateFailed(key: string, error: unknown): void {
    const now = Date.now();
    if (now - this.lastRevalidateFailedWarnAt < WARN_INTERVAL_MS) return;
    this.lastRevalidateFailedWarnAt = now;
    logError(
      `[cachekit] stale revalidation failed, the stale value stays until the store evicts it (keyHash=${blake2b16Hex(key)}): ${error instanceof Error ? error.constructor.name : 'Unknown error'}.`
    );
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
   * is all that stands between a "secure" registration and plaintext at rest.
   * Deliberately no opt-in to run unencrypted — an escape hatch
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
   * this cache whose SWR background refreshes, distributed-lock releases and
   * write-behind L2 writes are registered with the platform
   * (`ctx.waitUntil`) instead of fired fire-and-forget.
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
   * without SWR (fail-safe plain L1 reads) and with `writeBehind` writing on
   * the caller's path, and with stampede.distributedLock
   * their lock release can be cancelled at response return, leaving the
   * lease held for lockTimeoutMs while other callers wait out lockWaitMs.
   * On Node this is unnecessary: fire-and-forget work is never cancelled.
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

    this.forgetKeyArguments();

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

    // Invalidate L2 for params-level (key deletion), after any write-behind
    // write of the key this process started before the call.
    if (level === 'params' && options?.key) {
      const key = options.key;
      try {
        await this.inKeyOrder(key, () => this.backend.delete(key));
        // Evict again: a read while the delete waited (behind a pending
        // write, or on the network) can have refilled L1 from L2, as
        // delete() guards against by evicting after its L2 attempt.
        if (this.l1) {
          this.l1.invalidateByKey(key);
          this.publishL1Stats();
        }
      } catch (err) {
        // Best-effort L2 invalidation - don't fail the operation, but don't
        // hide it either. The entry stays stale in L2 until its TTL, so name
        // it — by the same digest warnSetRejected logs, never the
        // caller-supplied key itself.
        logError(
          `[cachekit] invalidate("params") L2 delete failed (keyHash=${blake2b16Hex(options.key)}):`,
          describeBackendFailure(err)
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

  close(): Promise<void> {
    // A second close() (two shutdown hooks) must not resolve before the
    // first has drained the pending writes.
    return (this.closing ??= this.closeOnce());
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;

    // Every step runs even if an earlier one throws — key release, wasm
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
    attempt(() => this.revalidating.clear());

    // Before the first await: a channel that stalls on stop must not keep the
    // arguments the key memos hold. `closed` stops any call from adding one.
    attempt(() => this.forgetKeyArguments());

    // Drain pending L2 writes (write-behind and revalidation) before anything
    // they use is torn down. `closed` stops new ones; a set() or delete()
    // already past its closed check can still queue behind a pending write,
    // hence the loop over tails not yet waited on. Tails never reject. On Node it lasts as long as the slowest
    // pending write, which the backend's own timeout and retry bound; on
    // Workers each wait is capped (afterTail).
    const drained = new Set<Promise<void>>();
    for (;;) {
      const fresh = [...this.keyTails.values()].filter((tail) => !drained.has(tail));
      if (fresh.length === 0) break;
      for (const tail of fresh) drained.add(tail);
      await Promise.all(fresh.map((tail) => this.afterTail(tail)));
    }

    // Stop invalidation channel
    if (this.invalidationChannel) {
      try {
        await this.invalidationChannel.stop();
      } catch (error) {
        errors.push(error);
      }
    }

    // Dispose encryption (releases key material: NAPI zeroizes it via the GC
    // finalizer; on Workers the CryptoKeys are dropped for the GC)
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

  private trackKeyMemo(keys: AutoKeys): void {
    if (this.keyMemos.size >= this.keyMemosPruneAt) {
      for (const ref of this.keyMemos) if (ref.deref() === undefined) this.keyMemos.delete(ref);
      this.keyMemosPruneAt = Math.max(64, 2 * this.keyMemos.size);
    }
    this.keyMemos.add(new WeakRef(keys));
  }

  /**
   * Empty every key memo of this cache. A removal on request (delete,
   * invalidate, an invalidation event from another instance, close) must not
   * leave behind the arguments of the calls it removes; the memos are emptied
   * whole because a key does not say which arguments built it.
   */
  private forgetKeyArguments(): void {
    for (const ref of this.keyMemos) {
      const keys = ref.deref();
      if (keys === undefined) this.keyMemos.delete(ref);
      else keys.forget();
    }
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new BackendError('Cache has been closed', 'permanent');
    }
  }
}

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
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { logError } from './logger.js';
import { L1Cache } from './l1/lru-cache.js';
import { ReliabilityExecutor } from './reliability/executor.js';
import {
  BackgroundRefreshManager,
  type WaitUntil,
  type L1Write,
} from './cache/background-refresh.js';
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
import { BackendError, ConfigurationError, ValueTooLargeError } from './errors.js';
import {
  DEFAULT_TTL_SECONDS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_WAIT_MS,
  DEFAULT_LOCK_POLL_MS,
} from './constants.js';

/**
 * Minimum interval between "set rejected: value too large" warnings
 * (LAB-1388). The rejection itself is often invisible (degradation swallows
 * set failures; consumers try/catch set), so the SDK reports it through the
 * logger — rate-limited so a hot oversized key can't flood the sink.
 * Module-private on purpose: one consumer, not a tuning knob.
 */
const VALUE_TOO_LARGE_WARN_INTERVAL_MS = 60_000;

/**
 * Sentinel for "the lock path did not resolve the miss — compute without
 * it". Distinct from null: the wrapped function may legitimately resolve
 * null, and conflating the two would compute twice under a held lock.
 */
const LOCK_FALLTHROUGH = Symbol('cachekit.lock-fallthrough');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cheap structural sniff for the ByteStorage envelope: a positional msgpack
 * 4-tuple whose first element is binary — fixarray(4) marker followed by a
 * bin8/bin16/bin32 marker. User values matching this shape are possible but
 * the verified unpack (xxHash3-64 over the payload) disambiguates; the sniff
 * only exists so ordinary reads never pay an unpack attempt.
 */
function looksLikeEnvelope(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x94 && bytes[1] >= 0xc4 && bytes[1] <= 0xc6;
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
  private readonly serializer: MessagePackSerializer;
  private readonly defaultTtl: number;
  private readonly invalidationChannel: InvalidationChannelLike | null = null;
  private readonly metrics: MetricsCollector;
  // Live hit/miss counters. Feed both the Prometheus collector and the SaaS
  // X-CacheKit-L1-* telemetry headers (auto-wired via resolveBackend's
  // l1Telemetry hook below).
  private readonly telemetry = { l1Hits: 0, l2Hits: 0, misses: 0 };
  private readonly swrRequiresWaitUntil: boolean;
  /**
   * Mirrors ReliabilityExecutor's own default. Read directly so the L1 decrypt
   * path can honour the same fail-open/fail-closed choice the L2 decrypt path
   * gets for free by running inside the executor.
   */
  private readonly degradationEnabled: boolean;
  private closed = false;
  /** One in-flight cold-miss resolution per cache key (single-flight, LAB-519). */
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly stampede: Required<StampedeConfig>;
  private readonly lockable: LockableBackend | null;

  constructor(options: CacheOptions, runtime: CacheRuntime) {
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
    this.degradationEnabled = options.reliability?.degradation !== false;

    // Initialize background refresh manager (SWR)
    this.backgroundRefresh = new BackgroundRefreshManager();
    this.swrRequiresWaitUntil = runtime.swrRequiresWaitUntil ?? false;

    // Initialize encryption
    this.encryption = options.encryption ? runtime.createEncryption(options.encryption) : null;

    // Initialize ByteStorage (LZ4 compression + xxHash3-64 integrity). The
    // default honors the backend's advertised preference (LAB-1388): stores
    // that already compress values at rest (the Cache API) advertise false so
    // the default config doesn't compress twice. An explicit option wins.
    const compressionEnabled = options.compression ?? this.backend.compressionDefault ?? true;
    this.byteStorage = compressionEnabled ? runtime.createByteStorage() : null;
    // Kept for lazy envelope-tolerant reads (see decodeEntry): a
    // compression-off cache still needs a codec the first time it meets an
    // enveloped entry.
    this.createByteStorage = () => runtime.createByteStorage();

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

  /** Timestamp of the last oversized-value warning (rate limiting). */
  private lastSizeWarnAt = 0;

  /**
   * Verified unpack of a suspected legacy/foreign ByteStorage envelope on a
   * compression-off cache. Returns null when the bytes aren't actually an
   * envelope (checksum/shape mismatch) — the caller then treats them as
   * plain serialized data. The codec is created lazily and cached — except
   * after close(), when a throwaway codec is used and freed immediately.
   */
  private tryUnwrapEnvelope(bytes: Uint8Array): Uint8Array | null {
    // Codec construction stays OUTSIDE the try: a broken binding must fail
    // loudly (through the reliability executor), not be conflated with "not
    // an envelope" — that would silently serve raw envelope tuples, the
    // exact corruption this path exists to prevent (expert panel, LAB-1768).
    //
    // After close() the cached reader has already been freed — an in-flight
    // read resuming post-shutdown must not resurrect the cache (close() will
    // never free it again), so it gets a throwaway codec freed right here.
    const reader = this.closed
      ? this.createByteStorage()
      : (this.envelopeReader ??= this.createByteStorage());
    try {
      return reader.unpack(bytes);
    } catch {
      return null;
    } finally {
      if (reader !== this.envelopeReader) {
        try {
          reader.free?.();
        } catch (error) {
          // Never mask the unpack result with a cleanup failure — report it
          // through the logger instead.
          logError(
            `[cachekit] failed to free post-close envelope codec: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }

  /**
   * One-line, greppable, rate-limited report of a set() rejected for size
   * (LAB-1388) — the only reliable signal of the rejection when degradation
   * or a consumer catch-block absorbs the ValueTooLargeError itself.
   */
  private warnValueTooLarge(key: string, error: ValueTooLargeError, interop: boolean): void {
    const now = Date.now();
    if (now - this.lastSizeWarnAt < VALUE_TOO_LARGE_WARN_INTERVAL_MS) return;
    this.lastSizeWarnAt = now;
    // Interop caps are protocol constants serializer config does not govern
    // — the remediation hint only holds for the serializer path (expert
    // panel, LAB-1768).
    const hint = interop
      ? ''
      : ' Raise serializer.maxEncodedSize / maxDecodedSize if values this large are expected.';
    // Keys are caller-controlled and may embed PII/credentials — log a
    // non-reversible digest, not the key itself. Same key → same digest, so
    // repeated rejections still correlate, and holders of a suspect key can
    // recompute the digest to match it.
    const keyHash = bytesToHex(blake2b(utf8ToBytes(key), { dkLen: 16 }));
    logError(
      `[cachekit] set rejected, value NOT cached (keyHash=${keyHash}): ${error.message}.${hint}`
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
  private async decodeEntry<T>(bytes: Uint8Array, key: string, interop: boolean): Promise<T> {
    const useEnvelope = this.useEnvelope(interop);

    let plaintext = bytes;
    if (this.encryption) {
      plaintext = await this.encryption.decrypt(plaintext, key, useEnvelope);
    }
    if (useEnvelope) {
      plaintext = this.byteStorage!.unpack(plaintext);
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
      // cached value (accepted eyes-open in LAB-1388/LAB-1768 — blast
      // radius bounded by maxDecodedSize/maxDepth on the unpacked bytes).
      // Any unpack failure falls back to treating the bytes as
      // plain-serialized.
      //
      // Encrypted caches never reach this branch for a genuinely mismatched
      // entry: the AAD binds useEnvelope (frozen v0x03 set, protocol#12), so
      // a compression-off secure cache reading a compression-on entry fails
      // AAD verification in decrypt() above — a loud, counted decrypt
      // failure (miss / L1 drop), never a silent wrong decode. Tolerance
      // after a SUCCESSFUL decrypt only guards the same-AAD case: a writer
      // that declared compressed=false yet stored envelope bytes, or a
      // plaintext user value that happens to look like one — both resolved
      // by the verified unpack. We deliberately do NOT retry decrypt() with
      // the flipped AAD flag: that would reintroduce exactly the envelope-
      // mode ambiguity the AAD binding exists to rule out.
      plaintext = this.tryUnwrapEnvelope(plaintext) ?? plaintext;
    }
    return interop ? decodeInteropValue<T>(plaintext) : this.serializer.decode<T>(plaintext);
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
   * an L2 decrypt failure (which happens inside run()): degradation on absorbs
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
      return { value: await this.decodeEntry<T>(stored, key, interop) };
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

    // Fetch from L2 (backend)
    return this.run('get', null, async (): Promise<T | null> => {
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

      // Decrypt, unpack, deserialize — the same sequence an L1 hit runs.
      const value = await this.decodeEntry<T>(data, key, interop);

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
          // (expert panel, LAB-1768).
          const l1TtlMs = Number.isFinite(l1TtlSeconds) ? l1TtlSeconds * 1000 : 0;
          this.l1.set(key, this.l1Payload(value, data), l1TtlMs, namespace);
          this.publishL1Stats();
        }
      }

      this.recordHit('l2');
      return value;
    });
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
   * Null only when nothing storable was ever produced — see `l1Write`.
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

    const namespace = options?.namespace ?? extractNamespace(key);
    const useEnvelope = this.useEnvelope(interop);

    // What L1 should hold, captured as soon as it exists rather than returned
    // from the closure — a degraded backend write (which `run` swallows) must
    // still yield it. Otherwise an encrypted cache's SWR refresh gets nothing
    // to store, and since a cancelled refresh leaves `expiresAt` untouched the
    // entry stays stale and EVERY later read re-arms the refresh: a backend
    // outage becomes an origin stampede on exactly the encrypted caches that
    // matter (measured 15 origin calls over 15 reads, vs 1 for plaintext).
    // Seeded with the plaintext value so a plaintext cache repopulates L1 on a
    // degraded write exactly as it did before this change.
    let l1Write: L1Write | null = this.encryption ? null : { l1: value };

    // Interop model rejection is a deterministic caller error (spec: values
    // outside the data model MUST error) — it surfaces synchronously and
    // never reaches the reliability executor, where degradation would
    // silently swallow it and retry/circuit-breaker would count it as a
    // backend failure. Auto-mode encoding stays inside the executor
    // (existing degrade semantics unchanged). A size rejection still routes
    // through the LAB-1388 warning: degradation never hides this path, but
    // a consumer's own try/catch around set() does.
    let interopSerialized: Uint8Array | null = null;
    if (interop) {
      try {
        interopSerialized = encodeInteropValue(value);
      } catch (error) {
        if (error instanceof ValueTooLargeError) this.warnValueTooLarge(key, error, true);
        throw error;
      }
    }

    await this.run('set', undefined, async (): Promise<void> => {
      // Serialize. A size rejection here is invisible in production configs
      // — degradation (on by default) swallows set() failures, and careful
      // consumers try/catch set() anyway — so a cache whose hottest values
      // exceed maxEncodedSize silently never stores them (LAB-1388). Emit
      // one greppable, rate-limited warning before the error continues into
      // the reliability stack.
      let serialized: Uint8Array;
      try {
        serialized = interopSerialized ?? this.serializer.encode(value);
      } catch (error) {
        // Only serializer.encode throws here — a non-null interopSerialized
        // already survived encodeInteropValue above.
        if (error instanceof ValueTooLargeError) this.warnValueTooLarge(key, error, false);
        throw error;
      }

      // Compress with ByteStorage (before encryption)
      let data: Uint8Array = useEnvelope ? this.byteStorage!.pack(serialized) : serialized;

      // Encrypt if encryption enabled
      if (this.encryption) {
        data = await this.encryption.encrypt(data, key, useEnvelope);
      }
      l1Write = { l1: this.l1Payload(value, data) };

      // Store in backend
      await this.backend.set(key, data, ttl);

      // Update L1 for direct writes, with `data` (the ciphertext just written
      // to the backend) rather than the caller's plaintext `value` whenever
      // the cache is encrypted. The SWR refresh path passes updateL1=false and
      // writes L1 only through completeRefresh, whose version token discards
      // the refresh if an explicit write or invalidation landed meanwhile —
      // the guard is authoritative for L1 ONLY. The backend.set above is
      // unconditional last-write-wins: an interleaved explicit set() survives
      // in L1 but is overwritten in L2 by the refresh's value until the entry
      // next expires or refreshes (a conditional L2 write would need CAS the
      // Backend contract doesn't have).
      if (updateL1 && this.l1) {
        this.l1.set(key, l1Write!.l1, ttl * 1000, namespace);
        this.publishL1Stats();
      }
    });

    return l1Write;
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
    return this.run('exists', false, async () => {
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
    attempt(() => this.byteStorage?.free?.());
    attempt(() => this.envelopeReader?.free?.());

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

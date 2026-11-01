/**
 * Prometheus metrics interface.
 *
 * Uses prom-client types when available, otherwise provides compatible interface.
 */
import { setImmediate } from 'node:timers';
import { logError } from '../logger.js';
import { checkDefaultLabels } from './labels.js';

// Types for prom-client (peer dependency)
interface Counter {
  inc(labels?: Record<string, string>, value?: number): void;
}

interface Histogram {
  observe(labels: Record<string, string>, value: number): void;
}

interface Gauge {
  set(labels: Record<string, string>, value: number): void;
  inc(labels?: Record<string, string>, value?: number): void;
  dec(labels?: Record<string, string>, value?: number): void;
}

interface Registry {
  registerMetric(metric: unknown): void;
  getSingleMetric?(name: string): unknown;
}

// Generic constructor type for prom-client metric classes
type MetricConstructor<T> = new (config: Record<string, unknown>) => T;

/** Hits or misses for one label set, counted since the last scrape. */
interface PendingCount {
  readonly labels: Record<string, string>;
  /** Its key in `cells`. */
  readonly key: string;
  /** The counter's cells; this one is in it while `attached`. */
  readonly cells: Map<string, PendingCount>;
  n: number;
  attached: boolean;
}

/**
 * Pending counts per counter this module created, one per label set and
 * shared by every collector writing to that counter. A hit or miss is a field
 * increment: prom-client's per-call label hash and validation run once per
 * label set per scrape instead, in the counter's collect(). A counter created
 * elsewhere has no entry, so its collectors increment it directly.
 */
const pendingCounts = new WeakMap<object, Map<string, PendingCount>>();

/** Add `counter`'s pending counts to it: its collect() runs this before every read. */
function flushPendingCounts(counter: Counter, cells: Map<string, PendingCount>): void {
  for (const cell of cells.values()) {
    if (cell.n === 0) continue;
    const n = cell.n;
    cell.n = 0;
    try {
      counter.inc(cell.labels, n);
    } catch (error) {
      // Unreachable once pendingCount() has checked the labels; a throw here
      // would fail the whole scrape, so it is logged instead.
      const name = (counter as { name?: string }).name;
      logError(`[cachekit] metrics: dropped ${n} pending counts on ${name}:`, error);
    }
  }
}

/**
 * Make the counter's reset() and remove() flush its pending counts first, so
 * they clear counts recorded before them, as they would had each hit been an
 * inc(). registry.resetMetrics() calls reset() on every metric. They then
 * detach every cell, all at zero: a cell whose collectors are gone is no
 * longer held, as prom-client holds no series it has cleared, and a live
 * collector attaches its cell again at its next count (see reattach()).
 */
function flushBeforeClearing(counter: Counter, cells: Map<string, PendingCount>): void {
  const clearing = counter as unknown as Record<string, unknown>;
  for (const method of ['reset', 'remove']) {
    const clear = clearing[method];
    if (typeof clear !== 'function') continue;
    clearing[method] = function (this: Counter, ...args: unknown[]): unknown {
      flushPendingCounts(this, cells);
      for (const cell of cells.values()) cell.attached = false;
      cells.clear();
      return clear.apply(this, args);
    };
  }
}

/**
 * Attach a cell a reset or remove detached, just counted into, and return the
 * cell its collector keeps. It goes back into its counter's cells, or, when a
 * newer collector has put one there for the same labels, adds its count to
 * that one, which the collector keeps from then on.
 */
function reattach(cell: PendingCount): PendingCount {
  const live = cell.cells.get(cell.key);
  if (live === undefined) {
    cell.attached = true;
    cell.cells.set(cell.key, cell);
    return cell;
  }
  live.n += cell.n;
  cell.n = 0;
  return live;
}

/**
 * The pending count for `labels` on `counter`, or null when the counter was
 * not created here or does not declare every label (it would throw on each
 * inc): the collector then increments it directly, reporting each failure.
 */
function pendingCount(counter: Counter, labels: Record<string, string>): PendingCount | null {
  const cells = pendingCounts.get(counter);
  const declared = (counter as { labelNames?: readonly string[] }).labelNames;
  if (!cells || !declared || !Object.keys(labels).every((l) => declared.includes(l))) return null;
  const key = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
  let cell = cells.get(key);
  if (!cell) cells.set(key, (cell = { labels, key, cells, n: 0, attached: true }));
  return cell;
}

/**
 * Metrics configuration.
 */
export interface MetricsConfig {
  /** Metric name prefix (default: "cachekit") */
  prefix?: string;
  /** Labels to add to all metrics */
  defaultLabels?: Record<string, string>;
  /** Custom registry (default: prom-client default registry) */
  registry?: Registry;
  /** Error handler for async metrics errors */
  onError?: (error: Error) => void;
}

/**
 * Metrics collector interface for LSP compliance.
 * Both CacheMetrics and NoopMetrics implement this.
 */
export interface MetricsCollector {
  recordOperation(operation: string, status: 'success' | 'error'): Promise<void>;
  recordHit(layer: 'l1' | 'l2'): Promise<void>;
  recordMiss(): Promise<void>;
  /**
   * Count a hit or miss without returning a promise: the cache's per-op path.
   * No promise is the point: one made as the package loads inside a request
   * keeps that request's async context alive on Node 22, and one made per
   * hit costs an allocation.
   */
  countHit(layer: 'l1' | 'l2'): void;
  countMiss(): void;
  recordError(errorType: string): Promise<void>;
  startTimer(operation: string): Promise<() => void>;
  updateL1Stats(entries: number, memoryBytes: number): Promise<void>;
  updateCircuitBreakerState(state: 'closed' | 'open' | 'half-open'): Promise<void>;
  /**
   * The cache's per-attempt path, without promises, as countHit(): count one
   * backend attempt, start its duration timer, and publish the circuit-breaker
   * state after each op.
   */
  countOperation(operation: string, status: 'success' | 'error'): void;
  timeOperation(operation: string): () => void;
  setCircuitBreakerState(state: 'closed' | 'open' | 'half-open'): void;
}

/**
 * CacheKit metrics collector.
 *
 * Metrics exposed:
 * - cachekit_operations_total (counter): Cache operations by type and status
 * - cachekit_hits_total (counter): Cache hits by layer (l1, l2)
 * - cachekit_misses_total (counter): Cache misses
 * - cachekit_errors_total (counter): Errors by type
 * - cachekit_operation_duration_seconds (histogram): Operation latency
 * - cachekit_l1_entries (gauge): Current L1 cache entries
 * - cachekit_l1_memory_bytes (gauge): Current L1 memory usage
 * - cachekit_circuit_breaker_state (gauge): Circuit breaker state (0=closed, 1=open, 0.5=half-open)
 *
 * Requires the optional `prom-client` peer dependency; when it is missing,
 * initialization reports once through the library logger and metrics degrade
 * to no-ops. prom-client loads in the background, starting on the event-loop
 * turn after construction, and no operation waits for it: metrics recorded
 * while it loads land once it has loaded.
 *
 * @example
 * ```typescript
 * import { createCache } from '@cachekit-io/cachekit';
 * import promClient from 'prom-client';
 *
 * const cache = createCache({
 *   backend: { url: 'redis://localhost' },
 *   metrics: { prefix: 'myapp_cache' }, // or `metrics: true` for defaults
 * });
 *
 * // Expose metrics endpoint
 * app.get('/metrics', async (req, res) => {
 *   res.set('Content-Type', promClient.register.contentType);
 *   res.end(await promClient.register.metrics());
 * });
 * ```
 */
export class CacheMetrics implements MetricsCollector {
  private readonly prefix: string;
  private readonly defaultLabels: Record<string, string>;
  private readonly registry: Registry | undefined;
  private readonly errorHandler: ((error: Error) => void) | undefined;

  // Metric instances (lazy-loaded when prom-client available)
  private operationsCounter: Counter | null = null;
  private hitsCounter: Counter | null = null;
  private missesCounter: Counter | null = null;
  private errorsCounter: Counter | null = null;
  private durationHistogram: Histogram | null = null;
  private l1EntriesGauge: Gauge | null = null;
  private l1MemoryGauge: Gauge | null = null;
  private circuitBreakerGauge: Gauge | null = null;

  // Pending counts, set once prom-client has loaded (see pendingCounts)
  private l1Hits: PendingCount | null = null;
  private l2Hits: PendingCount | null = null;
  private misses: PendingCount | null = null;
  // Pending operation counts by operation, one map per status
  private readonly successes = new Map<string, PendingCount>();
  private readonly failures = new Map<string, PendingCount>();

  /**
   * Settles true once prom-client has loaded and every metric is registered,
   * false if either failed. Never rejects. Scheduled by the constructor, so
   * no operation waits for the import.
   */
  private readonly ready: Promise<boolean>;
  /** Set with `ready` resolving true; lets a stopped timer record at once. */
  private isReady = false;
  /** An initialization failure that whenReady() has not reported yet. */
  private initError: Error | null = null;
  /** Initialization failed and has been reported: every metric is a no-op. */
  private initFailed = false;

  constructor(config: MetricsConfig = {}) {
    this.prefix = config.prefix ?? 'cachekit';
    checkDefaultLabels(config.defaultLabels);
    this.defaultLabels = config.defaultLabels ?? {};
    this.registry = config.registry;
    this.errorHandler = config.onError;
    // Load prom-client on the next turn of the event loop, not in this one:
    // Node can evaluate a dynamically imported CommonJS package in the
    // microtasks right after the import() call (Node 24 and 26 do), which
    // would hold up an operation started right after construction.
    // setImmediate comes from node:timers, which fake timers leave alone, so
    // a test suite that fakes the global timers still gets its metrics.
    this.ready = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
      this.initialize()
    );
  }

  /**
   * Register an error handler for async metrics errors.
   * Allows applications to handle metrics errors instead of silent failures.
   */
  onError(handler: (error: Error) => void): void {
    (this as unknown as { errorHandler: (error: Error) => void }).errorHandler = handler;
  }

  /**
   * Load prom-client and register the metrics. Runs once, from the
   * constructor. Resolves false if prom-client is missing or registration
   * fails, keeping the error for whenReady() to report.
   */
  private async initialize(): Promise<boolean> {
    try {
      // Dynamic import - prom-client is a peer dependency
      const promClient = await import('prom-client');

      // Constructors with type assertions (prom-client has complex generics)
      const CounterClass = promClient.Counter as unknown as MetricConstructor<Counter>;
      const HistogramClass = promClient.Histogram as unknown as MetricConstructor<Histogram>;
      const GaugeClass = promClient.Gauge as unknown as MetricConstructor<Gauge>;

      // Target registry: custom (config.registry) or prom-client's default.
      // Reuse an already-registered metric instead of constructing a second
      // one — prom-client throws on duplicate names, which would kill metrics
      // for every cache instance after the first sharing a prefix+registry.
      const registry = this.registry ?? (promClient.register as unknown as Registry);
      const getOrCreate = <M>(Ctor: MetricConstructor<M>, cfg: Record<string, unknown>): M => {
        const existing = registry.getSingleMetric?.(cfg.name as string);
        if (existing) return existing as M;
        return new Ctor({ ...cfg, registers: [registry] });
      };
      // A counter that reads its pending counts when scraped.
      const getOrCreateCounted = (cfg: Record<string, unknown>): Counter => {
        const existing = registry.getSingleMetric?.(cfg.name as string);
        if (existing) return existing as Counter;
        const cells = new Map<string, PendingCount>();
        const counter = new CounterClass({
          ...cfg,
          collect(this: Counter) {
            flushPendingCounts(this, cells);
          },
          registers: [registry],
        });
        pendingCounts.set(counter, cells);
        flushBeforeClearing(counter, cells);
        return counter;
      };
      // Every metric declares the default labels, or each inc() would throw.
      const defaultLabelNames = Object.keys(this.defaultLabels);

      // Operations counter
      this.operationsCounter = getOrCreateCounted({
        name: `${this.prefix}_operations_total`,
        help: 'Total cache operations',
        labelNames: ['operation', 'status', ...defaultLabelNames],
      });

      // Hits counter
      const hits = getOrCreateCounted({
        name: `${this.prefix}_hits_total`,
        help: 'Cache hits',
        labelNames: ['layer', ...defaultLabelNames],
      });

      // Misses counter
      const misses = getOrCreateCounted({
        name: `${this.prefix}_misses_total`,
        help: 'Cache misses',
        labelNames: defaultLabelNames,
      });

      // Errors counter
      this.errorsCounter = getOrCreate(CounterClass, {
        name: `${this.prefix}_errors_total`,
        help: 'Cache errors',
        labelNames: ['error_type', ...defaultLabelNames],
      });

      // Duration histogram
      this.durationHistogram = getOrCreate(HistogramClass, {
        name: `${this.prefix}_operation_duration_seconds`,
        help: 'Operation duration in seconds',
        labelNames: ['operation', ...defaultLabelNames],
        buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      });

      // L1 entries gauge
      this.l1EntriesGauge = getOrCreate(GaugeClass, {
        name: `${this.prefix}_l1_entries`,
        help: 'Current L1 cache entries',
        labelNames: defaultLabelNames,
      });

      // L1 memory gauge
      this.l1MemoryGauge = getOrCreate(GaugeClass, {
        name: `${this.prefix}_l1_memory_bytes`,
        help: 'Current L1 memory usage in bytes',
        labelNames: defaultLabelNames,
      });

      // Circuit breaker gauge
      this.circuitBreakerGauge = getOrCreate(GaugeClass, {
        name: `${this.prefix}_circuit_breaker_state`,
        help: 'Circuit breaker state (0=closed, 0.5=half-open, 1=open)',
        labelNames: defaultLabelNames,
      });

      this.hitsCounter = hits;
      this.missesCounter = misses;
      this.l1Hits = pendingCount(hits, { layer: 'l1', ...this.defaultLabels });
      this.l2Hits = pendingCount(hits, { layer: 'l2', ...this.defaultLabels });
      this.misses = pendingCount(misses, this.defaultLabels);

      this.isReady = true;
      return true;
    } catch (error) {
      this.initError = error instanceof Error ? error : new Error(String(error));
      return false;
    }
  }

  /**
   * Wait for initialization. A failure is reported once, at the first metric
   * call rather than when the load fails, so it reaches an onError handler
   * registered after the collector was built.
   */
  private async whenReady(): Promise<boolean> {
    if (await this.ready) return true;
    this.initFailed = true;
    const err = this.initError;
    if (err) {
      this.initError = null;
      // Log error instead of silently swallowing
      if (!this.invokeErrorHandler(err)) {
        logError(
          '[cachekit] metrics are enabled but failed to initialize — install the optional ' +
            '`prom-client` peer dependency or set `metrics: false`:',
          err.message
        );
      }
    }
    return false;
  }

  /**
   * Invoke the user's onError handler guarded, returning whether one was
   * registered. A throwing handler must never escape: the cache layer calls
   * every collector method fire-and-forget (`void this.metrics.*()`) on the
   * invariant that they never reject — an unguarded handler would turn its
   * own bug into unhandled rejections. Metrics stay best-effort.
   */
  private invokeErrorHandler(err: Error): boolean {
    if (!this.errorHandler) return false;
    try {
      this.errorHandler(err);
    } catch (handlerError) {
      logError('[cachekit] metrics onError handler threw:', handlerError);
    }
    return true;
  }

  /**
   * Handle errors from async metric operations.
   * Proper error handling instead of silent failures.
   */
  private handleError(error: unknown, context: string): void {
    const err = error instanceof Error ? error : new Error(String(error));

    if (!this.invokeErrorHandler(err)) {
      logError(`[cachekit] Metrics error (${context}):`, err.message);
    }
  }

  /**
   * Record a cache operation.
   */
  async recordOperation(operation: string, status: 'success' | 'error'): Promise<void> {
    try {
      if (!(await this.whenReady())) return;
      if (!this.addPendingOperation(operation, status))
        this.operationsCounter?.inc({ operation, status, ...this.defaultLabels });
    } catch (error) {
      this.handleError(error, 'recordOperation');
    }
  }

  /**
   * Count a backend attempt. Runs on every attempt, so once prom-client has
   * loaded it only adds to a pending count, as countHit() does.
   */
  countOperation(operation: string, status: 'success' | 'error'): void {
    if (!this.addPendingOperation(operation, status) && !this.initFailed)
      void this.recordOperation(operation, status);
  }

  /** Add an attempt to its pending count; false when there is none. */
  private addPendingOperation(operation: string, status: 'success' | 'error'): boolean {
    if (!this.isReady || this.operationsCounter === null) return false;
    const cells = status === 'success' ? this.successes : this.failures;
    let pending = cells.get(operation);
    if (pending === undefined) {
      const cell = pendingCount(this.operationsCounter, {
        operation,
        status,
        ...this.defaultLabels,
      });
      if (cell === null) return false;
      cells.set(operation, (pending = cell));
    }
    pending.n++;
    if (!pending.attached) cells.set(operation, reattach(pending));
    return true;
  }

  /**
   * Count a cache hit. Runs on every hit, so once prom-client has loaded it
   * only adds to a pending count, which the counter reads when scraped.
   */
  countHit(layer: 'l1' | 'l2'): void {
    if (!this.addPendingHit(layer) && !this.initFailed) void this.recordHit(layer);
  }

  /** Add a hit to its pending count; false when there is none. */
  private addPendingHit(layer: 'l1' | 'l2'): boolean {
    const pending = layer === 'l1' ? this.l1Hits : this.l2Hits;
    if (pending === null) return false;
    pending.n++;
    if (!pending.attached) {
      if (layer === 'l1') this.l1Hits = reattach(pending);
      else this.l2Hits = reattach(pending);
    }
    return true;
  }

  /**
   * Record a cache hit, settling once it is counted.
   */
  async recordHit(layer: 'l1' | 'l2'): Promise<void> {
    try {
      if (!(await this.whenReady())) return;
      if (!this.addPendingHit(layer)) this.hitsCounter?.inc({ layer, ...this.defaultLabels });
    } catch (error) {
      this.handleError(error, 'recordHit');
    }
  }

  /**
   * Count a cache miss, as countHit() counts a hit.
   */
  countMiss(): void {
    if (!this.addPendingMiss() && !this.initFailed) void this.recordMiss();
  }

  /** Add a miss to its pending count; false when there is none. */
  private addPendingMiss(): boolean {
    const pending = this.misses;
    if (pending === null) return false;
    pending.n++;
    if (!pending.attached) this.misses = reattach(pending);
    return true;
  }

  /**
   * Record a cache miss, settling once it is counted.
   */
  async recordMiss(): Promise<void> {
    try {
      if (!(await this.whenReady())) return;
      if (!this.addPendingMiss()) this.missesCounter?.inc(this.defaultLabels);
    } catch (error) {
      this.handleError(error, 'recordMiss');
    }
  }

  /**
   * Record an error.
   */
  async recordError(errorType: string): Promise<void> {
    try {
      if (!(await this.whenReady())) return;
      this.errorsCounter?.inc({ error_type: errorType, ...this.defaultLabels });
    } catch (error) {
      this.handleError(error, 'recordError');
    }
  }

  /**
   * Start timing an operation. Never waits for prom-client to load: the
   * clock starts now, and a timer stopped before initialization has finished
   * records its duration once it has, so no operation's sample is dropped.
   */
  async startTimer(operation: string): Promise<() => void> {
    return this.timeOperation(operation);
  }

  /** startTimer() without the promise: the cache's per-attempt path. */
  timeOperation(operation: string): () => void {
    const start = performance.now();
    return () => {
      const seconds = (performance.now() - start) / 1000;
      if (this.isReady) {
        this.observeDuration(operation, seconds);
      } else {
        void this.whenReady().then((ok) => {
          if (ok) this.observeDuration(operation, seconds);
        });
      }
    };
  }

  private observeDuration(operation: string, seconds: number): void {
    try {
      this.durationHistogram?.observe({ operation, ...this.defaultLabels }, seconds);
    } catch (error) {
      this.handleError(error, 'startTimer');
    }
  }

  /**
   * Update L1 cache stats.
   */
  async updateL1Stats(entries: number, memoryBytes: number): Promise<void> {
    try {
      if (!(await this.whenReady())) return;
      this.l1EntriesGauge?.set(this.defaultLabels, entries);
      this.l1MemoryGauge?.set(this.defaultLabels, memoryBytes);
    } catch (error) {
      this.handleError(error, 'updateL1Stats');
    }
  }

  /**
   * Update circuit breaker state.
   */
  async updateCircuitBreakerState(state: 'closed' | 'open' | 'half-open'): Promise<void> {
    try {
      if (!(await this.whenReady())) return;
      this.circuitBreakerGauge?.set(this.defaultLabels, breakerValue(state));
    } catch (error) {
      this.handleError(error, 'updateCircuitBreakerState');
    }
  }

  /**
   * Publish the circuit-breaker state after an op, without a promise once
   * prom-client has loaded. It stays a set() per op rather than a value read
   * at scrape: caches sharing a registry share the gauge, which reads the
   * state of whichever finished an op last, and only prom-client's own set()
   * keeps that order against every other writer (the other build of this
   * package, an older copy, the application) and matches its label handling.
   */
  setCircuitBreakerState(state: 'closed' | 'open' | 'half-open'): void {
    if (this.isReady) {
      try {
        this.circuitBreakerGauge?.set(this.defaultLabels, breakerValue(state));
      } catch (error) {
        this.handleError(error, 'setCircuitBreakerState');
      }
    } else if (!this.initFailed) {
      void this.updateCircuitBreakerState(state);
    }
  }
}

const breakerValue = (state: 'closed' | 'open' | 'half-open'): number =>
  state === 'closed' ? 0 : state === 'half-open' ? 0.5 : 1;

/**
 * No-op metrics implementation for when metrics are disabled.
 */
export class NoopMetrics implements MetricsCollector {
  async recordOperation(): Promise<void> {}
  async recordHit(): Promise<void> {}
  async recordMiss(): Promise<void> {}
  countHit(): void {}
  countMiss(): void {}
  async recordError(): Promise<void> {}
  async startTimer(): Promise<() => void> {
    return () => {};
  }
  async updateL1Stats(): Promise<void> {}
  async updateCircuitBreakerState(): Promise<void> {}
  countOperation(): void {}
  timeOperation(): () => void {
    return () => {};
  }
  setCircuitBreakerState(): void {}
}

/** Create metrics instance based on configuration */
export function createMetrics(
  enabled: boolean,
  config?: MetricsConfig
): CacheMetrics | NoopMetrics {
  return enabled ? new CacheMetrics(config) : new NoopMetrics();
}

/**
 * Prometheus metrics interface.
 *
 * Uses prom-client types when available, otherwise provides compatible interface.
 */
import { logError } from '../logger.js';

// Types for prom-client (peer dependency)
interface Counter {
  inc(labels?: Record<string, string>, value?: number): void;
}

interface Histogram {
  observe(labels: Record<string, string>, value: number): void;
  startTimer(labels?: Record<string, string>): () => number;
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
  /** Error handler for async metrics errors (m5 fix) */
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
  recordError(errorType: string): Promise<void>;
  startTimer(operation: string): Promise<() => void>;
  updateL1Stats(entries: number, memoryBytes: number): Promise<void>;
  updateCircuitBreakerState(state: 'closed' | 'open' | 'half-open'): Promise<void>;
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
 * to no-ops.
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

  private initialized = false;
  // prom-client module reference - typed loosely due to complex generics
  private CounterClass: MetricConstructor<Counter> | null = null;
  private HistogramClass: MetricConstructor<Histogram> | null = null;
  private GaugeClass: MetricConstructor<Gauge> | null = null;

  constructor(config: MetricsConfig = {}) {
    this.prefix = config.prefix ?? 'cachekit';
    this.defaultLabels = config.defaultLabels ?? {};
    this.registry = config.registry;
    this.errorHandler = config.onError;
  }

  /**
   * Register an error handler for async metrics errors.
   * m5 Fix: Allows applications to handle metrics errors instead of silent failures.
   */
  onError(handler: (error: Error) => void): void {
    (this as unknown as { errorHandler: (error: Error) => void }).errorHandler = handler;
  }

  /**
   * Initialize metrics (lazy - only when first used).
   * Returns false if prom-client not available.
   */
  private async initialize(): Promise<boolean> {
    if (this.initialized) return this.CounterClass !== null;
    this.initialized = true;

    try {
      // Dynamic import - prom-client is a peer dependency
      const promClient = await import('prom-client');

      // Store constructors with type assertions (prom-client has complex generics)
      this.CounterClass = promClient.Counter as unknown as MetricConstructor<Counter>;
      this.HistogramClass = promClient.Histogram as unknown as MetricConstructor<Histogram>;
      this.GaugeClass = promClient.Gauge as unknown as MetricConstructor<Gauge>;

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

      // Operations counter
      this.operationsCounter = getOrCreate(this.CounterClass, {
        name: `${this.prefix}_operations_total`,
        help: 'Total cache operations',
        labelNames: ['operation', 'status'],
      });

      // Hits counter
      this.hitsCounter = getOrCreate(this.CounterClass, {
        name: `${this.prefix}_hits_total`,
        help: 'Cache hits',
        labelNames: ['layer'],
      });

      // Misses counter
      this.missesCounter = getOrCreate(this.CounterClass, {
        name: `${this.prefix}_misses_total`,
        help: 'Cache misses',
        labelNames: [],
      });

      // Errors counter
      this.errorsCounter = getOrCreate(this.CounterClass, {
        name: `${this.prefix}_errors_total`,
        help: 'Cache errors',
        labelNames: ['error_type'],
      });

      // Duration histogram
      this.durationHistogram = getOrCreate(this.HistogramClass, {
        name: `${this.prefix}_operation_duration_seconds`,
        help: 'Operation duration in seconds',
        labelNames: ['operation'],
        buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      });

      // L1 entries gauge
      this.l1EntriesGauge = getOrCreate(this.GaugeClass, {
        name: `${this.prefix}_l1_entries`,
        help: 'Current L1 cache entries',
        labelNames: [],
      });

      // L1 memory gauge
      this.l1MemoryGauge = getOrCreate(this.GaugeClass, {
        name: `${this.prefix}_l1_memory_bytes`,
        help: 'Current L1 memory usage in bytes',
        labelNames: [],
      });

      // Circuit breaker gauge
      this.circuitBreakerGauge = getOrCreate(this.GaugeClass, {
        name: `${this.prefix}_circuit_breaker_state`,
        help: 'Circuit breaker state (0=closed, 0.5=half-open, 1=open)',
        labelNames: [],
      });

      return true;
    } catch (error) {
      // m5 Fix: Log error instead of silently swallowing
      const err = error instanceof Error ? error : new Error(String(error));

      if (!this.invokeErrorHandler(err)) {
        logError(
          '[cachekit] metrics are enabled but failed to initialize — install the optional ' +
            '`prom-client` peer dependency or set `metrics: false`:',
          err.message
        );
      }

      return false;
    }
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
   * m5 Fix: Proper error handling instead of silent failures.
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
      if (!(await this.initialize())) return;
      this.operationsCounter?.inc({ operation, status, ...this.defaultLabels });
    } catch (error) {
      this.handleError(error, 'recordOperation');
    }
  }

  /**
   * Record a cache hit.
   */
  async recordHit(layer: 'l1' | 'l2'): Promise<void> {
    try {
      if (!(await this.initialize())) return;
      this.hitsCounter?.inc({ layer, ...this.defaultLabels });
    } catch (error) {
      this.handleError(error, 'recordHit');
    }
  }

  /**
   * Record a cache miss.
   */
  async recordMiss(): Promise<void> {
    try {
      if (!(await this.initialize())) return;
      this.missesCounter?.inc(this.defaultLabels);
    } catch (error) {
      this.handleError(error, 'recordMiss');
    }
  }

  /**
   * Record an error.
   */
  async recordError(errorType: string): Promise<void> {
    try {
      if (!(await this.initialize())) return;
      this.errorsCounter?.inc({ error_type: errorType, ...this.defaultLabels });
    } catch (error) {
      this.handleError(error, 'recordError');
    }
  }

  /**
   * Start timing an operation.
   */
  async startTimer(operation: string): Promise<() => void> {
    try {
      if (!(await this.initialize())) return () => {};
      return this.durationHistogram?.startTimer({ operation, ...this.defaultLabels }) ?? (() => {});
    } catch (error) {
      this.handleError(error, 'startTimer');
      return () => {};
    }
  }

  /**
   * Update L1 cache stats.
   */
  async updateL1Stats(entries: number, memoryBytes: number): Promise<void> {
    try {
      if (!(await this.initialize())) return;
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
      if (!(await this.initialize())) return;
      const value = state === 'closed' ? 0 : state === 'half-open' ? 0.5 : 1;
      this.circuitBreakerGauge?.set(this.defaultLabels, value);
    } catch (error) {
      this.handleError(error, 'updateCircuitBreakerState');
    }
  }
}

/**
 * No-op metrics implementation for when metrics are disabled.
 */
export class NoopMetrics implements MetricsCollector {
  async recordOperation(): Promise<void> {}
  async recordHit(): Promise<void> {}
  async recordMiss(): Promise<void> {}
  async recordError(): Promise<void> {}
  async startTimer(): Promise<() => void> {
    return () => {};
  }
  async updateL1Stats(): Promise<void> {}
  async updateCircuitBreakerState(): Promise<void> {}
}

/** Create metrics instance based on configuration */
export function createMetrics(
  enabled: boolean,
  config?: MetricsConfig
): CacheMetrics | NoopMetrics {
  return enabled ? new CacheMetrics(config) : new NoopMetrics();
}

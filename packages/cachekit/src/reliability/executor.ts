import { CircuitBreaker, CircuitState, CircuitBreakerConfig } from './circuit-breaker.js';
import { RetryPolicy, RetryConfig } from './retry.js';
import { withDegradation } from './degradation.js';

/**
 * Configuration for ReliabilityExecutor.
 */
export interface ReliabilityExecutorConfig {
  /** Circuit breaker configuration */
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  /** Retry policy configuration */
  retry?: Partial<RetryConfig>;
  /** Enable graceful degradation (default: true) */
  degradation?: boolean;
}

/**
 * Composes reliability patterns: circuit breaker + retry + graceful degradation.
 *
 * Execution order (inner to outer):
 * 1. Operation executes
 * 2. RetryPolicy wraps with exponential backoff
 * 3. CircuitBreaker wraps with fail-fast protection
 * 4. Degradation catches failures and returns fallback
 *
 * This class encapsulates the reliability stack so CacheImpl can delegate
 * all resilience concerns without knowing implementation details.
 */
export class ReliabilityExecutor {
  private readonly circuitBreaker: CircuitBreaker | null;
  private readonly retryPolicy: RetryPolicy | null;
  private readonly degradationEnabled: boolean;

  constructor(config: ReliabilityExecutorConfig = {}) {
    this.circuitBreaker = config.circuitBreaker ? new CircuitBreaker(config.circuitBreaker) : null;

    this.retryPolicy = config.retry ? new RetryPolicy(config.retry) : null;

    this.degradationEnabled = config.degradation !== false;
  }

  /**
   * Execute an operation with full reliability stack applied.
   *
   * @param operation - Async operation to execute
   * @param fallback - Value to return if operation fails and degradation enabled
   * @returns Operation result or fallback on failure
   * @throws If operation fails and degradation is disabled
   */
  async execute<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    let fn = operation;

    // Layer 1: Wrap with retry (innermost)
    if (this.retryPolicy) {
      const retry = this.retryPolicy;
      fn = () => retry.execute(operation);
    }

    // Layer 2: Wrap with circuit breaker
    if (this.circuitBreaker) {
      const cb = this.circuitBreaker;
      const inner = fn;
      fn = () => cb.execute(inner);
    }

    // Layer 3: Wrap with graceful degradation (outermost)
    if (this.degradationEnabled) {
      return withDegradation(fn, fallback);
    }

    return fn();
  }

  /**
   * Get the current circuit breaker state.
   * Returns null if circuit breaker is not configured.
   */
  getCircuitBreakerState(): CircuitState | null {
    return this.circuitBreaker?.state ?? null;
  }

  /**
   * Reset the circuit breaker to closed state.
   * No-op if circuit breaker is not configured.
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker?.reset();
  }

  /**
   * Check if any reliability patterns are configured.
   */
  get isConfigured(): boolean {
    return this.circuitBreaker !== null || this.retryPolicy !== null;
  }
}

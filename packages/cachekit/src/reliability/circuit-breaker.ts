import { CircuitBreakerOpenError } from '../errors.js';
import {
  DEFAULT_CB_FAILURE_THRESHOLD,
  DEFAULT_CB_SUCCESS_THRESHOLD,
  DEFAULT_CB_TIMEOUT,
  DEFAULT_CB_HALF_OPEN_MAX_CALLS,
  DEFAULT_CB_ROLLING_WINDOW,
} from '../constants.js';

/**
 * Circuit breaker states.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker configuration.
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit (default: 10) */
  failureThreshold: number;

  /** Number of successes in half-open to close circuit (default: 2) */
  successThreshold: number;

  /** Time in ms before transitioning from open to half-open (default: 5000) */
  timeout: number;

  /** Max calls allowed in half-open state (default: 3) */
  halfOpenMaxCalls: number;

  /** Rolling window for failure counting in ms (default: 60000) */
  rollingWindow: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: DEFAULT_CB_FAILURE_THRESHOLD,
  successThreshold: DEFAULT_CB_SUCCESS_THRESHOLD,
  timeout: DEFAULT_CB_TIMEOUT,
  halfOpenMaxCalls: DEFAULT_CB_HALF_OPEN_MAX_CALLS,
  rollingWindow: DEFAULT_CB_ROLLING_WINDOW,
};

/**
 * Circuit breaker implementation with rolling window failure tracking.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: All requests fail fast with CircuitBreakerOpenError
 * - HALF-OPEN: Limited requests allowed to test if service recovered
 *
 * Transitions:
 * - CLOSED + failures >= threshold → OPEN
 * - OPEN + timeout elapsed → HALF-OPEN
 * - HALF-OPEN + success >= successThreshold → CLOSED
 * - HALF-OPEN + any failure → OPEN
 */
export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private currentState: CircuitState = 'closed';
  private failures: number[] = []; // timestamps of failures within rolling window
  private successesInHalfOpen = 0;
  private callsInHalfOpen = 0;
  private openedAt: number | null = null;
  // m10 Fix: config is already readonly (set in constructor)

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get the current circuit state.
   */
  get state(): CircuitState {
    // Check if we should transition from open to half-open
    if (this.currentState === 'open' && this.openedAt !== null) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.config.timeout) {
        this.transitionToHalfOpen();
      }
    }
    return this.currentState;
  }

  /**
   * Atomically try to acquire a slot in half-open state.
   * Returns true if slot acquired, false if limit reached.
   *
   * This provides a race-condition-safe way to limit concurrent calls in half-open state.
   * The check-and-increment happens atomically (single synchronous operation).
   */
  tryAcquireHalfOpenSlot(): boolean {
    if (this.currentState !== 'half-open') {
      return false;
    }
    if (this.callsInHalfOpen >= this.config.halfOpenMaxCalls) {
      return false;
    }
    this.callsInHalfOpen++;
    return true;
  }

  /**
   * Execute a function through the circuit breaker.
   *
   * @throws {CircuitBreakerOpenError} if circuit is open
   * @throws The original error if the operation fails
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.state; // triggers state check

    if (currentState === 'open') {
      throw new CircuitBreakerOpenError();
    }

    if (currentState === 'half-open') {
      // M6 Fix: Use atomic slot acquisition to prevent race condition
      if (!this.tryAcquireHalfOpenSlot()) {
        throw new CircuitBreakerOpenError('Circuit breaker half-open limit reached');
      }
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Reset the circuit breaker to closed state.
   */
  reset(): void {
    this.currentState = 'closed';
    this.failures = [];
    this.successesInHalfOpen = 0;
    this.callsInHalfOpen = 0;
    this.openedAt = null;
  }

  private recordSuccess(): void {
    if (this.currentState === 'half-open') {
      this.successesInHalfOpen++;
      if (this.successesInHalfOpen >= this.config.successThreshold) {
        this.transitionToClosed();
      }
    }
  }

  private recordFailure(): void {
    const now = Date.now();

    if (this.currentState === 'half-open') {
      // Any failure in half-open → open
      this.transitionToOpen();
      return;
    }

    // Add failure to rolling window
    this.failures.push(now);

    // Prune old failures outside rolling window
    const windowStart = now - this.config.rollingWindow;
    this.failures = this.failures.filter((t) => t >= windowStart);

    // Check if threshold exceeded
    if (this.failures.length >= this.config.failureThreshold) {
      this.transitionToOpen();
    }
  }

  private transitionToOpen(): void {
    this.currentState = 'open';
    this.openedAt = Date.now();
    this.successesInHalfOpen = 0;
    this.callsInHalfOpen = 0;
  }

  private transitionToHalfOpen(): void {
    this.currentState = 'half-open';
    this.successesInHalfOpen = 0;
    this.callsInHalfOpen = 0;
  }

  private transitionToClosed(): void {
    this.currentState = 'closed';
    this.failures = [];
    this.successesInHalfOpen = 0;
    this.callsInHalfOpen = 0;
    this.openedAt = null;
  }
}

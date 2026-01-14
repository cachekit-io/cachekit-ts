import { secureRandomFloat } from '../utils/random.js';
import {
  DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY,
  DEFAULT_RETRY_MAX_DELAY,
  RETRY_JITTER_MIN,
} from '../constants.js';

/**
 * Retry policy configuration.
 */
export interface RetryConfig {
  /** Maximum retry attempts (default: 3) */
  maxAttempts: number;
  /** Base delay in ms (default: 100) */
  baseDelay: number;
  /** Maximum delay in ms (default: 5000) */
  maxDelay: number;
  /** Add random jitter to delays (default: true) */
  jitter: boolean;
  /** Error types to retry (default: all errors) */
  retryOn?: (error: Error) => boolean;
}

/**
 * Options for execute method.
 */
export interface ExecuteOptions {
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
  baseDelay: DEFAULT_RETRY_BASE_DELAY,
  maxDelay: DEFAULT_RETRY_MAX_DELAY,
  jitter: true,
};

/**
 * Retry policy with exponential backoff and jitter.
 *
 * Implements truncated exponential backoff:
 * delay = min(baseDelay * 2^attempt, maxDelay) * (jitter ? 0.5-1.5 : 1)
 */
export class RetryPolicy {
  private readonly config: RetryConfig;
  // m10 Fix: config is already readonly (set in constructor)

  constructor(config: Partial<RetryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute a function with retry logic.
   *
   * @param fn - Function to execute with retries
   * @param options - Optional execution options (including AbortSignal)
   * @throws AbortError if signal is aborted during execution
   */
  async execute<T>(fn: () => Promise<T>, options?: ExecuteOptions): Promise<T> {
    let lastError: Error | undefined;
    const signal = options?.signal;

    for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
      // m3 Fix: Check if aborted before each attempt
      if (signal?.aborted) {
        throw new DOMException('Retry aborted', 'AbortError');
      }

      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if we should retry this error
        if (this.config.retryOn && !this.config.retryOn(lastError)) {
          throw lastError;
        }

        // Don't sleep on last attempt
        if (attempt < this.config.maxAttempts - 1) {
          // m3 Fix: Pass signal to sleep for cancellable delays
          await this.sleep(this.calculateDelay(attempt), signal);
        }
      }
    }

    throw lastError;
  }

  private calculateDelay(attempt: number): number {
    // Exponential backoff: baseDelay * 2^attempt
    let delay = this.config.baseDelay * Math.pow(2, attempt);

    // Cap at maxDelay
    delay = Math.min(delay, this.config.maxDelay);

    // Add jitter if enabled (0.5 to 1.5 multiplier)
    // m7 Fix: Use crypto PRNG instead of Math.random for unpredictable timing
    if (this.config.jitter) {
      delay *= RETRY_JITTER_MIN + secureRandomFloat();
    }

    return delay;
  }

  /**
   * Sleep for the specified duration, supporting cancellation via AbortSignal.
   *
   * m3 Fix: Made sleep cancellable to prevent resource waste on shutdown.
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      // If already aborted, reject immediately
      if (signal?.aborted) {
        reject(new DOMException('Sleep aborted', 'AbortError'));
        return;
      }

      let abortHandler: (() => void) | undefined;

      const cleanup = () => {
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler);
        }
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);

      // Listen for abort signal during sleep
      if (signal) {
        abortHandler = () => {
          clearTimeout(timeoutId);
          cleanup();
          reject(new DOMException('Sleep aborted', 'AbortError'));
        };

        signal.addEventListener('abort', abortHandler, { once: true });
      }
    });
  }
}

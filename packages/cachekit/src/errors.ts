/**
 * Base error class for all CacheKit errors.
 * All custom errors extend this for easy catch filtering.
 */
export class CachekitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CachekitError';
    // Maintains proper stack trace for where error was thrown (V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when configuration is invalid or missing.
 * Examples: invalid TTL, missing required options, invalid backend config.
 */
export class ConfigurationError extends CachekitError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigurationError';
  }
}

/**
 * Thrown when encryption/decryption operations fail.
 * Examples: invalid key, decryption failure, AAD mismatch.
 */
export class EncryptionError extends CachekitError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EncryptionError';
  }
}

/**
 * Thrown when data integrity verification fails.
 * Examples: Blake3 hash mismatch, corrupted cache entry.
 */
export class IntegrityError extends CachekitError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IntegrityError';
  }
}

/**
 * Thrown when backend operations fail.
 * Examples: Redis connection error, network timeout.
 *
 * `classification` drives the reliability stack: `permanent` and
 * `authentication` errors are not retried and do not count toward the
 * circuit breaker; `transient` and `timeout` errors are. The default is
 * `transient`, so an error whose cause is unknown — including one thrown by a
 * custom backend — still trips the breaker during a real outage. Pass
 * `permanent` only for errors that retrying cannot fix.
 */
export class BackendError extends CachekitError {
  readonly classification: import('./backends/error-classifier.js').ErrorClassification;
  constructor(
    message: string,
    classification: import('./backends/error-classifier.js').ErrorClassification = 'transient',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'BackendError';
    this.classification = classification;
  }
}

/**
 * Whether an error is retried by `RetryPolicy` and counts as a failure for
 * `CircuitBreaker`.
 *
 * A `BackendError` classified `permanent` or `authentication` is neither:
 * retrying cannot fix it (protocol saas-api.md, Error Classification: do not
 * retry), and it is not an outage signal, so a run of rejected keys must not
 * open the breaker for every other key. Every other error is retried and
 * counted.
 */
export function isRetryable(error: unknown): boolean {
  return !(
    error instanceof BackendError &&
    (error.classification === 'permanent' || error.classification === 'authentication')
  );
}

/**
 * Thrown when circuit breaker is open and blocking requests.
 */
export class CircuitBreakerOpenError extends CachekitError {
  constructor(message: string = 'Circuit breaker is open', options?: ErrorOptions) {
    super(message, options);
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Thrown when operation times out.
 */
export class TimeoutError extends CachekitError {
  constructor(message: string = 'Operation timed out', options?: ErrorOptions) {
    super(message, options);
    this.name = 'TimeoutError';
  }
}

/**
 * Thrown when value exceeds size limits.
 * Examples: serialized value > maxEncodedSize, response > maxDecodedSize.
 */
export class ValueTooLargeError extends CachekitError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ValueTooLargeError';
  }
}

/**
 * Thrown when nonce counter approaches exhaustion.
 * Indicates key rotation is required.
 *
 * Rotation is always forward, to a NEW master key — a retired key is never
 * re-promoted, because that would resume a used, unknowable AES-GCM nonce
 * budget. Promote a fresh key to `masterKey` and move the exhausted key into
 * `previousMasterKeys` so existing entries stay readable through the grace
 * window. Runbook: https://docs.cachekit.io/concepts/key-rotation/
 */
export class NonceExhaustedError extends EncryptionError {
  constructor(
    message: string = 'Nonce counter exhausted, key rotation required. ' +
      'Rotate forward to a NEW master key (never re-promote a retired key) and move the ' +
      'exhausted key into previousMasterKeys for the grace window. ' +
      'Runbook: https://docs.cachekit.io/concepts/key-rotation/',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'NonceExhaustedError';
  }
}

/**
 * Thrown when serialization/deserialization fails.
 * Examples: invalid MessagePack, depth limit exceeded.
 */
export class SerializationError extends CachekitError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SerializationError';
  }
}

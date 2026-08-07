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
 */
export class BackendError extends CachekitError {
  readonly classification: import('./backends/error-classifier.js').ErrorClassification;
  constructor(
    message: string,
    classification: import('./backends/error-classifier.js').ErrorClassification = 'permanent',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'BackendError';
    this.classification = classification;
  }
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
      'Rotate forward to a NEW master key (never re-promote a retired key): ' +
      'https://docs.cachekit.io/concepts/key-rotation/',
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

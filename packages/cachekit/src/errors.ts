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
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BackendError';
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
 */
export class NonceExhaustedError extends EncryptionError {
  constructor(
    message: string = 'Nonce counter exhausted, key rotation required',
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

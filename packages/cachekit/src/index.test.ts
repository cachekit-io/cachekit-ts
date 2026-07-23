import { describe, it, expect } from 'vitest';
import * as cachekit from './index.js';
import {
  CachekitError,
  ConfigurationError,
  EncryptionError,
  IntegrityError,
  BackendError,
  CircuitBreakerOpenError,
  TimeoutError,
  ValueTooLargeError,
  NonceExhaustedError,
  SerializationError,
} from './errors.js';

describe('index exports', () => {
  it('should export all error types', () => {
    expect(cachekit.CachekitError).toBe(CachekitError);
    expect(cachekit.ConfigurationError).toBe(ConfigurationError);
    expect(cachekit.EncryptionError).toBe(EncryptionError);
    expect(cachekit.IntegrityError).toBe(IntegrityError);
    expect(cachekit.BackendError).toBe(BackendError);
    expect(cachekit.CircuitBreakerOpenError).toBe(CircuitBreakerOpenError);
    expect(cachekit.TimeoutError).toBe(TimeoutError);
    expect(cachekit.ValueTooLargeError).toBe(ValueTooLargeError);
    expect(cachekit.NonceExhaustedError).toBe(NonceExhaustedError);
    expect(cachekit.SerializationError).toBe(SerializationError);
  });

  // LAB-517: the metrics module and logger hook are public API
  it('should export the observability surface', () => {
    expect(cachekit.CacheMetrics).toBeTypeOf('function');
    expect(cachekit.NoopMetrics).toBeTypeOf('function');
    expect(cachekit.createMetrics).toBeTypeOf('function');
    expect(cachekit.setLogger).toBeTypeOf('function');
  });
});

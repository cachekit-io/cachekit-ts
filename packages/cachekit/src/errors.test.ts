import { describe, it, expect } from 'vitest';
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
} from './errors';

describe('Error types', () => {
  it('CachekitError is instanceof Error', () => {
    const err = new CachekitError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CachekitError);
    expect(err.name).toBe('CachekitError');
  });

  it('ConfigurationError extends CachekitError', () => {
    const err = new ConfigurationError('bad config');
    expect(err).toBeInstanceOf(CachekitError);
    expect(err.name).toBe('ConfigurationError');
  });

  it('NonceExhaustedError extends EncryptionError', () => {
    const err = new NonceExhaustedError();
    expect(err).toBeInstanceOf(EncryptionError);
    expect(err).toBeInstanceOf(CachekitError);
    expect(err.name).toBe('NonceExhaustedError');
  });

  it('supports cause chain', () => {
    const cause = new Error('root cause');
    const err = new BackendError('connection failed', 'permanent', { cause });
    expect(err.cause).toBe(cause);
  });

  it('all error types have correct names', () => {
    const errors = [
      new CachekitError(''),
      new ConfigurationError(''),
      new EncryptionError(''),
      new IntegrityError(''),
      new BackendError(''),
      new CircuitBreakerOpenError(),
      new TimeoutError(),
      new ValueTooLargeError(''),
      new NonceExhaustedError(),
      new SerializationError(''),
    ];

    const expectedNames = [
      'CachekitError',
      'ConfigurationError',
      'EncryptionError',
      'IntegrityError',
      'BackendError',
      'CircuitBreakerOpenError',
      'TimeoutError',
      'ValueTooLargeError',
      'NonceExhaustedError',
      'SerializationError',
    ];

    errors.forEach((err, i) => {
      expect(err.name).toBe(expectedNames[i]);
    });
  });
});

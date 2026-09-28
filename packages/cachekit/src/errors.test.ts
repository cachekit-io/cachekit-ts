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
  isRetryable,
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

  it('BackendError defaults to transient so an unknown cause still trips the breaker', () => {
    expect(new BackendError('Unknown error').classification).toBe('transient');
  });

  it.each([
    ['permanent BackendError', new BackendError('x', 'permanent'), false],
    ['authentication BackendError', new BackendError('x', 'authentication'), false],
    ['transient BackendError', new BackendError('x', 'transient'), true],
    ['timeout BackendError', new BackendError('x', 'timeout'), true],
    ['unclassified BackendError', new BackendError('x'), true],
    ['TimeoutError', new TimeoutError(), true],
    ['plain Error', new Error('x'), true],
  ])('isRetryable(%s) is %s', (_label, error, expected) => {
    expect(isRetryable(error)).toBe(expected);
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

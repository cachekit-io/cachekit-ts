import { describe, it, expect } from 'vitest';
import {
  classifyHttpError,
  classifyNetworkError,
  type ErrorClassification,
} from './error-classifier.js';

describe('Error Classifier', () => {
  const ERROR_MAP: Record<number, ErrorClassification> = {
    401: 'authentication',
    403: 'authentication',
    408: 'transient',
    429: 'transient',
    500: 'transient',
    502: 'transient',
    503: 'transient',
    504: 'transient',
    400: 'permanent',
    404: 'permanent',
    405: 'permanent',
    409: 'permanent',
  };

  for (const [status, expected] of Object.entries(ERROR_MAP)) {
    it(`classifies HTTP ${status} as ${expected}`, () => {
      expect(classifyHttpError(Number(status))).toBe(expected);
    });
  }

  it('classifies timeout errors', () => {
    const err = new DOMException('signal timed out', 'TimeoutError');
    expect(classifyNetworkError(err)).toBe('timeout');
  });

  it('classifies network errors as transient', () => {
    expect(classifyNetworkError(new TypeError('fetch failed'))).toBe('transient');
  });
});

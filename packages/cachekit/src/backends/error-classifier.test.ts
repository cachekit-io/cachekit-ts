import { describe, it, expect } from 'vitest';
import {
  classifyHttpError,
  classifyNetworkError,
  classifyWorkersRuntimeError,
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

  describe('classifyWorkersRuntimeError', () => {
    it("reads the status from Cloudflare's documented 'failed: <status>' position", () => {
      expect(classifyWorkersRuntimeError(new Error('KV PUT failed: 429 Too Many Requests'))).toBe(
        'transient'
      );
      expect(
        classifyWorkersRuntimeError(
          new Error('KV PUT failed: 413 Value length of 26214401 exceeds limit')
        )
      ).toBe('permanent');
      expect(classifyWorkersRuntimeError(new Error('KV GET failed: 401 Unauthorized'))).toBe(
        'authentication'
      );
    });

    it('does NOT treat 4xx/5xx-looking numbers elsewhere in the message as statuses', () => {
      // A byte count is not an HTTP status — must stay the transient default,
      // not become 'permanent' via a phantom 413.
      expect(classifyWorkersRuntimeError(new Error('value exceeds 413 bytes'))).toBe('transient');
      expect(classifyWorkersRuntimeError(new Error('quota 403 of 500 used'))).toBe('transient');
    });

    it('falls back to transient when no status is recognizable', () => {
      expect(
        classifyWorkersRuntimeError(new Error('Cache API keys must be fully-qualified URLs'))
      ).toBe('transient');
    });
  });
});

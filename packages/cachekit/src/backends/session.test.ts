import { describe, it, expect, beforeEach } from 'vitest';
import { getSessionHeaders, _resetSessionForTesting } from './session.js';

describe('Session Tracking', () => {
  beforeEach(() => {
    _resetSessionForTesting();
  });

  it('returns X-CacheKit-Session-ID as valid UUID v4', () => {
    const headers = getSessionHeaders();
    expect(headers['X-CacheKit-Session-ID']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('returns X-CacheKit-Session-Start as epoch millis', () => {
    const before = Date.now();
    const headers = getSessionHeaders();
    const after = Date.now();
    const start = Number(headers['X-CacheKit-Session-Start']);
    expect(start).toBeGreaterThanOrEqual(before);
    expect(start).toBeLessThanOrEqual(after);
  });

  it('returns same session across multiple calls', () => {
    const h1 = getSessionHeaders();
    const h2 = getSessionHeaders();
    expect(h1['X-CacheKit-Session-ID']).toBe(h2['X-CacheKit-Session-ID']);
    expect(h1['X-CacheKit-Session-Start']).toBe(h2['X-CacheKit-Session-Start']);
  });

  it('resets session for testing', () => {
    const h1 = getSessionHeaders();
    _resetSessionForTesting();
    const h2 = getSessionHeaders();
    expect(h1['X-CacheKit-Session-ID']).not.toBe(h2['X-CacheKit-Session-ID']);
  });
});

import { describe, it, expect } from 'vitest';
import { buildMetricsHeaders } from './metrics-headers.js';

describe('Metrics Headers', () => {
  it('returns disabled when no provider given', () => {
    const h = buildMetricsHeaders();
    expect(h).toEqual({ 'X-CacheKit-L1-Status': 'disabled' });
  });

  it('returns disabled when provider returns null', () => {
    const h = buildMetricsHeaders(() => null);
    expect(h).toEqual({ 'X-CacheKit-L1-Status': 'disabled' });
  });

  it('returns disabled when provider throws', () => {
    const h = buildMetricsHeaders(() => {
      throw new Error('boom');
    });
    expect(h).toEqual({ 'X-CacheKit-L1-Status': 'disabled' });
  });

  it('returns disabled when l1Enabled is false', () => {
    const h = buildMetricsHeaders(() => ({ l1Hits: 5, l2Hits: 3, misses: 2, l1Enabled: false }));
    expect(h).toEqual({ 'X-CacheKit-L1-Status': 'disabled' });
  });

  it('calculates correct hit rate', () => {
    const h = buildMetricsHeaders(() => ({ l1Hits: 3, l2Hits: 2, misses: 5, l1Enabled: true }));
    expect(h['X-CacheKit-L1-Status']).toBe('miss');
    expect(h['X-CacheKit-L1-Hits']).toBe('3');
    expect(h['X-CacheKit-L2-Hits']).toBe('2');
    expect(h['X-CacheKit-Misses']).toBe('5');
    expect(h['X-CacheKit-L1-Hit-Rate']).toBe('0.300');
  });

  it('computes L1-Hit-Rate as L1-Hits / (L1-Hits + L2-Hits + Misses), never the share of hits (API-78)', () => {
    const rate = (l1Hits: number, l2Hits: number, misses: number) =>
      buildMetricsHeaders(() => ({ l1Hits, l2Hits, misses, l1Enabled: true }))[
        'X-CacheKit-L1-Hit-Rate'
      ];
    // 2 / (2 + 1 + 1), not 2 / (2 + 1).
    expect(rate(2, 1, 1)).toBe('0.500');
    expect(rate(1, 0, 2)).toBe('0.333');
    expect(rate(2, 0, 1)).toBe('0.667');
    expect(rate(5, 0, 0)).toBe('1.000');
    expect(rate(0, 0, 0)).toBe('0.000');
    for (const [l1, l2, m] of [
      [1, 2, 3],
      [999, 0, 1],
      [1, 999_999, 0],
    ]) {
      expect(rate(l1, l2, m)).toMatch(/^[01]\.[0-9]{3}$/);
    }
  });

  it('sends only L1-Status while telemetry is off (API-96)', () => {
    const h = buildMetricsHeaders(
      () => ({ l1Hits: 3, l2Hits: 2, misses: 5, l1Enabled: true }),
      false
    );
    expect(h).toEqual({ 'X-CacheKit-L1-Status': 'miss' });
  });

  it('handles zero-division with 0.000', () => {
    const h = buildMetricsHeaders(() => ({ l1Hits: 0, l2Hits: 0, misses: 0, l1Enabled: true }));
    expect(h['X-CacheKit-L1-Hit-Rate']).toBe('0.000');
  });
});

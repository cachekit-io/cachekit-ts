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

  it('handles zero-division with 0.000', () => {
    const h = buildMetricsHeaders(() => ({ l1Hits: 0, l2Hits: 0, misses: 0, l1Enabled: true }));
    expect(h['X-CacheKit-L1-Hit-Rate']).toBe('0.000');
  });
});

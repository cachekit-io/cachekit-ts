import { describe, it, expect, vi } from 'vitest';
import { CacheMetrics, NoopMetrics, createMetrics } from './prometheus';

// Mock prom-client (not available in test environment)
vi.mock('prom-client', () => ({
  Counter: class MockCounter {
    inc() {}
  },
  Histogram: class MockHistogram {
    observe() {}
    startTimer() {
      return () => 0;
    }
  },
  Gauge: class MockGauge {
    set() {}
    inc() {}
    dec() {}
  },
}));

describe('CacheMetrics', () => {
  it('creates metrics with default prefix', () => {
    const metrics = new CacheMetrics();
    expect(metrics).toBeDefined();
  });

  it('creates metrics with custom prefix', () => {
    const metrics = new CacheMetrics({ prefix: 'myapp_cache' });
    expect(metrics).toBeDefined();
  });

  it('records operations without error', async () => {
    const metrics = new CacheMetrics();
    await expect(metrics.recordOperation('get', 'success')).resolves.toBeUndefined();
  });

  it('records hits without error', async () => {
    const metrics = new CacheMetrics();
    await expect(metrics.recordHit('l1')).resolves.toBeUndefined();
  });

  it('records misses without error', async () => {
    const metrics = new CacheMetrics();
    await expect(metrics.recordMiss()).resolves.toBeUndefined();
  });

  it('starts and stops timer', async () => {
    const metrics = new CacheMetrics();
    const stop = await metrics.startTimer('get');
    expect(typeof stop).toBe('function');
    stop(); // Should not throw
  });

  it('records errors without error', async () => {
    const metrics = new CacheMetrics();
    await expect(metrics.recordError('timeout')).resolves.toBeUndefined();
  });

  it('updates L1 stats without error', async () => {
    const metrics = new CacheMetrics();
    await expect(metrics.updateL1Stats(100, 1024)).resolves.toBeUndefined();
  });

  it('updates circuit breaker state without error', async () => {
    const metrics = new CacheMetrics();
    await expect(metrics.updateCircuitBreakerState('open')).resolves.toBeUndefined();
  });
});

describe('NoopMetrics', () => {
  it('all methods are no-ops', async () => {
    const metrics = new NoopMetrics();
    await metrics.recordOperation('get', 'success');
    await metrics.recordHit('l1');
    await metrics.recordMiss();
    await metrics.recordError('timeout');
    const stop = await metrics.startTimer('get');
    stop();
    await metrics.updateL1Stats(100, 1024);
    await metrics.updateCircuitBreakerState('open');
    // No errors thrown
  });
});

describe('createMetrics', () => {
  it('returns CacheMetrics when enabled', () => {
    const metrics = createMetrics(true);
    expect(metrics).toBeInstanceOf(CacheMetrics);
  });

  it('returns NoopMetrics when disabled', () => {
    const metrics = createMetrics(false);
    expect(metrics).toBeInstanceOf(NoopMetrics);
  });
});

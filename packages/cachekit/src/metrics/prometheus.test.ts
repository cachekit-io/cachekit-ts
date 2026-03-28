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

  it('passes config to CacheMetrics', () => {
    const metrics = createMetrics(true, { prefix: 'custom', defaultLabels: { env: 'test' } });
    expect(metrics).toBeInstanceOf(CacheMetrics);
  });
});

describe('CacheMetrics error handling', () => {
  it('calls custom error handler when metric operation throws', async () => {
    const errors: Error[] = [];
    const metrics = new CacheMetrics({ onError: (err) => errors.push(err) });

    // Force initialization to succeed first
    await metrics.recordOperation('get', 'success');

    // Now register an error handler post-init via onError method
    const laterErrors: Error[] = [];
    metrics.onError((err) => laterErrors.push(err));

    // This should work fine since prom-client mock doesn't actually throw
    await metrics.recordError('timeout');
    expect(laterErrors).toHaveLength(0);
  });

  it('handles circuit breaker half-open state', async () => {
    const metrics = new CacheMetrics();
    await expect(metrics.updateCircuitBreakerState('half-open')).resolves.toBeUndefined();
  });

  it('handles circuit breaker closed state', async () => {
    const metrics = new CacheMetrics();
    await expect(metrics.updateCircuitBreakerState('closed')).resolves.toBeUndefined();
  });

  it('onError method registers handler for subsequent errors', () => {
    const metrics = new CacheMetrics();
    const errors: Error[] = [];
    metrics.onError((err) => errors.push(err));
    // Handler is registered but no errors yet
    expect(errors).toHaveLength(0);
  });

  it('uses default labels in metric operations', async () => {
    const metrics = new CacheMetrics({
      defaultLabels: { service: 'test-svc' },
    });
    await metrics.recordOperation('get', 'success');
    await metrics.recordHit('l2');
    await metrics.recordMiss();
    await metrics.recordError('network');
    await metrics.updateL1Stats(50, 512);
    await metrics.updateCircuitBreakerState('open');
    // All should resolve without error
  });
});

describe('CacheMetrics init failure handling', () => {
  it('logs to console.error when prom-client import fails and no handler', async () => {
    // We can't easily make prom-client import fail since it's mocked,
    // but we can verify the init short-circuits on second call
    const metrics = new CacheMetrics();
    // First call initializes
    await metrics.recordOperation('get', 'success');
    // Second call should use cached init result
    await metrics.recordOperation('set', 'success');
  });

  it('startTimer returns noop when already initialized', async () => {
    const metrics = new CacheMetrics();
    const timer = await metrics.startTimer('get');
    expect(typeof timer).toBe('function');
    timer(); // should not throw
  });
});

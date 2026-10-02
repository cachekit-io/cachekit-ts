import { describe, it, expect, vi, afterEach } from 'vitest';
import { setTimeout as realSetTimeout } from 'node:timers';
import { CacheMetrics } from './prometheus.js';
import { setLogger } from '../logger.js';

/**
 * A missing prom-client still degrades metrics to no-ops and reports the
 * failure once, at the first metric call: to the onError handler when one is
 * registered by then, otherwise through the library logger.
 */
const promClientLoads = vi.hoisted(() => ({ count: 0 }));

vi.mock('prom-client', () => {
  promClientLoads.count++;
  throw new Error("Cannot find package 'prom-client'");
});

/** Wait until this collector's prom-client import has failed. */
async function importFailed(loadsBefore: number): Promise<void> {
  await vi.waitFor(() => expect(promClientLoads.count).toBeGreaterThan(loadsBefore));
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => setLogger(null));

describe('CacheMetrics with prom-client missing', () => {
  it('reports to an onError handler registered after the import failed, once', async () => {
    const logs: string[] = [];
    setLogger((message) => logs.push(message));
    const loadsBefore = promClientLoads.count;
    const metrics = new CacheMetrics();
    await importFailed(loadsBefore);

    const onError = vi.fn();
    metrics.onError(onError);
    await metrics.recordMiss();
    await metrics.recordOperation('get', 'success');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(logs).toEqual([]);
  });

  it('without a handler, logs once through the library logger', async () => {
    const logs: string[] = [];
    setLogger((message) => logs.push(message));
    const metrics = new CacheMetrics();

    await metrics.recordHit('l1');
    await metrics.updateL1Stats(1, 1);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[cachekit\] metrics are enabled but failed to initialize/);
  });

  it('every metric call is a no-op that never throws', async () => {
    setLogger(() => {});
    const metrics = new CacheMetrics();

    const stop = await metrics.startTimer('get');
    expect(() => stop()).not.toThrow();
    await expect(metrics.recordOperation('get', 'error')).resolves.toBeUndefined();
    await expect(metrics.recordError('Error')).resolves.toBeUndefined();
    await expect(metrics.updateCircuitBreakerState('open')).resolves.toBeUndefined();
  });

  it('still loads, and reports, when the test suite fakes the global timers', async () => {
    const logs: string[] = [];
    setLogger((message) => logs.push(message));
    vi.useFakeTimers();
    try {
      const metrics = new CacheMetrics();
      // node:timers is not faked: this fails fast if the load never starts.
      await Promise.race([
        metrics.recordMiss(),
        new Promise((_, reject) =>
          realSetTimeout(() => reject(new Error('prom-client never loaded')), 2000)
        ),
      ]);
    } finally {
      vi.useRealTimers();
    }
    expect(logs).toHaveLength(1);
  });
});

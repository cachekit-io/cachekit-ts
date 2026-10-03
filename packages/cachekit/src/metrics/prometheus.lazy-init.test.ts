import { describe, it, expect, vi } from 'vitest';
import { createCache } from '../cache.js';
import { InMemoryBackend, metricValue } from '../../test/fixtures/metrics.js';

/**
 * No cache operation may wait for prom-client to load (about 20 ms on a
 * cold Node process), and no metric recorded while it loads may be lost.
 * The mock holds the prom-client import open until the test releases it.
 */
const promClientLoad = vi.hoisted(() => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  return { started: false, released, release };
});

vi.mock('prom-client', async () => {
  promClientLoad.started = true;
  await promClientLoad.released;
  return vi.importActual('prom-client');
});

/** Settle `promise` within `ms`, or fail: an operation must not wait for the import. */
function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('the operation waited for prom-client to load')), ms)
    ),
  ]);
}

describe('CacheMetrics initialization off the operation path', () => {
  it('operations finish while prom-client loads, and their metrics land once it has', async () => {
    const { Registry } = await vi.importActual<typeof import('prom-client')>('prom-client');
    const registry = new Registry();
    const cache = createCache({
      backend: new InMemoryBackend(),
      l1: { enabled: false },
      metrics: { registry },
    });

    expect(await within(2000, cache.get('ns:missing'))).toBeNull();
    await within(2000, cache.set('ns:key', 'value'));
    expect(await registry.getMetricsAsJSON()).toEqual([]);
    // The import starts on the next event-loop turn: Node evaluates an
    // imported CommonJS package in the microtasks after import(), where it
    // would have held up these operations.
    expect(promClientLoad.started).toBe(false);

    // A duration taken when the sample is recorded, not when the operation
    // ran, would include this wait.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(promClientLoad.started).toBe(true);
    promClientLoad.release();

    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_misses_total')).toBe(1);
      expect(
        await metricValue(registry, 'cachekit_operations_total', {
          operation: 'get',
          status: 'success',
        })
      ).toBe(1);
      // The first operations' duration samples are kept, not dropped.
      expect(
        await metricValue(registry, 'cachekit_operation_duration_seconds_count', {
          operation: 'get',
        })
      ).toBe(1);
      expect(
        await metricValue(registry, 'cachekit_operation_duration_seconds_count', {
          operation: 'set',
        })
      ).toBe(1);
    });
    expect(await metricValue(registry, 'cachekit_operation_duration_seconds_sum')).toBeLessThan(
      0.05
    );

    await cache.close();
  });
});

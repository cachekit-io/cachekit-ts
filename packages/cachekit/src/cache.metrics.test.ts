import { describe, it, expect, afterEach, vi } from 'vitest';
import { Counter, Gauge, Registry } from 'prom-client';
import { createCache } from './cache.js';
import { ConfigurationError } from './errors.js';
import type { SecureCache } from './types/cache.js';
import type { Backend } from './backends/types.js';
import { InMemoryBackend, metricValue } from '../test/fixtures/metrics.js';

/**
 * `metrics` must actually work, not be silently
 * accepted. These drive the REAL prom-client (devDependency) through
 * CacheImpl end-to-end — no mocks on the metrics path.
 */

class FailingBackend implements Backend {
  async get(): Promise<Uint8Array | null> {
    throw new Error('backend down');
  }
  async set(): Promise<void> {
    throw new Error('backend down');
  }
  async delete(): Promise<boolean> {
    throw new Error('backend down');
  }
  async exists(): Promise<boolean> {
    throw new Error('backend down');
  }
  async close(): Promise<void> {}
}

describe('Cache metrics wiring', () => {
  const caches: SecureCache[] = [];

  function makeCache(
    registry: Registry,
    overrides: Partial<Parameters<typeof createCache>[0]> = {}
  ): SecureCache {
    const cache = createCache({
      backend: new InMemoryBackend(),
      defaultTtl: 3600,
      l1: { enabled: true, maxEntries: 100 },
      metrics: { registry },
      ...overrides,
    });
    caches.push(cache);
    return cache;
  }

  afterEach(async () => {
    await Promise.all(caches.splice(0).map((c) => c.close()));
  });

  it('records misses and get operations', async () => {
    const registry = new Registry();
    const cache = makeCache(registry);

    expect(await cache.get('ns:missing')).toBeNull();

    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_misses_total')).toBe(1);
      expect(
        await metricValue(registry, 'cachekit_operations_total', {
          operation: 'get',
          status: 'success',
        })
      ).toBe(1);
    });
  });

  it('records L2 outcomes for exists()', async () => {
    const registry = new Registry();
    const cache = makeCache(registry, { l1: { enabled: false } });
    await cache.set('ns:present', 'value');

    expect(await cache.exists('ns:present')).toBe(true); // L2 hit
    expect(await cache.exists('ns:absent')).toBe(false); // miss

    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l2' })).toBe(1);
      expect(await metricValue(registry, 'cachekit_misses_total')).toBe(1);
    });
  });

  it('records l1 hits after set, and l2 hits when L1 is disabled', async () => {
    const registry = new Registry();
    const cache = makeCache(registry);
    await cache.set('ns:key', 'value');
    expect(await cache.get('ns:key')).toBe('value'); // L1 hit

    const registry2 = new Registry();
    const noL1 = makeCache(registry2, { l1: { enabled: false } });
    await noL1.set('ns:key', 'value');
    expect(await noL1.get('ns:key')).toBe('value'); // L2 hit

    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1' })).toBe(1);
      expect(await metricValue(registry2, 'cachekit_hits_total', { layer: 'l2' })).toBe(1);
    });
  });

  it('records set/delete operations and observes durations', async () => {
    const registry = new Registry();
    const cache = makeCache(registry);

    await cache.set('ns:key', 'value');
    await cache.delete('ns:key');

    await vi.waitFor(async () => {
      expect(
        await metricValue(registry, 'cachekit_operations_total', {
          operation: 'set',
          status: 'success',
        })
      ).toBe(1);
      expect(
        await metricValue(registry, 'cachekit_operations_total', {
          operation: 'delete',
          status: 'success',
        })
      ).toBe(1);
      expect(
        await metricValue(registry, 'cachekit_operation_duration_seconds_count', {
          operation: 'set',
        })
      ).toBe(1);
    });
  });

  it('records errors when the backend fails (degradation still swallows)', async () => {
    const registry = new Registry();
    const cache = makeCache(registry, { backend: new FailingBackend(), l1: { enabled: false } });

    // Degradation (default on) returns the fallback instead of throwing
    expect(await cache.get('ns:key')).toBeNull();

    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_errors_total', { error_type: 'Error' })).toBe(1);
      expect(
        await metricValue(registry, 'cachekit_operations_total', {
          operation: 'get',
          status: 'error',
        })
      ).toBe(1);
    });
  });

  it('updates L1 gauges and circuit-breaker gauge', async () => {
    const registry = new Registry();
    const cache = makeCache(registry, {
      reliability: { circuitBreaker: { failureThreshold: 5 } },
    });

    await cache.set('ns:a', 'value');
    await cache.set('ns:b', 'value');

    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_l1_entries')).toBe(2);
      expect(await metricValue(registry, 'cachekit_l1_memory_bytes')).toBeGreaterThan(0);
      // closed = 0; the gauge exists with a recorded value
      const metrics = await registry.getMetricsAsJSON();
      const cb = metrics.find((m) => m.name === 'cachekit_circuit_breaker_state');
      expect(cb).toBeDefined();
      expect(cb?.values[0]?.value).toBe(0);
    });
  });

  it('records hits and misses through wrap(), including the L1 SWR path', async () => {
    const registry = new Registry();
    const cache = makeCache(registry);

    const fn = vi.fn(async (id: number) => ({ id }));
    const wrapped = cache.wrap(fn, { namespace: 'users:get', ttl: 60 });

    await wrapped(1); // miss → compute → set
    await wrapped(1); // L1 hit via SWR path

    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_misses_total')).toBe(1);
      expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1' })).toBe(1);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('two caches sharing a registry reuse metrics instead of throwing on duplicates', async () => {
    const registry = new Registry();
    const cacheA = makeCache(registry);
    const cacheB = makeCache(registry);

    await cacheA.get('ns:miss-a');
    await cacheB.get('ns:miss-b');

    await vi.waitFor(async () => {
      // Both misses land on the shared counter — second init did not fail
      expect(await metricValue(registry, 'cachekit_misses_total')).toBe(2);
    });
  });

  // Hits and misses are counted in plain fields and read into prom-client at
  // scrape time: every scrape must report each op exactly once.
  it('scrapes each hit and miss exactly once, however often it scrapes', async () => {
    const registry = new Registry();
    const cacheA = makeCache(registry);
    const cacheB = makeCache(registry);
    const wrapped = cacheA.wrap(async (id: number) => ({ id }), { namespace: 'n', ttl: 60 });

    await wrapped(1); // miss
    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_misses_total')).toBe(1);
    });

    for (let i = 0; i < 5; i++) await wrapped(1); // 5 L1 hits
    await cacheB.set('ns:k', 'v');
    expect(await cacheB.get('ns:k')).toBe('v'); // L1 hit on the shared counter
    expect(await cacheB.get('ns:absent')).toBeNull(); // miss
    expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1' })).toBe(6);
    expect(await metricValue(registry, 'cachekit_misses_total')).toBe(2);
    // A second scrape with no ops in between adds nothing.
    expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1' })).toBe(6);
    expect(await registry.metrics()).toContain('cachekit_hits_total{layer="l1"} 6');

    await wrapped(1);
    expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1' })).toBe(7);

    // A hit recorded before prom-client has loaded lands once it has.
    const early = new Registry();
    const noL1 = makeCache(early, { l1: { enabled: false } });
    await noL1.set('ns:k', 'v');
    expect(await noL1.get('ns:k')).toBe('v'); // L2 hit
    await vi.waitFor(async () => {
      expect(await metricValue(early, 'cachekit_hits_total', { layer: 'l2' })).toBe(1);
    });
    await noL1.get('ns:k');
    expect(await metricValue(early, 'cachekit_hits_total', { layer: 'l2' })).toBe(2);
  });

  it('defaultLabels label every metric', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = new Registry();
    const cache = makeCache(registry, { metrics: { registry, defaultLabels: { env: 'prod' } } });

    await cache.set('ns:k', 'v');
    await cache.get('ns:k'); // L1 hit
    await cache.get('ns:absent'); // miss

    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1', env: 'prod' })).toBe(
        1
      );
      expect(await metricValue(registry, 'cachekit_misses_total', { env: 'prod' })).toBe(1);
      expect(
        await metricValue(registry, 'cachekit_operations_total', {
          operation: 'set',
          status: 'success',
          env: 'prod',
        })
      ).toBe(1);
      expect(await metricValue(registry, 'cachekit_l1_entries', { env: 'prod' })).toBe(1);
    });
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('reset and remove clear hits and misses recorded before them', async () => {
    const registry = new Registry();
    const cache = makeCache(registry);
    await cache.set('ns:k', 'v');
    await cache.get('ns:k');
    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1' })).toBe(1);
    });

    await cache.get('ns:k');
    await cache.get('ns:absent');
    registry.resetMetrics();
    expect(await metricValue(registry, 'cachekit_hits_total')).toBe(0);
    expect(await metricValue(registry, 'cachekit_misses_total')).toBe(0);

    await cache.get('ns:k');
    const hits = registry.getSingleMetric('cachekit_hits_total');
    if (!(hits instanceof Counter)) throw new Error('cachekit_hits_total is not a Counter');
    hits.reset();
    expect(await metricValue(registry, 'cachekit_hits_total')).toBe(0);

    await cache.get('ns:k'); // l1
    hits.inc({ layer: 'l2' }); // a series to keep
    hits.remove('l1');
    expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1' })).toBe(0);
    expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l2' })).toBe(1);

    await cache.get('ns:k');
    expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1' })).toBe(1);
  });

  it('L2 hits and misses after a reset count once each', async () => {
    const registry = new Registry();
    const cache = makeCache(registry, { l1: { enabled: false } });
    await cache.set('ns:k', 'v');
    await cache.get('ns:k'); // L2 hit
    await cache.get('ns:absent'); // miss
    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l2' })).toBe(1);
      expect(await metricValue(registry, 'cachekit_misses_total')).toBe(1);
    });
    registry.resetMetrics();

    await cache.get('ns:k');
    await cache.get('ns:k');
    await cache.get('ns:absent');
    expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l2' })).toBe(2);
    expect(await metricValue(registry, 'cachekit_misses_total')).toBe(1);
  });

  it('a counter that throws while adding pending counts fails no scrape', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = new Registry();
    const cache = makeCache(registry);
    await cache.get('ns:absent');
    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_misses_total')).toBe(1);
    });
    const misses = registry.getSingleMetric('cachekit_misses_total');
    if (!(misses instanceof Counter)) throw new Error('cachekit_misses_total is not a Counter');
    vi.spyOn(misses, 'inc').mockImplementation(() => {
      throw new Error('inc failed');
    });

    await cache.get('ns:absent');
    await expect(registry.metrics()).resolves.toContain('cachekit_misses_total 1');
    expect(consoleSpy).toHaveBeenCalledWith(
      '[cachekit] metrics: dropped 1 pending counts on cachekit_misses_total:',
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });

  it('a cache counting after a reset joins a cache created since', async () => {
    const registry = new Registry();
    const before = makeCache(registry);
    await before.set('ns:k', 'v');
    await before.get('ns:k');
    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1' })).toBe(1);
    });
    registry.resetMetrics();

    const since = makeCache(registry);
    await since.set('ns:k', 'v');
    await since.get('ns:k');
    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1' })).toBe(1);
    });
    await before.get('ns:k');
    await before.get('ns:k');
    expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1' })).toBe(3);
    expect(await registry.metrics()).toContain('cachekit_hits_total{layer="l1"} 3');
  });

  it.each(['layer', 'operation', 'status', 'error_type'])(
    'rejects a defaultLabels key the metrics set themselves: %s',
    (label) => {
      expect(() =>
        createCache({
          backend: new InMemoryBackend(),
          metrics: { registry: new Registry(), defaultLabels: { [label]: 'x' } },
        })
      ).toThrow(ConfigurationError);
    }
  );

  it.each<[string, Partial<Parameters<typeof createCache>[0]>]>([
    ['an invalid backend URL', { backend: { url: 'not a valid URL' } }],
    ['distributedLock without a lockable backend', { stampede: { distributedLock: true } }],
  ])('a cache that fails to construct (%s) registers no metrics', async (_name, options) => {
    const registry = new Registry();
    expect(() =>
      createCache({ backend: new InMemoryBackend(), metrics: { registry }, ...options })
    ).toThrow(ConfigurationError);
    // prom-client would load on a later turn: give it two.
    for (let i = 0; i < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await registry.getMetricsAsJSON()).toHaveLength(0);

    // so a later cache on that registry sets the schema
    const cache = makeCache(registry, { metrics: { registry, defaultLabels: { env: 'prod' } } });
    await cache.get('ns:absent');
    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_misses_total', { env: 'prod' })).toBe(1);
    });
  });

  it('counts into a hits counter registered by someone else', async () => {
    const registry = new Registry();
    new Counter({
      name: 'cachekit_hits_total',
      help: 'registered first by the application',
      labelNames: ['layer'],
      registers: [registry],
    });
    const cache = makeCache(registry);
    await cache.set('ns:k', 'v');
    await cache.get('ns:k');

    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1' })).toBe(1);
    });
    await cache.get('ns:k');
    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'cachekit_hits_total', { layer: 'l1' })).toBe(2);
    });
  });

  // Anything else writing the gauge directly (an older SDK copy on the same
  // registry, or the application) is ordered against the cache's own writes,
  // as prom-client orders any two set() calls, whatever form the labels take.
  it('a direct write to the breaker gauge orders with the cache writes around it', async () => {
    const registry = new Registry();
    const cache = makeCache(registry, {
      l1: { enabled: false },
      reliability: { circuitBreaker: { failureThreshold: 5 } },
    });
    await cache.set('ns:k', 'v');
    await vi.waitFor(async () => {
      expect(await registry.metrics()).toContain('cachekit_circuit_breaker_state 0');
    });
    const gauge = registry.getSingleMetric('cachekit_circuit_breaker_state') as Gauge;
    const breaker = () => metricValue(registry, 'cachekit_circuit_breaker_state');

    await cache.get('ns:k'); // closed
    gauge.set(1);
    expect(await breaker()).toBe(1);
    expect(await breaker()).toBe(1);

    await cache.get('ns:k');
    gauge.inc(0.5);
    expect(await breaker()).toBe(0.5);

    gauge.set(1);
    await cache.get('ns:k'); // closed, after the direct write
    expect(await breaker()).toBe(0);
  });

  // prom-client stringifies label values, so { tenant: 42 } is the series a
  // cache with defaultLabels { tenant: '42' } writes.
  it('a direct write with numeric label values orders with the cache writes', async () => {
    const registry = new Registry();
    const cache = makeCache(registry, {
      l1: { enabled: false },
      reliability: { circuitBreaker: { failureThreshold: 5 } },
      metrics: { registry, defaultLabels: { tenant: '42' } },
    });
    await cache.set('ns:k', 'v');
    await vi.waitFor(async () => {
      expect(await registry.metrics()).toContain('cachekit_circuit_breaker_state{tenant="42"} 0');
    });
    const gauge = registry.getSingleMetric('cachekit_circuit_breaker_state') as Gauge;
    const breaker = () => metricValue(registry, 'cachekit_circuit_breaker_state');
    const numeric = { tenant: 42 } as unknown as Record<string, string>;

    await cache.get('ns:k'); // closed
    gauge.set(numeric, 1);
    expect(await breaker()).toBe(1);
    gauge.labels(numeric).inc(0.5);
    expect(await breaker()).toBe(1.5);
    await cache.get('ns:k');
    expect(await breaker()).toBe(0);
  });

  it('counts attempts and the breaker state into metrics registered by someone else', async () => {
    const registry = new Registry();
    new Counter({
      name: 'cachekit_operations_total',
      help: 'registered first by the application',
      labelNames: ['operation', 'status'],
      registers: [registry],
    });
    new Gauge({
      name: 'cachekit_circuit_breaker_state',
      help: 'registered first by the application',
      registers: [registry],
    }).set(7);
    const cache = makeCache(registry, {
      l1: { enabled: false },
      reliability: { circuitBreaker: { failureThreshold: 5 } },
    });
    await cache.set('ns:k', 'v');
    await cache.get('ns:k');

    await vi.waitFor(async () => {
      expect(
        await metricValue(registry, 'cachekit_operations_total', {
          operation: 'get',
          status: 'success',
        })
      ).toBe(1);
      expect(await metricValue(registry, 'cachekit_circuit_breaker_state')).toBe(0);
    });
    await cache.get('ns:k');
    await vi.waitFor(async () => {
      expect(
        await metricValue(registry, 'cachekit_operations_total', {
          operation: 'get',
          status: 'success',
        })
      ).toBe(2);
    });
  });

  // A backend attempt's counts and the breaker state are read at scrape time.
  // These are the values each attempt recorded as it ran: two caches share
  // one registry, so the breaker gauge holds the state of whichever cache
  // finished an op last.
  it('scrapes backend attempts and the breaker state as recorded per op', async () => {
    const registry = new Registry();
    const reliability = { circuitBreaker: { failureThreshold: 1 }, retry: { maxAttempts: 1 } };
    const healthy = makeCache(registry, { l1: { enabled: false }, reliability });
    const failing = makeCache(registry, {
      backend: new FailingBackend(),
      l1: { enabled: false },
      reliability,
    });
    const scrape = async () => ({
      getOk: await metricValue(registry, 'cachekit_operations_total', {
        operation: 'get',
        status: 'success',
      }),
      getError: await metricValue(registry, 'cachekit_operations_total', {
        operation: 'get',
        status: 'error',
      }),
      setOk: await metricValue(registry, 'cachekit_operations_total', {
        operation: 'set',
        status: 'success',
      }),
      getTimed: await metricValue(registry, 'cachekit_operation_duration_seconds_count', {
        operation: 'get',
      }),
      errors: await metricValue(registry, 'cachekit_errors_total'),
      breaker: (await registry.getSingleMetricAsString('cachekit_circuit_breaker_state'))
        .split('\n')
        .find((line) => line.startsWith('cachekit_circuit_breaker_state')),
    });
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    await healthy.set('ns:k', 'v');
    await vi.waitFor(async () => {
      expect((await scrape()).setOk).toBe(1);
    });
    expect(await healthy.get('ns:k')).toBe('v');
    await settle();
    expect(await scrape()).toEqual({
      getOk: 1,
      getError: 0,
      setOk: 1,
      getTimed: 1,
      errors: 0,
      breaker: 'cachekit_circuit_breaker_state 0',
    });

    // The error path: one failed attempt opens the failing cache's breaker.
    expect(await failing.get('ns:k')).toBeNull();
    await settle();
    const opened = {
      getOk: 1,
      getError: 1,
      setOk: 1,
      getTimed: 2,
      errors: 1,
      breaker: 'cachekit_circuit_breaker_state 1',
    };
    expect(await scrape()).toEqual(opened);
    // A second scrape with no ops in between reads the same.
    expect(await scrape()).toEqual(opened);

    // The healthy cache finishes an op last: the shared gauge reads closed.
    expect(await healthy.get('ns:k')).toBe('v');
    await settle();
    expect(await scrape()).toEqual({
      ...opened,
      getOk: 2,
      getTimed: 3,
      breaker: 'cachekit_circuit_breaker_state 0',
    });

    // An open breaker rejects without a backend attempt, and still publishes.
    expect(await failing.get('ns:k')).toBeNull();
    await settle();
    expect(await scrape()).toEqual({ ...opened, getOk: 2, getTimed: 3 });

    // A reset zeroes the gauge (prom-client resets an unlabelled gauge to 0)
    // until the next op publishes the state again, including a state and an
    // attempt recorded since the last scrape.
    expect(await healthy.get('ns:k')).toBe('v');
    expect(await failing.get('ns:k')).toBeNull();
    await settle();
    registry.resetMetrics();
    const zero = { getOk: 0, getError: 0, setOk: 0, getTimed: 0, errors: 0 };
    expect(await scrape()).toEqual({ ...zero, breaker: 'cachekit_circuit_breaker_state 0' });
    expect(await failing.get('ns:k')).toBeNull();
    expect(await healthy.get('ns:k')).toBe('v');
    expect(await failing.get('ns:k')).toBeNull();
    await settle();
    expect(await scrape()).toEqual({
      ...zero,
      getOk: 1,
      getTimed: 1,
      breaker: 'cachekit_circuit_breaker_state 1',
    });
  });

  it('supports a custom prefix', async () => {
    const registry = new Registry();
    const cache = makeCache(registry, { metrics: { registry, prefix: 'myapp' } });

    await cache.get('ns:missing');

    await vi.waitFor(async () => {
      expect(await metricValue(registry, 'myapp_misses_total')).toBe(1);
    });
  });

  it('metrics disabled (default) records nothing and touches no registry', async () => {
    const registry = new Registry();
    const cache = createCache({
      backend: new InMemoryBackend(),
      l1: { enabled: true },
    });
    caches.push(cache);

    await cache.set('ns:key', 'value');
    await cache.get('ns:key');
    await cache.get('ns:missing');

    expect(await registry.getMetricsAsJSON()).toHaveLength(0);
  });
});

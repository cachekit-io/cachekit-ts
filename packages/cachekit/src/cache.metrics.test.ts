import { describe, it, expect, afterEach, vi } from 'vitest';
import { Registry } from 'prom-client';
import { createCache } from './cache.js';
import type { SecureCache } from './types/cache.js';
import type { Backend } from './backends/types.js';

/**
 * LAB-517 regression tests: `metrics` must actually work, not be silently
 * accepted. These drive the REAL prom-client (devDependency) through
 * CacheImpl end-to-end — no mocks on the metrics path.
 */

class InMemoryBackend implements Backend {
  store = new Map<string, Uint8Array>();
  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: Uint8Array): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async close(): Promise<void> {}
}

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

async function metricValue(
  registry: Registry,
  name: string,
  labels?: Record<string, string>
): Promise<number> {
  const metrics = await registry.getMetricsAsJSON();
  return metrics
    .flatMap((m) =>
      m.values.map((v) => ({
        value: v.value,
        labels: v.labels,
        // prom-client emits metricName on histogram sub-series
        // (_count/_sum/_bucket) at runtime but omits it from MetricValue's
        // declared type — narrow only that one optional field.
        seriesName: (v as { metricName?: string }).metricName ?? m.name,
      }))
    )
    .filter((v) => v.seriesName === name)
    .filter((v) => !labels || Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0);
}

describe('Cache metrics wiring (LAB-517)', () => {
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

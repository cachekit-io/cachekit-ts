import type { Registry } from 'prom-client';
import type { Backend } from '../../src/backends/types.js';

/**
 * Shared by the metrics tests. prom-client is imported for its types only,
 * so a test that holds the prom-client import open can still use these.
 */

export class InMemoryBackend implements Backend {
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

/** The sum of a metric's series values, optionally narrowed to `labels`. */
export async function metricValue(
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

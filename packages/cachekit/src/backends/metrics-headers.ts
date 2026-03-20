import type { L1Metrics } from './types.js';

export function buildMetricsHeaders(provider?: () => L1Metrics | null): Record<string, string> {
  const disabled = { 'X-CacheKit-L1-Status': 'disabled' };
  if (!provider) return disabled;
  let stats: L1Metrics | null;
  try {
    stats = provider();
  } catch {
    return disabled;
  }
  if (!stats || !stats.l1Enabled) return disabled;
  const total = stats.l1Hits + stats.l2Hits + stats.misses;
  const hitRate = total > 0 ? stats.l1Hits / total : 0;
  return {
    'X-CacheKit-L1-Status': 'miss',
    'X-CacheKit-L1-Hits': String(stats.l1Hits),
    'X-CacheKit-L2-Hits': String(stats.l2Hits),
    'X-CacheKit-Misses': String(stats.misses),
    'X-CacheKit-L1-Hit-Rate': hitRate.toFixed(3),
  };
}

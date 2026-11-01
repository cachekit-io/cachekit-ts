import type { L1Metrics } from './types.js';

/**
 * `X-CacheKit-L1-Status`, plus the session counters and hit rate while
 * `telemetry` is on. With it off only L1-Status goes, which API-1 requires on
 * every `ck_sdk_` request (API-96).
 */
export function buildMetricsHeaders(
  provider: (() => L1Metrics | null) | undefined,
  telemetry: boolean
): Record<string, string> {
  const disabled = { 'X-CacheKit-L1-Status': 'disabled' };
  if (!provider) return disabled;
  let stats: L1Metrics | null;
  try {
    stats = provider();
  } catch {
    return disabled;
  }
  if (!stats || !stats.l1Enabled) return disabled;
  if (!telemetry) return { 'X-CacheKit-L1-Status': 'miss' };
  // API-78: the share of all counted operations, misses included.
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

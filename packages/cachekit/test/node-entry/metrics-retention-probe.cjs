// Builds 500 metrics collectors on one registry, each with its own tenant
// default label, counts a hit, a miss and a backend attempt on each and sets
// its breaker state, clears their samples, drops them, and reports how many of
// their label objects outlive garbage collection (their default labels and
// their hit and attempt cells' copies), and what a collector kept alive
// records after the clear:
//
//   node --expose-gc metrics-retention-probe.cjs <path to dist/cjs/index.js> <reset|remove>
const path = require('node:path');

const [entry, mode] = process.argv.slice(2);
const { CacheMetrics } = require(entry);
const { Registry } = require(require.resolve('prom-client', { paths: [path.dirname(entry)] }));

// Built outside the async function below: a suspended async function can keep
// a stale register holding the last label object, which this probe would
// then report as kept.
function build(registry, refs) {
  const collectors = [];
  for (let i = 0; i < 500; i++) {
    const labels = { tenant: `t${i}` };
    refs.push(new WeakRef(labels));
    collectors.push(new CacheMetrics({ registry, defaultLabels: labels }));
  }
  return collectors;
}

// A hit or attempt cell holds its own copy of the labels ({ layer,
// ...defaultLabels }); the first flush hands that copy to prom-client, which
// keeps it as the series' labels and returns it from get(). Track those
// copies too. A breaker state cell holds the default labels themselves.
async function trackCellLabels(counter, refs) {
  for (const { labels } of (await counter.get()).values) {
    if (labels.tenant !== 'live') refs.push(new WeakRef(labels));
  }
}

const liveValue = async (metric) =>
  (await metric.get()).values
    .filter((v) => v.labels.tenant === 'live')
    .reduce((sum, v) => sum + v.value, 0);

(async () => {
  const registry = new Registry();
  const refs = [];
  let collectors = build(registry, refs);
  const live = new CacheMetrics({ registry, defaultLabels: { tenant: 'live' } });
  // recordHit waits for prom-client, which loads on a later turn.
  await Promise.all(collectors.map((c) => c.recordHit('l1')));
  collectors.forEach((c) => {
    c.countMiss();
    c.countOperation('get', 'success');
    c.setCircuitBreakerState('open');
  });
  await live.recordHit('l1');
  live.setCircuitBreakerState('closed');

  const hits = registry.getSingleMetric('cachekit_hits_total');
  const misses = registry.getSingleMetric('cachekit_misses_total');
  const operations = registry.getSingleMetric('cachekit_operations_total');
  const breaker = registry.getSingleMetric('cachekit_circuit_breaker_state');
  await trackCellLabels(hits, refs);
  await trackCellLabels(operations, refs);
  await registry.metrics();
  if (mode === 'reset') {
    registry.resetMetrics();
  } else {
    for (let i = 0; i < 500; i++) {
      hits.remove({ layer: 'l1', tenant: `t${i}` });
      misses.remove({ tenant: `t${i}` });
      operations.remove({ operation: 'get', status: 'success', tenant: `t${i}` });
      breaker.remove({ tenant: `t${i}` });
    }
    hits.remove({ layer: 'l1', tenant: 'live' });
    breaker.remove({ tenant: 'live' });
  }
  collectors = null;
  await live.recordHit('l1');
  await live.recordHit('l1');
  live.countOperation('get', 'success');
  live.countOperation('get', 'success');
  live.setCircuitBreakerState('open');

  // No number of collections is guaranteed to clear a WeakRef, so collect
  // until none is left or 5 s pass. A deref() keeps its target until the end
  // of the turn, so each count runs after the collection, on a new turn.
  const deadline = Date.now() + 5_000;
  let alive;
  do {
    await new Promise((resolve) => setTimeout(resolve, 20));
    global.gc();
    alive = refs.filter((ref) => ref.deref() !== undefined).length;
  } while (alive > 0 && Date.now() < deadline);
  const liveHits = await liveValue(hits);
  const liveOperations = await liveValue(operations);
  const liveBreaker = await liveValue(breaker);
  console.log(
    JSON.stringify({ tracked: refs.length, alive, liveHits, liveOperations, liveBreaker })
  );
})();

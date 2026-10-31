// Builds 500 metrics collectors on one registry, each with its own tenant
// default label, counts a hit and a miss on each, clears their samples, drops
// them, and reports how many of their label objects outlive garbage
// collection, and what a collector kept alive counts after the clear:
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

(async () => {
  const registry = new Registry();
  const refs = [];
  let collectors = build(registry, refs);
  const live = new CacheMetrics({ registry, defaultLabels: { tenant: 'live' } });
  // recordHit waits for prom-client, which loads on a later turn.
  await Promise.all(collectors.map((c) => c.recordHit('l1')));
  collectors.forEach((c) => c.countMiss());
  await live.recordHit('l1');
  await registry.metrics();

  const hits = registry.getSingleMetric('cachekit_hits_total');
  const misses = registry.getSingleMetric('cachekit_misses_total');
  if (mode === 'reset') {
    registry.resetMetrics();
  } else {
    for (let i = 0; i < 500; i++) {
      hits.remove({ layer: 'l1', tenant: `t${i}` });
      misses.remove({ tenant: `t${i}` });
    }
    hits.remove({ layer: 'l1', tenant: 'live' });
  }
  collectors = null;
  await live.recordHit('l1');
  await live.recordHit('l1');

  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    global.gc();
  }
  const liveHits = (await hits.get()).values
    .filter((v) => v.labels.tenant === 'live')
    .reduce((sum, v) => sum + v.value, 0);
  const alive = refs.filter((ref) => ref.deref() !== undefined).length;
  console.log(JSON.stringify({ alive, liveHits }));
})();

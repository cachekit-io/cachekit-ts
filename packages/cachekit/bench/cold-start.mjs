// Cold start of the Node entry: module load and the first op, per fresh process.
//
//   node bench/cold-start.mjs [--k 9] [--json out.json]
//
// Each sample is a new node process that imports dist/index.js, builds a cache
// on an in-memory backend, and times its first two wrap() calls (both misses,
// so the second is the warm baseline for the first). Arms run interleaved,
// order rotated each round, so host drift lands on every arm alike. Reports
// median and min-max per arm. Wall clock on a shared host: claim only deltas
// larger than the min-max band. Imports the built package: run `pnpm build` first.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// The arms differ in what the first op loads lazily. `default (A/A)` is the
// same config as `default`: their difference is this run's noise floor.
const ARMS = {
  default: { metrics: false },
  'default (A/A)': { metrics: false },
  // first op dynamic-imports prom-client
  metrics: { metrics: true },
  // first op loads the NAPI core and derives the tenant keys
  secure: { metrics: false, encryption: { masterKey: 'a'.repeat(64) } },
};

const self = fileURLToPath(import.meta.url);

async function probe(arm) {
  const t0 = performance.now();
  const { createCache } = await import(new URL('../dist/index.js', import.meta.url));
  const importMs = performance.now() - t0;
  const map = new Map();
  const backend = {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => void map.set(key, value),
    delete: async (key) => map.delete(key),
    exists: async (key) => map.has(key),
    close: async () => {},
  };
  const cache = createCache({ backend, ...ARMS[arm] });
  const getUser = cache.wrap(async (id) => ({ id, name: `user-${id}` }), {
    namespace: 'cold',
    ttl: 60,
  });
  let t = performance.now();
  await getUser(1);
  const firstOpMs = performance.now() - t;
  t = performance.now();
  await getUser(2);
  const secondOpMs = performance.now() - t;
  await cache.close();
  console.log(JSON.stringify({ importMs, firstOpMs, secondOpMs }));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const band = (xs) => ({
  median: +median(xs).toFixed(2),
  min: +Math.min(...xs).toFixed(2),
  max: +Math.max(...xs).toFixed(2),
});

if (process.argv[2] === '--probe') {
  await probe(process.argv[3]);
} else {
  const { values: opt } = parseArgs({
    options: { k: { type: 'string', default: '9' }, json: { type: 'string' } },
  });
  const k = Number(opt.k);
  if (!(k >= 3)) throw new Error('--k must be at least 3');
  const names = Object.keys(ARMS);
  const samples = Object.fromEntries(names.map((arm) => [arm, []]));
  for (let round = 0; round < k; round++) {
    for (let i = 0; i < names.length; i++) {
      const arm = names[(i + round) % names.length];
      const out = execFileSync(process.execPath, [self, '--probe', arm], { encoding: 'utf8' });
      samples[arm].push(JSON.parse(out.trim().split('\n').pop()));
    }
  }
  const result = {
    node: process.version,
    k,
    arms: Object.fromEntries(
      names.map((arm) => [
        arm,
        {
          importMs: band(samples[arm].map((s) => s.importMs)),
          firstOpMs: band(samples[arm].map((s) => s.firstOpMs)),
          secondOpMs: band(samples[arm].map((s) => s.secondOpMs)),
        },
      ])
    ),
  };
  if (opt.json) writeFileSync(opt.json, JSON.stringify(result, null, 2) + '\n');
  const aa = (metric) =>
    Math.abs(
      result.arms.default[metric].median - result.arms['default (A/A)'][metric].median
    ).toFixed(2);
  console.log(`node ${process.version}, k = ${k} processes per arm, interleaved`);
  console.log(
    `A/A floor (|default - default (A/A)| of medians): import ${aa('importMs')} ms, first op ${aa('firstOpMs')} ms`
  );
  console.table(
    Object.fromEntries(
      Object.entries(result.arms).map(([arm, r]) => [
        arm,
        Object.fromEntries(
          Object.entries(r).map(([metric, b]) => [metric, `${b.median} (${b.min}-${b.max})`])
        ),
      ])
    )
  );
}

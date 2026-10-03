// Cold start of the Node entry: module load and the first ops, per fresh process.
//
//   node bench/cold-start.mjs [--k 9] [--json out.json] [--entry esm|cjs]
//                             [--latency ms] [--base <dist dir>]
//
// Each sample is a new node process that loads the entry (`--entry esm`
// imports dist/index.js, `cjs` requires dist/cjs/index.js), builds a cache on
// an in-memory backend, and times its first three wrap() calls (all misses,
// so ops 2 and 3 are the warm baseline for the first, and show any cost that
// merely moved off op 1). `--latency` makes every backend call wait that many
// ms on a timer, standing in for a network round trip. Arms run interleaved,
// order rotated each round, so host drift lands on every arm alike. Reports
// median and min-max per arm. Wall clock on a shared host: claim only deltas
// larger than the min-max band. Imports the built package: run `pnpm build` first.
//
// `--base <dist dir>` also runs every arm on a second build (for example the
// merge base's dist, copied inside this package so its dependencies resolve)
// in the same rotation, and reports base minus head per arm as the median of
// the per-round differences.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// The arms differ in what the first op loads lazily. `default (A/A)` is the
// same config as `default`: their difference is this run's noise floor.
const ARMS = {
  default: { metrics: false },
  'default (A/A)': { metrics: false },
  // the collector loads prom-client (dynamic import)
  metrics: { metrics: true },
  // first op loads the NAPI core and derives the tenant keys
  secure: { metrics: false, encryption: { masterKey: 'a'.repeat(64) } },
};
const OPS = 3;

const self = fileURLToPath(import.meta.url);
const HEAD_DIST = fileURLToPath(new URL('../dist', import.meta.url));

async function loadEntry(dist, entry) {
  if (entry === 'cjs') return createRequire(import.meta.url)(join(dist, 'cjs', 'index.js'));
  return import(pathToFileURL(join(dist, 'index.js')).href);
}

async function probe(dist, arm, entry, latencyMs) {
  const t0 = performance.now();
  const { createCache } = await loadEntry(dist, entry);
  const importMs = performance.now() - t0;
  const map = new Map();
  const backend = {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => void map.set(key, value),
    delete: async (key) => map.delete(key),
    exists: async (key) => map.has(key),
    close: async () => {},
  };
  if (latencyMs > 0) {
    for (const name of ['get', 'set', 'delete', 'exists']) {
      const call = backend[name];
      backend[name] = async (...args) => {
        await new Promise((done) => setTimeout(done, latencyMs));
        return call(...args);
      };
    }
  }
  const cache = createCache({ backend, ...ARMS[arm] });
  const getUser = cache.wrap(async (id) => ({ id, name: `user-${id}` }), {
    namespace: 'cold',
    ttl: 60,
  });
  const opMs = [];
  for (let id = 1; id <= OPS; id++) {
    const t = performance.now();
    await getUser(id);
    opMs.push(performance.now() - t);
  }
  await cache.close();
  console.log(JSON.stringify({ importMs, opMs }));
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
// Per-sample metrics. firstMinusSecond is the first op's one-off cost.
const METRICS = {
  importMs: (s) => s.importMs,
  firstOpMs: (s) => s.opMs[0],
  secondOpMs: (s) => s.opMs[1],
  thirdOpMs: (s) => s.opMs[2],
  firstMinusSecondMs: (s) => s.opMs[0] - s.opMs[1],
};

if (process.argv[2] === '--probe') {
  const [dist, arm, entry, latencyMs] = process.argv.slice(3);
  await probe(dist, arm, entry, Number(latencyMs));
} else {
  const { values: opt } = parseArgs({
    options: {
      k: { type: 'string', default: '9' },
      json: { type: 'string' },
      entry: { type: 'string', default: 'esm' },
      latency: { type: 'string', default: '0' },
      base: { type: 'string' },
    },
  });
  const k = Number(opt.k);
  if (!(k >= 3)) throw new Error('--k must be at least 3');
  if (opt.entry !== 'esm' && opt.entry !== 'cjs') throw new Error('--entry must be esm or cjs');
  const latencyMs = Number(opt.latency);
  if (!(latencyMs >= 0)) throw new Error('--latency must be a number of ms >= 0');
  const builds = { head: HEAD_DIST, ...(opt.base ? { base: resolve(opt.base) } : {}) };
  for (const [build, dist] of Object.entries(builds)) {
    const entryFile = join(dist, ...(opt.entry === 'cjs' ? ['cjs', 'index.js'] : ['index.js']));
    if (!existsSync(entryFile)) throw new Error(`${build} build is missing ${entryFile}`);
  }
  const names = Object.keys(ARMS);
  const cells = Object.keys(builds).flatMap((build) => names.map((arm) => [build, arm]));
  const samples = Object.fromEntries(
    Object.keys(builds).map((build) => [build, Object.fromEntries(names.map((arm) => [arm, []]))])
  );
  for (let round = 0; round < k; round++) {
    for (let i = 0; i < cells.length; i++) {
      const [build, arm] = cells[(i + round) % cells.length];
      const out = execFileSync(
        process.execPath,
        [self, '--probe', builds[build], arm, opt.entry, String(latencyMs)],
        { encoding: 'utf8' }
      );
      samples[build][arm].push(JSON.parse(out.trim().split('\n').pop()));
    }
  }
  const bands = (runs) =>
    Object.fromEntries(Object.entries(METRICS).map(([m, get]) => [m, band(runs.map(get))]));
  const result = {
    node: process.version,
    k,
    entry: opt.entry,
    latencyMs,
    builds,
    arms: Object.fromEntries(
      Object.entries(samples).map(([build, byArm]) => [
        build,
        Object.fromEntries(Object.entries(byArm).map(([arm, runs]) => [arm, bands(runs)])),
      ])
    ),
  };
  if (opt.base) {
    // Rounds pair the samples: round r of base and round r of head ran in
    // the same round of the rotation, a few probes apart.
    result.baseMinusHead = Object.fromEntries(
      names.map((arm) => [
        arm,
        Object.fromEntries(
          Object.entries(METRICS).map(([m, get]) => [
            m,
            band(samples.base[arm].map((s, r) => get(s) - get(samples.head[arm][r]))),
          ])
        ),
      ])
    );
  }
  if (opt.json) writeFileSync(opt.json, JSON.stringify({ ...result, samples }, null, 2) + '\n');
  const aa = (build, metric) =>
    Math.abs(
      result.arms[build].default[metric].median - result.arms[build]['default (A/A)'][metric].median
    ).toFixed(2);
  console.log(
    `node ${process.version}, k = ${k} processes per arm, interleaved, entry ${opt.entry}, backend latency ${latencyMs} ms`
  );
  const show = (table) =>
    console.table(
      Object.fromEntries(
        Object.entries(table).map(([row, r]) => [
          row,
          Object.fromEntries(
            Object.entries(r).map(([metric, b]) => [metric, `${b.median} (${b.min}-${b.max})`])
          ),
        ])
      )
    );
  for (const build of Object.keys(builds)) {
    console.log(
      `${build} (${builds[build]}): A/A floor (|default - default (A/A)| of medians): import ${aa(build, 'importMs')} ms, first op ${aa(build, 'firstOpMs')} ms`
    );
    show(result.arms[build]);
  }
  if (result.baseMinusHead) {
    console.log('base - head, median (min-max) of the per-round differences:');
    show(result.baseMinusHead);
  }
}

// Run probe.mjs under several JavaScript runtimes and compare them.
//
//   node bench/runtime/run.mjs [--runtime name=path ...] [--ref name] [--aa all|none|a,b]
//                              [--gaps 2,5,30,70,130,250,400] [--rounds 5] [--import-rounds 9]
//                              [--only counts,wall,cpu,import,load] [--json out.jsonl]
//
// --runtime names a runtime binary, repeatable (node, bun or deno, told apart by the file
// name). Default: this node, plus `bun` and `deno` when they are on PATH. --ref is the
// runtime every ratio divides by (default: the first). --aa picks the runtimes that also
// run as their own A/A twin (default: all of them).
//
// What it reports, and how far each number can be trusted:
// - counts (gates). Deterministic, so the A/A floor is 0: each runtime and its twin must
//   agree exactly, or the run exits 1. Per runtime and per HEAD variant of the fake
//   (head_cl 1: HEAD carries the Content-Length of the GET-equivalent JSON; 0: none): the
//   ALPN protocol its fetch negotiates, new connections and requests per op for set, warm
//   get and exists()->get pairs, and whether the next get after each idle gap opens a new
//   connection. Every runtime/variant runs concurrently against its own fake, because the
//   idle gaps make this the long phase (the default gaps total about 15 minutes).
// - wall, cpu (indicative). Only as ratios to --ref, from runs interleaved round by round
//   (cell order rotated each round, so host drift lands on every runtime alike). The A/A
//   spread of a runtime is |median - twin median| / median; a ratio counts only when its
//   distance from 1 clears the sum of both runtimes' spreads, and is marked `~` otherwise.
// - import: cold import of the root entry, one fresh process per sample, interleaved.
//   Median and min-max per runtime.
// - load: which file the package exports resolve to, and which core (NAPI or wasm) an
//   encrypted round trip loads. The workers entry is for workerd: elsewhere it is
//   expected to fail, and that is not a defect.
//
// Loopback numbers are not WAN numbers: on a long round trip a transport difference
// matters as connection counts (one avoided TLS handshake is one to two round trips), not
// as loopback milliseconds.
//
// Every JSONL row carries the runtime and its version, the fake's HEAD variant (head_cl,
// null for the probes that use no fake), the build (git short sha, `-dirty` when the
// checkout has changes) and the 1-minute load average when the probe started and ended.
// Summary rows (mode "summary") follow the raw rows. Exit codes: 0 pass, 1 a count differs
// from its A/A twin, 2 a probe failed to run.
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { BENCH_HOST, mintCert, startFake } from './fake-saas.mjs';

const run = promisify(execFile);
const PROBE = fileURLToPath(new URL('./probe.mjs', import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
const HEAD_CL = [1, 0];
const TWIN = ' (A/A)';

const { values: opt } = parseArgs({
  options: {
    runtime: { type: 'string', multiple: true },
    ref: { type: 'string' },
    aa: { type: 'string', default: 'all' },
    gaps: { type: 'string', default: '2,5,30,70,130,250,400' },
    rounds: { type: 'string', default: '5' },
    'import-rounds': { type: 'string', default: '9' },
    only: { type: 'string', default: 'counts,wall,cpu,import,load' },
    json: { type: 'string' },
  },
});

const onPath = (bin) => {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const runtimes = {};
for (const spec of opt.runtime ?? []) {
  const at = spec.indexOf('=');
  if (at < 1) throw new Error(`--runtime takes name=path, got "${spec}"`);
  runtimes[spec.slice(0, at)] = spec.slice(at + 1);
}
if (!opt.runtime) {
  runtimes.node = process.execPath;
  for (const bin of ['bun', 'deno']) {
    if (onPath(bin)) runtimes[bin] = bin;
    else console.log(`${bin}: not on PATH, skipped`);
  }
}
const names = Object.keys(runtimes);
const ref = opt.ref ?? names[0];
if (!(ref in runtimes)) throw new Error(`--ref ${ref} is not one of the runtimes: ${names}`);
const twins = opt.aa === 'all' ? names : opt.aa === 'none' ? [] : opt.aa.split(',');
for (const name of twins) if (!(name in runtimes)) throw new Error(`--aa names unknown ${name}`);
const gaps = opt.gaps.split(',').map(Number);
if (gaps.some((g) => !(g >= 0))) throw new Error('--gaps takes seconds, comma separated');
const rounds = Number(opt.rounds);
const importRounds = Number(opt['import-rounds']);
if (!(rounds >= 1 && importRounds >= 1))
  throw new Error('--rounds and --import-rounds must be >= 1');
const phases = new Set(opt.only.split(','));
if (!existsSync(new URL('../../dist/index.js', import.meta.url))) {
  throw new Error('no build to measure: run `pnpm build` first');
}

// Arms: every runtime, plus its A/A twin (the same binary under another name).
const arms = Object.fromEntries(
  names.flatMap((n) => [[n, runtimes[n]], ...(twins.includes(n) ? [[n + TWIN, runtimes[n]]] : [])])
);
const armNames = Object.keys(arms);

let build = 'unknown';
try {
  const git = (...args) => execFileSync('git', ['-C', PACKAGE_DIR, ...args], { encoding: 'utf8' });
  build =
    git('rev-parse', '--short', 'HEAD').trim() +
    (git('status', '--porcelain').trim() ? '-dirty' : '');
} catch {
  // not a git checkout: the build stays "unknown"
}

const tls = mintCert();
const childEnv = {
  ...process.env,
  NODE_EXTRA_CA_CERTS: tls.certPath, // Node and Bun
  DENO_CERT: tls.certPath,
  CACHEKIT_BENCH_HOST: BENCH_HOST,
};
if (opt.json) writeFileSync(opt.json, '');
const rows = [];
let failures = 0;

async function probe(arm, mode, params = {}, extra = {}) {
  const bin = arms[arm];
  const pre = basename(bin).startsWith('deno') ? ['run', '-A'] : [];
  const load1m = () => +loadavg()[0].toFixed(1);
  const base = { arm, head_cl: params.headCl ?? null, build, loadavg_1m_start: load1m(), ...extra };
  let row;
  try {
    const { stdout } = await run(bin, [...pre, PROBE, mode, JSON.stringify(params)], {
      env: childEnv,
      cwd: dirname(PROBE),
      timeout: (gaps.reduce((a, b) => a + b, 0) + 300) * 1000,
    });
    row = { ...JSON.parse(stdout.trim().split('\n').pop()), ...base };
  } catch (error) {
    failures++;
    row = {
      mode,
      ...base,
      error: String(error.stderr || error.message)
        .trim()
        .slice(-400),
    };
  }
  row.loadavg_1m_end = load1m();
  rows.push(row);
  if (opt.json) appendFileSync(opt.json, JSON.stringify(row) + '\n');
  return row;
}

/** One cell per (arm, extra) per round, in an order rotated each round. */
async function interleaved(k, cells, call) {
  for (let r = 0; r < k; r++) {
    for (let i = 0; i < cells.length; i++) await call(cells[(i + r) % cells.length], r);
  }
}

async function countsPhase() {
  const fakes = [];
  try {
    await Promise.all(
      armNames.flatMap((arm) =>
        HEAD_CL.map(async (headCl) => {
          const fake = await startFake({ ...tls, headCl });
          fakes.push(fake);
          await probe(arm, 'counts', { port: fake.port, ctlPort: fake.ctlPort, gaps, headCl });
        })
      )
    );
  } finally {
    await Promise.all(fakes.map((f) => f.close()));
  }
}

async function interleavedPhases() {
  if (phases.has('wall')) {
    const fakes = await Promise.all(HEAD_CL.map((headCl) => startFake({ ...tls, headCl })));
    try {
      const cells = armNames.flatMap((arm) => fakes.map((fake) => [arm, fake]));
      await interleaved(rounds, cells, ([arm, fake], round) =>
        probe(
          arm,
          'wall',
          { port: fake.port, ctlPort: fake.ctlPort, headCl: fake.headCl },
          { round }
        )
      );
    } finally {
      await Promise.all(fakes.map((f) => f.close()));
    }
  }
  if (phases.has('cpu'))
    await interleaved(rounds, armNames, (arm, round) => probe(arm, 'cpu', {}, { round }));
  if (phases.has('import')) {
    await interleaved(importRounds, armNames, (arm, round) => probe(arm, 'import', {}, { round }));
  }
  if (phases.has('load')) {
    for (const name of names)
      for (const entry of ['root', 'workers']) await probe(name, 'load', { entry }, { entry });
  }
}

try {
  await Promise.all([phases.has('counts') ? countsPhase() : null, interleavedPhases()]);
} finally {
  tls.cleanup();
}

// ── Summary ──────────────────────────────────────────────────────────────

const ok = (mode) => rows.filter((r) => r.mode === mode && !r.error);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const versionOf = (arm) => rows.find((r) => r.arm === arm && r.runtime_version)?.runtime_version;
const emit = (row) => {
  const line = { mode: 'summary', build, runtime_version: versionOf(row.arm) ?? null, ...row };
  if (opt.json) appendFileSync(opt.json, JSON.stringify(line) + '\n');
};
console.log(
  `build ${build}, host ${BENCH_HOST}; runtimes: ${names.map((n) => `${n}=${runtimes[n]}`).join(', ')}`
);
for (const r of rows.filter((x) => x.error)) console.log(`FAILED ${r.arm} ${r.mode}: ${r.error}`);

let disagreements = 0;
if (phases.has('counts')) {
  const gate = (r) => ({
    alpn: r.alpn,
    set: `${r.set.new_conn} conn, ${r.set.requests_per_op} req/op`,
    get: `${r.get.new_conn} conn, ${r.get.requests_per_op} req/op`,
    'exists->get x10': `${r.exists_get_pairs.new_conn} conn, ${r.exists_get_pairs.requests_per_op} req/pair`,
    [`gaps ${gaps.join(',')} s`]: r.gaps.map((g) => g.new_conn).join(','),
  });
  const table = {};
  const find = (arm, headCl) => ok('counts').find((x) => x.arm === arm && x.head_cl === headCl);
  for (const [name, headCl] of names.flatMap((n) => HEAD_CL.map((h) => [n, h]))) {
    const r = find(name, headCl);
    if (!r) continue; // failed: reported above
    const twin = twins.includes(name) ? find(name + TWIN, headCl) : undefined;
    const agree = twin ? JSON.stringify(gate(r)) === JSON.stringify(gate(twin)) : null;
    if (agree === false) disagreements++;
    table[`${r.arm} ${r.runtime_version} head_cl=${r.head_cl}`] = {
      ...gate(r),
      'A/A': agree ?? 'no twin',
    };
    emit({
      kind: 'counts',
      arm: r.arm,
      runtime_version: r.runtime_version,
      head_cl: r.head_cl,
      ...gate(r),
      aa_agree: agree,
    });
  }
  console.log(
    'Counts (gates; must match the A/A twin exactly). gaps: 1 = the get after that idle gap opened a new connection'
  );
  console.table(table);
}

// Ratio cells: the median over rounds of each arm's per-process value.
function ratios(mode, metrics, headCl) {
  const pick = (arm, m) => {
    const xs = ok(mode)
      .filter((r) => r.arm === arm && r.head_cl === headCl)
      .map(m.get);
    return xs.length ? median(xs) : null;
  };
  const spread = (name, m) => {
    const a = pick(name, m);
    const b = pick(name + TWIN, m);
    return a === null || b === null ? null : Math.abs(a - b) / a;
  };
  const table = {};
  for (const name of names) {
    if (name === ref) continue;
    const row = {};
    for (const m of metrics) {
      const x = pick(name, m);
      const base = pick(ref, m);
      if (x === null || base === null) continue;
      const ratio = x / base;
      const floor =
        spread(name, m) === null || spread(ref, m) === null
          ? null
          : spread(name, m) + spread(ref, m);
      const clears = floor === null ? null : Math.abs(ratio - 1) > floor;
      row[m.name] = `${ratio.toFixed(2)}${clears ? '' : '~'}`;
      emit({
        kind: 'ratio',
        probe: mode,
        metric: m.name,
        arm: name,
        ref,
        head_cl: headCl,
        ratio: +ratio.toFixed(3),
        aa_floor: floor === null ? null : +floor.toFixed(3),
        clears,
      });
    }
    table[`${name} / ${ref}`] = row;
  }
  const aa = {};
  for (const name of names) {
    aa[name] = Object.fromEntries(
      metrics.map((m) => [
        m.name,
        spread(name, m) === null ? 'no twin' : `${(spread(name, m) * 100).toFixed(1)}%`,
      ])
    );
  }
  return { table, aa };
}

const show = (title, { table, aa }) => {
  console.log(title);
  console.table(table);
  console.log('A/A spread per runtime (|median - twin median| / median):');
  console.table(aa);
};
if (phases.has('wall')) {
  const metrics = ['get_ms', 'set_ms', 'exists_get_ms'].map((k) => ({ name: k, get: (r) => r[k] }));
  for (const headCl of HEAD_CL) {
    show(
      `Wall time per op, ratio to ${ref} (head_cl=${headCl}; ~ = within the A/A floor, not a difference)`,
      ratios('wall', metrics, headCl)
    );
  }
}
if (phases.has('cpu')) {
  const keys = Object.keys(ok('cpu')[0]?.us_per_op ?? {});
  const metrics = keys.map((k) => ({ name: k, get: (r) => r.us_per_op[k] }));
  show(
    `CPU paths per op (in-memory backend), ratio to ${ref} (~ = within the A/A floor)`,
    ratios('cpu', metrics, null)
  );
}
if (phases.has('import')) {
  const table = {};
  for (const name of names) {
    const xs = ok('import')
      .filter((r) => r.arm === name)
      .map((r) => r.import_ms);
    if (!xs.length) continue;
    const cell = {
      median: +median(xs).toFixed(1),
      min: Math.min(...xs),
      max: Math.max(...xs),
      n: xs.length,
    };
    table[name] = cell;
    emit({ kind: 'import', arm: name, head_cl: null, ...cell });
  }
  console.log('Cold import of the root entry, ms (fresh process per sample, interleaved):');
  console.table(table);
}
if (phases.has('load')) {
  const table = {};
  for (const r of rows.filter((x) => x.mode === 'load')) {
    // load_error: the runtime could not load or run that entry; error: the probe itself failed
    const failed = r.load_error ?? r.error;
    const note = failed && r.entry === 'workers' ? ' (workerd-only entry: expected)' : '';
    table[`${r.arm} ${r.entry}`] = {
      resolved: r.resolved,
      core: r.core,
      roundtrip: r.roundtrip,
      error: failed ? `${failed.slice(0, 80)}${note}` : '',
    };
  }
  console.log('Load: entry each runtime resolves and the core it runs');
  console.table(table);
}
if (disagreements)
  console.log(`${disagreements} count row(s) differ from their A/A twin: the gate fails`);
process.exit(disagreements ? 1 : failures ? 2 : 0);

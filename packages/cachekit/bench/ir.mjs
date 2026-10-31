// Instructions per op on the cachekit-ts hot paths, main thread only.
//
//   node bench/ir.mjs [--repeats 5] [--jobs 4] [--only a,b] [--shard 1/3] [--wall 9]
//                     [--save out.json] [--compare base.json] [--new a,b]
//                     [--report report.json]
//   node bench/ir.mjs --build-hash
//
// Wall-clock microbenchmarks on a shared or hosted machine cannot resolve the
// 1-2% changes that matter here; instruction counts can, once three sources of
// run-to-run noise are removed:
// - V8: default flags vary main-thread Ir 2-4x between identical runs
//   (background compilation and GC). V8_FLAGS pins them; --no-liftoff and
//   --predictable-gc-schedule are what make the wasm paths repeat.
// - The fixed part: module load and warm-up vary by 1-3% of a whole process.
//   So Ir/op = Ir(window) / n, where the window is the n ops of one workload,
//   bracketed by ir-workload.mjs; nothing else is counted.
// On Node 22 and 24 every workload then repeats within 0.01%. On Node 26 the
// workloads that cross into the NAPI or wasm core keep a residual of
// 0.1-0.3%, and napi-encrypted an occasional run about 1% low; neither ASLR
// nor malloc's dynamic thresholds explain it. So the A/A spread is measured
// on every run, never assumed.
//
// Reported per workload as the median of the repeats with its A/A spread,
// (max - min) / median. A spread over AA_LIMIT means the run is too noisy to
// judge: the exit code says so instead of passing.
//
// --compare gates a head run against a base run made on the same machine and
// toolchain (fingerprint): +2% per op fails, +1% warns, unless the workload
// sets its own `fail` (and warns at half of it). Exit codes: 0 pass,
// 1 regression, 2 not comparable (fingerprint or workload-set mismatch, or
// the same build on both sides), 3 A/A over the limit, 4 the run itself
// failed (bad arguments, valgrind crash, missing build output).
//
// A workload whose run fails does not stop the others: --save records it
// under `failed`, its row reads INCOMPLETE and the exit code is 4. A workload
// that only the head's workload file defines may fail on the base build,
// because the base lacks the API it measures; --new names those, and their
// rows read `new` without gating. --report writes the rows and verdicts as
// JSON for CI (.github/scripts/perf-ir-comment.mjs renders them). --shard K/N
// measures the Kth of N sets of workloads, balanced on ir-seconds.json, so N
// machines can split one compare. --build-hash prints the hash of what the
// workloads execute and exits, without valgrind.
//
// --wall K adds K interleaved plain-node processes per workload and prints
// steady-state ns/op (median, min-max), on screen only. It gives the scale of
// an Ir delta, never a measured saving.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WORKLOADS } from './ir-workload.mjs';

// Any failure of the run itself exits 4, so a script never reads it as the
// regression code 1. The handler must not read `opt`: a parseArgs error fires
// it before `opt` is initialised, and a throw here exits 7, not 4.
process.on('uncaughtException', (error) => {
  console.error('ir bench: the run failed (exit 4):', error);
  process.exit(4);
});

const V8_FLAGS = [
  '--single-threaded',
  '--predictable',
  '--hash-seed=1',
  '--random-seed=1',
  '--no-liftoff',
  '--predictable-gc-schedule',
];
const N = Object.fromEntries(Object.entries(WORKLOADS).map(([name, w]) => [name, w.n]));
const AA_LIMIT = 0.004;
const FAIL = 0.02;
// A workload may set its own `fail` where CI measured it moving on builds whose
// changes it never runs (see the note beside each in ir-workload.mjs); it then
// warns at half that, as the default does.
const failAt = (name) => WORKLOADS[name].fail ?? FAIL;

const { values: opt } = parseArgs({
  options: {
    repeats: { type: 'string', default: '5' },
    jobs: { type: 'string', default: String(Math.max(1, Math.floor(availableParallelism() / 4))) },
    only: { type: 'string' },
    wall: { type: 'string', default: '0' },
    shard: { type: 'string' },
    save: { type: 'string' },
    compare: { type: 'string' },
    new: { type: 'string' },
    report: { type: 'string' },
    'build-hash': { type: 'boolean' },
  },
});
if (opt['build-hash']) {
  console.log(buildHash());
  process.exit(0);
}
const repeats = Number(opt.repeats);
const jobs = Number(opt.jobs);
const wallRounds = Number(opt.wall);
const list = (csv) => (csv ? [...new Set(csv.split(','))] : []);
// Deduped: two runs of one workload would share a callgrind output prefix.
let names = opt.only ? list(opt.only) : Object.keys(N);
for (const name of names) if (!(name in N)) throw new Error(`unknown workload "${name}"`);
const isInt = (x, min) => Number.isInteger(x) && x >= min;
if (opt.shard) {
  const [k, of] = opt.shard.split('/').map(Number);
  if (!isInt(of, 1) || !isInt(k, 1) || k > of) throw new Error('--shard must be K/N, 1 <= K <= N');
  // Longest first onto the least-loaded shard, by the seconds one run took in
  // CI; a workload with no figure yet counts as the median. Every shard
  // computes the same split from the same file.
  const cost = JSON.parse(readFileSync(new URL('ir-seconds.json', import.meta.url), 'utf8'));
  const typical = Object.values(cost).sort((a, b) => a - b)[Object.keys(cost).length >> 1];
  const costOf = (name) => cost[name] ?? typical;
  const load = new Array(of).fill(0);
  const mine = new Set();
  for (const name of [...names].sort((a, b) => costOf(b) - costOf(a) || a.localeCompare(b))) {
    const shard = load.indexOf(Math.min(...load));
    load[shard] += costOf(name);
    if (shard === k - 1) mine.add(name);
  }
  names = names.filter((name) => mine.has(name));
}
const newNames = new Set(list(opt.new));
for (const name of newNames) if (!(name in N)) throw new Error(`--new: unknown workload "${name}"`);
if (!isInt(repeats, 3))
  throw new Error('--repeats must be an integer >= 3: the A/A spread needs them');
if (!isInt(jobs, 1)) throw new Error('--jobs must be an integer >= 1');
if (!isInt(wallRounds, 0)) throw new Error('--wall must be an integer >= 0');
if (opt.save && opt.compare && resolve(opt.save) === resolve(opt.compare)) {
  // The save would overwrite the base before it is read: a self-compare that always passes.
  throw new Error('--save and --compare must be different files');
}
// Read the base before measuring, so a missing or corrupt file fails in seconds.
function readBase(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read --compare file ${file}`, { cause: error });
  }
}
const base = opt.compare ? readBase(opt.compare) : null;
// A NaN in the base makes every comparison false, so the row would read `ok`.
const positive = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;
const nonNegative = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
if (base) {
  if (typeof base.benches !== 'object' || base.benches === null) {
    throw new Error(`${opt.compare}: no benches object; not a --save file`);
  }
  for (const [name, b] of Object.entries(base.benches)) {
    if (!positive(b?.irPerOp) || !nonNegative(b?.aa)) {
      throw new Error(
        `${opt.compare}: ${name} needs a positive irPerOp and a non-negative aa, got ${JSON.stringify(b)}`
      );
    }
  }
  base.failed ??= {};
  if (typeof base.failed !== 'object') {
    throw new Error(`${opt.compare}: failed must be an object of workload errors`);
  }
}

const workload = fileURLToPath(new URL('ir-workload.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('..', import.meta.url));

function valgrindVersion() {
  try {
    return execFileSync('valgrind', ['--version'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(
      'valgrind is required, and this suite runs on Linux only (apt install valgrind)',
      {
        cause: error,
      }
    );
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${err.slice(-2000)}`))
    );
  });
}

/**
 * Ir of the measured window on the main thread. --dump-before writes a dump
 * each time the workload calls process.cpuUsage(): part 1 ends at the
 * window's start, part 2 is the window, and the final dump is the rest.
 */
async function windowIr(dir, tag, name, n) {
  const prefix = join(dir, tag);
  await run('valgrind', [
    '--tool=callgrind',
    '--separate-threads=yes',
    '--dump-before=*CPUUsage*',
    `--callgrind-out-file=${prefix}.out`,
    process.execPath,
    ...V8_FLAGS,
    workload,
    name,
    String(n),
  ]);
  const files = readdirSync(dir).filter((f) => f.startsWith(`${tag}.out.`));
  if (files.some((f) => !/\.out\.[12]-\d+$/.test(f))) {
    throw new Error(
      `${tag}: more than two process.cpuUsage() calls; the window is not the ops alone`
    );
  }
  const totals = files
    .filter((f) => f.startsWith(`${tag}.out.2-`)) // one per thread that ran in the window
    .map((f) => {
      const m = /^totals:\s+(\d+)/m.exec(readFileSync(join(dir, f), 'utf8'));
      if (!m) throw new Error(`no totals line in ${f}`);
      return Number(m[1]);
    });
  if (totals.length === 0) throw new Error(`${tag}: callgrind wrote no window dump`);
  return Math.max(...totals);
}

async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const fingerprint = {
  node: process.version,
  v8: process.versions.v8,
  valgrind: valgrindVersion(),
  platform: `${process.platform}-${process.arch}`,
  flags: V8_FLAGS.join(' '),
};

/**
 * Hash of everything the workloads can load: for this package and both cores,
 * package.json (how imports resolve) and every file its `files` list ships
 * (dist/, the NAPI loader and binary, the wasm glue and module), whatever the
 * extension; and the lockfile, which pins the packages those import from
 * node_modules. Equal hashes skip the measurement, so a loaded file missing
 * here is a regression that passes unmeasured. A compare of a build against
 * itself reads 0% and proves nothing.
 */
function buildHash() {
  const hash = createHash('sha256');
  // Paths relative to the repository, so the base and head trees can match.
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const add = (path) => {
    hash.update(relative(repo, path)).update(readFileSync(path));
  };
  const addPackage = (root, optional = []) => {
    const pkg = join(root, 'package.json');
    add(pkg);
    for (const entry of JSON.parse(readFileSync(pkg, 'utf8')).files) {
      const path = join(root, entry);
      if (entry.includes('*')) {
        // Only `*<suffix>` at the package root (`*.node`). Any other glob, or
        // one that matches nothing, would add nothing and skip a measurement.
        const suffix = entry.slice(1);
        const matches = readdirSync(root).filter((f) => f.endsWith(suffix));
        if (!entry.startsWith('*') || /[*/]/.test(suffix) || matches.length === 0) {
          throw new Error(`${pkg}: files entry ${entry} is not a *<suffix> that matches a file`);
        }
        for (const f of matches.sort()) add(join(root, f));
      } else if (!existsSync(path) && optional.includes(entry)) {
        hash.update(`no ${entry} in ${relative(repo, root)}`);
      } else if (statSync(path).isDirectory()) {
        for (const f of readdirSync(path, { recursive: true }).sort()) {
          if (statSync(join(path, f)).isFile()) add(join(path, f));
        }
      } else {
        add(path);
      }
    }
  };
  // Both cores keep their entry (index.js) at the package root.
  const req = createRequire(import.meta.url);
  addPackage(fileURLToPath(new URL('..', import.meta.url)));
  addPackage(dirname(req.resolve('@cachekit-io/cachekit-core-ts')));
  // The wasm build is optional: `pnpm build` does not make it.
  addPackage(dirname(fileURLToPath(import.meta.resolve('@cachekit-io/cachekit-core-wasm'))), [
    'pkg/',
  ]);
  add(join(repo, 'pnpm-lock.yaml'));
  return hash.digest('hex').slice(0, 16);
}
const build = buildHash();

const dir = mkdtempSync(join(tmpdir(), 'cachekit-ir-'));
const irByRun = {};
// Wall seconds under callgrind per workload, all repeats: what a shard costs.
const seconds = Object.fromEntries(names.map((name) => [name, 0]));
// The first error of each workload that failed; its other repeats still run.
const failed = {};
try {
  const plan = [];
  for (let r = 0; r < repeats; r++) {
    for (const name of names) plan.push({ tag: `${name}.${r}`, name, n: N[name] });
  }
  await pool(
    plan.map((p) => async () => {
      const t0 = performance.now();
      try {
        irByRun[p.tag] = await windowIr(dir, p.tag, p.name, p.n);
      } catch (error) {
        failed[p.name] ??= String(error?.message ?? error).slice(0, 2000);
      }
      seconds[p.name] += (performance.now() - t0) / 1000;
    }),
    jobs
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
for (const [name, message] of Object.entries(failed)) {
  console.error(`${name}: the run failed\n${message}`);
}
const measured = names.filter((name) => !(name in failed));

const benches = {};
for (const name of measured) {
  const perOp = Array.from({ length: repeats }, (_, r) => irByRun[`${name}.${r}`] / N[name]);
  const irPerOp = median(perOp);
  benches[name] = {
    n: N[name],
    irPerOp: Math.round(irPerOp),
    aa: (Math.max(...perOp) - Math.min(...perOp)) / irPerOp,
    perRepeat: perOp.map(Math.round),
    seconds: Math.round(seconds[name]),
  };
  // A verdict on a NaN would read `ok`: refuse rather than pass on nothing measured.
  if (!perOp.every(Number.isFinite) || !(irPerOp > 0)) {
    throw new Error(`${name}: Ir/op is not a positive finite number (${perOp.join(', ')})`);
  }
}

// Wall time stays on screen and out of --save: it is measured under other
// flags than the Ir, and a stored ratio of the two reads like a saving.
const wall = {};
if (wallRounds > 0) {
  const samples = Object.fromEntries(measured.map((name) => [name, []]));
  for (let round = 0; round < wallRounds; round++) {
    // Rotate the order every round so drift on a busy host lands on every arm alike.
    for (let i = 0; i < measured.length; i++) {
      const name = measured[(i + round) % measured.length];
      const out = await run(process.execPath, [workload, name, String(N[name]), '--wall']);
      samples[name].push(JSON.parse(out.trim().split('\n').pop()).nsPerOp);
    }
  }
  for (const name of measured) {
    const ns = samples[name];
    wall[name] = {
      nsPerOp: Math.round(median(ns)),
      min: Math.round(Math.min(...ns)),
      max: Math.round(Math.max(...ns)),
      k: ns.length,
    };
  }
}

const result = { fingerprint, build, repeats, aaLimit: AA_LIMIT, rawIr: irByRun, benches, failed };
if (opt.save) writeFileSync(opt.save, JSON.stringify(result, null, 2) + '\n');

const pct = (x) => `${(x * 100).toFixed(2)}%`;
// Why the compare cannot be read, on stderr and in --report.
const notes = [];
const note = (message) => {
  console.error(message);
  notes.push(message);
};
let mismatch = false;
let regressed = false;
let incomplete = false;
let noisyAny = false;
if (base && base.build === build) {
  note(`same build: base and head both hash to ${build}; rebuild one side before comparing.`);
  mismatch = true;
}
if (base && JSON.stringify(base.fingerprint) !== JSON.stringify(fingerprint)) {
  note(
    `fingerprint mismatch: base ${JSON.stringify(base.fingerprint)}\n                     head ${JSON.stringify(fingerprint)}\n` +
      'Ir moves with node, V8 and valgrind versions: rebuild the base on this machine and compare again.'
  );
  mismatch = true;
}
const baseNames = base ? [...Object.keys(base.benches), ...Object.keys(base.failed)] : [];
if (base && baseNames.sort().join(',') !== [...names].sort().join(',')) {
  // A workload missing from either run would get no verdict, and the gate
  // would pass while gating nothing.
  note(
    `workload mismatch: base ran ${baseNames.join(',')}, head ran ${[...names].sort().join(',')}`
  );
  mismatch = true;
}
const rows = [];
for (const name of names) {
  const b = benches[name];
  const was = base?.benches[name];
  const row = { workload: name, irPerOp: b?.irPerOp, aa: b?.aa };
  rows.push(row);
  if (!b) {
    row.verdict = 'INCOMPLETE (run failed)';
    row.error = failed[name];
    incomplete = true;
    continue;
  }
  const noisy = b.aa > AA_LIMIT || (was && was.aa > AA_LIMIT);
  noisyAny ||= Boolean(noisy);
  if (base && !mismatch && !was) {
    row.error = base.failed[name];
    // A workload the base's own file lacks may measure an API the base lacks.
    // A noisy head run reads INCONCLUSIVE here too, as the exit code says.
    row.verdict = !newNames.has(name)
      ? 'INCOMPLETE (base run failed)'
      : noisy
        ? 'INCONCLUSIVE (A/A)'
        : 'new (base cannot run it)';
    incomplete ||= !newNames.has(name);
  } else if (was && !mismatch) {
    const delta = b.irPerOp / was.irPerOp - 1;
    const fail = failAt(name);
    Object.assign(row, { baseIrPerOp: was.irPerOp, baseAa: was.aa, delta, fail });
    row.verdict = noisy
      ? 'INCONCLUSIVE (A/A)'
      : delta > fail
        ? 'FAIL'
        : delta > fail / 2
          ? 'warn'
          : delta < -fail
            ? 'improved'
            : 'ok';
    regressed ||= row.verdict === 'FAIL';
  } else if (noisy) {
    row.verdict = 'INCONCLUSIVE (A/A)';
  }
}
console.log(JSON.stringify(fingerprint));
console.table(
  rows.map((r) => ({
    workload: r.workload,
    'Ir/op': r.irPerOp ?? '-',
    'A/A': r.aa === undefined ? '-' : pct(r.aa),
    ...(wall[r.workload] && {
      'ns/op': wall[r.workload].nsPerOp,
      'ns min-max': `${wall[r.workload].min}-${wall[r.workload].max}`,
    }),
    ...(r.baseIrPerOp !== undefined && { 'base Ir/op': r.baseIrPerOp, delta: pct(r.delta) }),
    ...(r.verdict && { verdict: r.verdict }),
  }))
);
// A mismatch makes every delta meaningless; a clear regression outranks a
// missing verdict, and both outrank noise elsewhere.
const exitCode = mismatch ? 2 : regressed ? 1 : incomplete ? 4 : noisyAny ? 3 : 0;
if (exitCode === 3)
  console.error(
    `A/A spread over ${pct(AA_LIMIT)}: too noisy to judge; rerun on a quieter machine.`
  );
if (opt.report) {
  const thresholds = { fail: FAIL, warn: FAIL / 2, aaLimit: AA_LIMIT };
  const report = { exitCode, fingerprint, thresholds, notes, rows };
  writeFileSync(opt.report, JSON.stringify(report, null, 2) + '\n');
}
process.exitCode = exitCode;

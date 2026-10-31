// Render the instruction-count gate's PR comment from what perf-ir.sh left in
// each shard's output directory, <reports>/instruction-counts-<K>/, and exit 1
// unless the verdict is PASS.
//
//   node .github/scripts/perf-ir-comment.mjs --reports <dir> --shards <N> \
//     --head <sha> --base <label> --run-url <url>
//
// The verdict is read from the rows, never from a missing file: every workload
// the head's bench file defines needs a passing row, or the comment reads
// INCOMPLETE. That covers a shard that died before writing its report, a
// report that dropped a workload, and a compare that could not be read at all.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const MARKER = '<!-- cachekit-instruction-count -->';

const { values: opt } = parseArgs({
  options: {
    reports: { type: 'string' },
    shards: { type: 'string' },
    head: { type: 'string' },
    base: { type: 'string' },
    'run-url': { type: 'string' },
  },
});
const shards = Array.from({ length: Number(opt.shards) }, (_, k) => {
  const read = (file) => {
    const path = join(opt.reports, `instruction-counts-${k + 1}`, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };
  return {
    sameBuild: read('same-build')?.trim(),
    benchChanged: read('bench-changed') !== null,
    expected: read('head-workloads.txt')?.split('\n').filter(Boolean),
    report: JSON.parse(read('report.json') ?? 'null'),
  };
});
if (shards.length === 0) throw new Error('--shards must be a positive integer');
const pct = (x, sign = false) => `${sign && x > 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const int = (x) => (x === undefined ? '–' : x.toLocaleString('en-US'));
// Worst first. `new` passes: the base cannot run a workload for an API it lacks.
const RANK = ['FAIL', 'INCOMPLETE', 'INCONCLUSIVE', 'warn', 'improved', 'ok', 'new'];
const rank = (verdict) => RANK.indexOf(verdict.split(' ')[0]);

const head = opt.head.slice(0, 7);
const lines = [MARKER];
let verdict;
// Every shard builds both trees, so they agree on the hash or none has it.
const sameBuild = shards.every((s) => s.sameBuild) && shards[0].sameBuild;
// Every shard lists all the head's workloads; one that lists none died first.
const expected = shards.find((s) => s.expected)?.expected ?? [];
const reports = shards.map((s) => s.report).filter(Boolean);
const report = reports[0];

if (sameBuild) {
  verdict = 'PASS';
  lines.push(
    `### Instruction counts: PASS (no runtime change)`,
    '',
    `Head \`${head}\` and base ${opt.base} build to the same \`dist/\`, NAPI and wasm ` +
      `(hash \`${sameBuild}\`), so there is nothing to measure.`
  );
} else {
  const rows = new Map(reports.flatMap((r) => r.rows).map((r) => [r.workload, r]));
  const verdicts = expected.map((name) => rows.get(name)?.verdict ?? 'INCOMPLETE (no row)');
  verdict = verdicts.length
    ? verdicts.reduce((a, b) => (rank(b) < rank(a) ? b : a)).split(' ')[0]
    : 'INCOMPLETE';
  if (['warn', 'improved', 'ok', 'new'].includes(verdict)) verdict = 'PASS';
  // A failing exit code with no failing row, or a shard with no report, is still not a pass.
  const exited = shards.every((s) => s.report?.exitCode === 0 || s.sameBuild);
  if (verdict === 'PASS' && !exited) verdict = 'INCOMPLETE';
  const t = report?.thresholds;
  const own = [...rows.values()]
    .filter((r) => r.fail !== undefined && r.fail !== t?.fail)
    .map((r) => `\`${r.workload}\` at +${pct(r.fail)}`);
  lines.push(
    `### Instruction counts: ${verdict}`,
    '',
    `Head \`${head}\` against base ${opt.base}` +
      (report ? `, Node ${report.fingerprint.node}, ${report.fingerprint.valgrind}` : '') +
      `. Instructions per op on the main thread (\`bench:ir --compare\`); median of the repeats, ` +
      `A/A = (max − min) / median.` +
      (t
        ? ` A workload fails above +${pct(t.fail)} and warns above +${pct(t.warn)}` +
          (own.length ? ` (its own threshold: ${own.join(', ')}, warning at half)` : '') +
          `; an A/A over ${pct(t.aaLimit)} reads INCONCLUSIVE.`
        : ''),
    ''
  );
  if (shards.some((s) => s.benchChanged)) {
    lines.push(
      '**This PR changes `packages/cachekit/bench/`**: both builds ran its workloads and thresholds.',
      ''
    );
  }
  shards.forEach((s, k) => {
    if (!s.report && !s.sameBuild)
      lines.push(`**Shard ${k + 1} left no report**: see its job log.`, '');
  });
  for (const n of new Set(reports.flatMap((r) => r.notes))) lines.push(`> ${n.split('\n')[0]}`, '');
  const header = [
    '| workload | base Ir/op | head Ir/op | delta | A/A base / head | verdict |',
    '|---|---:|---:|---:|---:|---|',
  ];
  const row = (name, i) => {
    const r = rows.get(name) ?? {};
    const aa = [r.baseAa, r.aa].map((x) => (x === undefined ? '–' : pct(x))).join(' / ');
    const delta = r.delta === undefined ? '–' : pct(r.delta, true);
    const v = verdicts[i];
    const bold = rank(v) <= rank('INCONCLUSIVE') ? `**${v}**` : v;
    return `| \`${name}\` | ${int(r.baseIrPerOp)} | ${int(r.irPerOp)} | ${delta} | ${aa} | ${bold} |`;
  };
  // Every verdict but `ok` up front; every workload in the fold.
  const counts = {};
  for (const v of verdicts) counts[v] = (counts[v] ?? 0) + 1;
  const tally = Object.entries(counts)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([v, n]) => `${n} ${v}`)
    .join(', ');
  const flagged = expected.flatMap((name, i) => (verdicts[i] === 'ok' ? [] : [row(name, i)]));
  if (flagged.length) lines.push(...header, ...flagged, '');
  lines.push(
    `<details><summary>All ${expected.length} workloads: ${tally || 'none'}</summary>`,
    '',
    ...header,
    ...expected.map(row),
    '',
    '</details>'
  );
  const errors = [...rows.values()].filter((r) => r.error);
  if (errors.length) {
    lines.push('', '<details><summary>Run errors</summary>', '');
    for (const r of errors) lines.push(`\`${r.workload}\`:`, '```text', r.error.trim(), '```');
    lines.push('</details>');
  }
}
lines.push('', `[Run log](${opt['run-url']})`);
console.log(lines.join('\n'));
process.exitCode = verdict === 'PASS' ? 0 : 1;

// Render the instruction-count gate's PR comment from what perf-ir.sh left in
// its output directory, and exit 1 unless the verdict is PASS.
//
//   node .github/scripts/perf-ir-comment.mjs --out <dir> --head <sha> --base <label> --run-url <url>
//
// The verdict is read from the rows, never from a missing file: every workload
// the head's bench file defines needs a passing row, or the comment reads
// INCOMPLETE. That covers a run that died before writing its report, a report
// that dropped a workload, and a compare that could not be read at all.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const MARKER = '<!-- cachekit-instruction-count -->';

const { values: opt } = parseArgs({
  options: {
    out: { type: 'string' },
    head: { type: 'string' },
    base: { type: 'string' },
    'run-url': { type: 'string' },
  },
});
const read = (file) => {
  const path = join(opt.out, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};
const pct = (x, sign = false) => `${sign && x > 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const int = (x) => (x === undefined ? '–' : x.toLocaleString('en-US'));
// Worst first. `new` passes: the base cannot run a workload for an API it lacks.
const RANK = ['FAIL', 'INCOMPLETE', 'INCONCLUSIVE', 'warn', 'improved', 'ok', 'new'];
const rank = (verdict) => RANK.indexOf(verdict.split(' ')[0]);

const head = opt.head.slice(0, 7);
const lines = [MARKER];
let verdict;
const sameBuild = read('same-build');
const expected = (read('head-workloads.txt') ?? '').split('\n').filter(Boolean);
const report = JSON.parse(read('report.json') ?? 'null');

if (sameBuild) {
  verdict = 'PASS';
  lines.push(
    `### Instruction counts: PASS (no runtime change)`,
    '',
    `Head \`${head}\` and base ${opt.base} build to the same \`dist/\`, NAPI and wasm ` +
      `(hash \`${sameBuild.trim()}\`), so there is nothing to measure.`
  );
} else {
  const rows = new Map((report?.rows ?? []).map((r) => [r.workload, r]));
  if (expected.length === 0) expected.push(...rows.keys());
  const verdicts = expected.map((name) => rows.get(name)?.verdict ?? 'INCOMPLETE (no row)');
  verdict = verdicts.length
    ? verdicts.reduce((a, b) => (rank(b) < rank(a) ? b : a)).split(' ')[0]
    : 'INCOMPLETE';
  if (['warn', 'improved', 'ok', 'new'].includes(verdict)) verdict = 'PASS';
  // A failing exit code with no failing row is still not a pass.
  if (verdict === 'PASS' && report?.exitCode !== 0) verdict = 'INCOMPLETE';
  const t = report?.thresholds;
  lines.push(
    `### Instruction counts: ${verdict}`,
    '',
    `Head \`${head}\` against base ${opt.base}` +
      (report ? `, Node ${report.fingerprint.node}, ${report.fingerprint.valgrind}` : '') +
      `. Instructions per op on the main thread (\`bench:ir --compare\`); median of the repeats, ` +
      `A/A = (max − min) / median.` +
      (t
        ? ` A workload fails above +${pct(t.fail)} and warns above +${pct(t.warn)}; ` +
          `an A/A over ${pct(t.aaLimit)} reads INCONCLUSIVE.`
        : ''),
    ''
  );
  if (!report) lines.push('**The run left no report**: see the job log.', '');
  for (const n of report?.notes ?? []) lines.push(`> ${n.split('\n')[0]}`, '');
  lines.push(
    '| workload | base Ir/op | head Ir/op | delta | A/A base / head | verdict |',
    '|---|---:|---:|---:|---:|---|'
  );
  expected.forEach((name, i) => {
    const r = rows.get(name) ?? {};
    const aa = [r.baseAa, r.aa].map((x) => (x === undefined ? '–' : pct(x))).join(' / ');
    const delta = r.delta === undefined ? '–' : pct(r.delta, true);
    const v = verdicts[i];
    const bold = rank(v) <= rank('INCONCLUSIVE') ? `**${v}**` : v;
    lines.push(
      `| \`${name}\` | ${int(r.baseIrPerOp)} | ${int(r.irPerOp)} | ${delta} | ${aa} | ${bold} |`
    );
  });
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

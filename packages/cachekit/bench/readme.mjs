// The README's Performance table, as Markdown.
//
//   node bench/readme.mjs
//
// Runs the runtime probe's `cpu` mode (bench/runtime/probe.mjs) in five fresh
// processes and prints the median of each figure. Every row uses an in-memory
// backend, so no network time is included. Wall clock: expect other figures on
// other machines. Imports the built package: run `pnpm build` first.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROBE = fileURLToPath(new URL('runtime/probe.mjs', import.meta.url));
const RUNS = 5;

const runs = Array.from({ length: RUNS }, () =>
  JSON.parse(execFileSync(process.execPath, [PROBE, 'cpu', '{}'], { encoding: 'utf8' }))
);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const cell = (key) => {
  if (key === null) return '—';
  const us = median(runs.map((r) => r.us_per_op[key]));
  if (us < 1) return `${Math.round(us * 1000)} ns`;
  return us < 100 ? `${us.toFixed(1)} µs` : `${Math.round(us)} µs`;
};

const ROWS = [
  ['`wrap()` call, L1 hit', 'wrap_l1_hit_100B', 'wrap_l1_hit_10KB'],
  ['`wrap()` call, L1 hit, encrypted', 'secure_wrap_l1_hit_100B', 'secure_wrap_l1_hit_10KB'],
  ['`get`, L2 hit', 'get_100B', 'get_10KB'],
  ['`get`, L2 hit, encrypted', 'secure_get_100B', 'secure_get_10KB'],
  ['`set`', 'set_100B', 'set_10KB'],
  ['Key generation (`generateKey`)', 'keygen', null],
];

console.log(`${runs[0].runtime} ${runs[0].runtime_version}, median of ${RUNS} processes\n`);
console.log('| Operation | 100 B | 10 KB |');
console.log('|:----------|------:|------:|');
for (const [label, small, large] of ROWS) {
  console.log(`| ${label} | ${cell(small)} | ${cell(large)} |`);
}

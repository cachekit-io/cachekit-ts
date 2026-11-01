import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * A process can load both the ESM and the CommonJS build, and caches from
 * each can share a registry. The circuit-breaker gauge must still read the
 * state of whichever cache finished an op last, as a set() per op did. Runs
 * the BUILT entries (`pnpm build` first) in a child process.
 */

const run = promisify(execFile);
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const esmEntry = join(pkgDir, 'dist', 'index.js');
const cjsEntry = join(pkgDir, 'dist', 'cjs', 'index.js');

beforeAll(() => {
  for (const entry of [esmEntry, cjsEntry]) {
    if (!existsSync(entry)) throw new Error(`${entry} is missing: run \`pnpm build\` first`);
  }
});

describe('the circuit-breaker gauge with caches from both builds on one registry', () => {
  it('reads the state of the cache that finished an op last', async () => {
    const { stdout } = await run(
      process.execPath,
      [join(pkgDir, 'test', 'node-entry', 'dual-entry-gauge-probe.mjs'), esmEntry, cjsEntry],
      { timeout: 20_000 }
    );
    // Per pair of ops, two scrapes: open, closed, open, closed.
    expect(JSON.parse(stdout)).toEqual([1, 1, 0, 0, 1, 1, 0, 0]);
  }, 30_000);
});

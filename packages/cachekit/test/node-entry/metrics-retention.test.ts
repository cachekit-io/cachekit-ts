import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Hits and misses wait in pending counts until a scrape. Clearing a counter's
 * samples must also let go of the counts of collectors that are gone, as
 * prom-client lets go of the series it clears, or a process that prunes
 * per-tenant series keeps every tenant it ever saw. Runs the BUILT CommonJS
 * entry (`pnpm build` first) in a process with --expose-gc.
 */

const run = promisify(execFile);
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(pkgDir, 'dist', 'cjs', 'index.js');

beforeAll(() => {
  if (!existsSync(entry)) throw new Error(`${entry} is missing: run \`pnpm build\` first`);
});

type Result = { tracked: number; alive: number; liveHits: number };

async function probe(mode: 'reset' | 'remove'): Promise<Result> {
  const { stdout } = await run(
    process.execPath,
    ['--expose-gc', join(pkgDir, 'test', 'node-entry', 'metrics-retention-probe.cjs'), entry, mode],
    { timeout: 20_000 }
  );
  return JSON.parse(stdout) as Result;
}

describe('pending hit and miss counts after their samples are cleared', () => {
  it.each(['reset', 'remove'] as const)(
    'by %s, hold no collector that is gone, and keep counting for one that is not',
    async (mode) => {
      expect(await probe(mode)).toEqual({ tracked: 1000, alive: 0, liveHits: 2 });
    },
    // above the probe's own 20 s limit
    30_000
  );
});

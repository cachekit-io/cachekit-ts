import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * An app may load the package for the first time inside a request: a lazy
 * import in a handler that runs in an AsyncLocalStorage context. Nothing the
 * package's modules make as they load may keep that context, and so the
 * request, for the life of the process; a key memo's timer may keep it only
 * until its window ends. These tests run the BUILT CommonJS entry (`pnpm build`
 * first), whose module cache lets a fresh process load the package's own
 * modules again inside a request; the ES module build compiles the same source.
 * The cold case loads the dependencies there too, the native core included:
 * napi-rs built with `napi4` makes a process-lifetime threadsafe function as
 * the core registers, and that function keeps the context it was made in.
 */

const run = promisify(execFile);
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(pkgDir, 'dist', 'cjs', 'index.js');

beforeAll(() => {
  if (!existsSync(entry)) throw new Error(`${entry} is missing: run \`pnpm build\` first`);
});

/** Whether the request's context could still be reached after `waitMs` of collecting. */
async function retained(ttl: number, waitMs: number, mode = 'warm'): Promise<boolean> {
  const { stdout } = await run(
    process.execPath,
    [
      '--expose-gc',
      join(pkgDir, 'test', 'node-entry', 'first-load-context-probe.cjs'),
      entry,
      String(ttl),
      String(waitMs),
      mode,
    ],
    { timeout: 20_000 }
  );
  return (JSON.parse(stdout) as { retained: boolean }).retained;
}

describe('the package loaded first inside a request', () => {
  it('keeps no part of the request once it ends, under a ttl that keeps no memo', async () => {
    // Shorter than the one-second window a memo's timer could keep it for.
    expect(await retained(0, 300)).toBe(false);
  });

  it('keeps the request only until the window of the memo it filled ends', async () => {
    // A window runs one second at most.
    expect(await retained(60, 5_000)).toBe(false);
  });

  it('keeps no part of the request when its dependencies load there too', async () => {
    expect(await retained(0, 300, 'cold')).toBe(false);
  });

  it('keeps no part of the request that first hashes in JS', async () => {
    expect(await retained(0, 300, 'js-hash')).toBe(false);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * On Node.js 24 and later, with the native binding loaded, the Node entry must
 * not load @noble/hashes until something hashes in JS: keys hash in Rust, and
 * loading noble costs about 5 ms of every cold start. On Node 22 and 23 it
 * still loads with the package (src/serialization/blake2b.ts says why).
 * These tests run the BUILT entries (`pnpm build` first): the deferred load
 * goes through require(esm), which only a real Node process runs, and the
 * CommonJS build resolves its own package.json `imports`.
 */

const run = promisify(execFile);
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entries = {
  esm: join(pkgDir, 'dist', 'index.js'),
  cjs: join(pkgDir, 'dist', 'cjs', 'index.js'),
} as const;
const loadsOnImport = Number(process.versions.node.split('.')[0]) < 24;

beforeAll(() => {
  for (const entry of Object.values(entries)) {
    if (!existsSync(entry)) throw new Error(`${entry} is missing: run \`pnpm build\` first`);
  }
});

describe.each(['esm', 'cjs'] as const)('built %s entry', (format) => {
  it('loads @noble/hashes only once something hashes in JS, and hashes the same', async () => {
    const { stdout } = await run(
      process.execPath,
      [join(pkgDir, 'test', 'node-entry', 'noble-probe.mjs'), format, entries[format]],
      { timeout: 20_000 }
    );
    const probe = JSON.parse(stdout) as {
      afterImport: boolean;
      afterKey: boolean;
      afterJsHash: boolean;
      key: string;
      fileName: string;
    };
    // afterJsHash is the positive control: the probe can see noble at all.
    expect(probe).toMatchObject({
      afterImport: loadsOnImport,
      afterKey: loadsOnImport,
      afterJsHash: true,
    });
    expect(probe.key).toBe(
      'probe:405f09a3617bcc1425ea95b9840d9c2713e3ecebd5a3227abc599317b732e21a'
    );
    expect(probe.fileName).toBe(bytesToHex(blake2b(utf8ToBytes(probe.key), { dkLen: 16 })));
  });
});

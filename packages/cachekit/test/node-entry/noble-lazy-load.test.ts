import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * On Node.js 24 and later, with the native binding loaded, the CommonJS build
 * must not load @noble/hashes until something hashes in JS: keys hash in Rust,
 * and loading noble costs about 5 ms of every cold start. On Node 22 and 23 it
 * still loads with the package, and the ES module build always imports it
 * (src/serialization/blake2b.ts says why). These tests run the BUILT entries
 * (`pnpm build` first): the deferred load goes through require(esm), which
 * only a real Node process runs, and each build resolves its own `imports`.
 */

const run = promisify(execFile);
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entries = {
  esm: join(pkgDir, 'dist', 'index.js'),
  cjs: join(pkgDir, 'dist', 'cjs', 'index.js'),
} as const;
const probeKey = 'probe:405f09a3617bcc1425ea95b9840d9c2713e3ecebd5a3227abc599317b732e21a';
const loadsOnImport = Number(process.versions.node.split('.')[0]) < 24;
const runProbe = async (file: string, args: string[] = []) =>
  JSON.parse(
    (
      await run(process.execPath, [join(pkgDir, 'test', 'node-entry', file), ...args], {
        timeout: 20_000,
      })
    ).stdout
  ) as { key: string; fileName: string };

beforeAll(() => {
  for (const entry of Object.values(entries)) {
    if (!existsSync(entry)) throw new Error(`${entry} is missing: run \`pnpm build\` first`);
  }
});

// Without require(esm) (Node 22.0 to 22.11), the CommonJS build does not load.
describe.skipIf(!process.features.require_module)('built CommonJS entry', () => {
  it('loads @noble/hashes only once something hashes in JS, and hashes the same', async () => {
    const probe = (await runProbe('noble-probe.mjs', ['cjs', entries.cjs])) as {
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
      key: probeKey,
    });
    expect(probe.fileName).toBe(bytesToHex(blake2b(utf8ToBytes(probe.key), { dkLen: 16 })));
  });

  // An ES module app that loads the package through a CommonJS module, then
  // imports noble itself. On Node 22.15, 22.16 and 23 the import-time
  // require(esm) returns noble before its bindings exist, so the binding is
  // read at each call, never at load. On 22.12 to 22.14 that require throws,
  // as a static require of noble did before.
  it.skipIf(/^22\.1[234]\./.test(process.versions.node))(
    'loads from a CommonJS module the app imports before @noble/hashes',
    async () => {
      const { key, fileName } = await runProbe('noble-cjs-after-probe.mjs');
      expect(key).toBe(probeKey);
      expect(fileName).toBe(bytesToHex(blake2b(utf8ToBytes(key), { dkLen: 16 })));
    }
  );
});

// The ES module build imports noble statically on every Node version, so noble
// is evaluated before the package's own code, as the app's graph orders it,
// and never goes through require(esm).
it('imports @noble/hashes statically in the ES module build', async () => {
  const probe = (await runProbe('noble-probe.mjs', ['esm', entries.esm])) as {
    afterJsHash: boolean;
    key: string;
    fileName: string;
  };
  expect(probe).toMatchObject({ afterJsHash: false, key: probeKey });
  expect(probe.fileName).toBe(bytesToHex(blake2b(utf8ToBytes(probe.key), { dkLen: 16 })));
});

// A lazy require(esm) fails here up to Node 22.17 and on 23: noble is linked
// but not evaluated while the module the app imports first runs and hashes.
it('hashes in JS from a module the app imports before @noble/hashes', async () => {
  const { key, fileName } = await runProbe('noble-after-probe.mjs');
  expect(key).toBe(probeKey);
  expect(fileName).toBe(bytesToHex(blake2b(utf8ToBytes(key), { dkLen: 16 })));
});

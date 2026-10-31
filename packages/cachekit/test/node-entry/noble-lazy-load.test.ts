import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// The probe sees only a load through require(esm). The ES module build loads
// noble through its ES module loader on Node 22 and 23 (esm-preload.ts), and
// without require(esm) (Node 22.0 to 22.11) the CommonJS build does not load.
describe.skipIf(!process.features.require_module).each(['esm', 'cjs'] as const)(
  'built %s entry',
  (format) => {
    it.skipIf(format === 'esm' && loadsOnImport)(
      'loads @noble/hashes only once something hashes in JS, and hashes the same',
      async () => {
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
      }
    );
  }
);

// In the ES module build, `#noble-preload` holds noble on Node 22 and 23, so
// noble is evaluated before the package's own code, and nothing on Node 24 and
// later. Node 22.18 and later would pass the test below without it, so this
// one is what CI's Node 22 checks.
it('preloads @noble/hashes in the ES module build exactly below Node 24', async () => {
  const { stdout } = await run(
    process.execPath,
    [join(pkgDir, 'test', 'node-entry', 'noble-preload-probe.mjs')],
    { timeout: 20_000 }
  );
  expect(stdout.trim()).toBe(loadsOnImport ? 'function' : 'undefined');
});

// Up to Node 22.17 and on 23, require(esm) fails for a module an import graph
// has linked but not evaluated, which is where noble stands while the module
// the app imports first runs and hashes in JS.
it('hashes in JS from a module the app imports before @noble/hashes', async () => {
  const { stdout } = await run(
    process.execPath,
    [join(pkgDir, 'test', 'node-entry', 'noble-after-probe.mjs')],
    { timeout: 20_000 }
  );
  const { key, fileName } = JSON.parse(stdout) as { key: string; fileName: string };
  expect(key).toBe('probe:405f09a3617bcc1425ea95b9840d9c2713e3ecebd5a3227abc599317b732e21a');
  expect(fileName).toBe(bytesToHex(blake2b(utf8ToBytes(key), { dkLen: 16 })));
});

// A concurrent import() whose graph holds the same noble and finishes loading
// after the package: Node 22.23 refuses require(esm) of it with an internal
// assertion while it is still loading.
it('loads beside a concurrent import that loads @noble/hashes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cachekit-noble-race-'));
  try {
    const noble = pathToFileURL(createRequire(entries.esm).resolve('@noble/hashes/blake2.js'));
    const chain = 5;
    for (let i = 1; i <= chain; i++) {
      const next = i < chain ? `import './m${i + 1}.mjs';\n` : '';
      await writeFile(join(dir, `m${i}.mjs`), `${next}export const v = ${i};\n`);
    }
    await writeFile(join(dir, 'x.mjs'), `import '${noble.href}';\nimport './m1.mjs';\n`);
    await writeFile(
      join(dir, 'app.mjs'),
      `const [{ generateKey }] = await Promise.all([` +
        `import('${pathToFileURL(entries.esm).href}'), import('./x.mjs')]);\n` +
        `console.log(JSON.stringify({ key: generateKey('probe', [1]) }));\n`
    );
    const { stdout } = await run(process.execPath, [join(dir, 'app.mjs')], { timeout: 20_000 });
    expect(JSON.parse(stdout)).toEqual({
      key: 'probe:405f09a3617bcc1425ea95b9840d9c2713e3ecebd5a3227abc599317b732e21a',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

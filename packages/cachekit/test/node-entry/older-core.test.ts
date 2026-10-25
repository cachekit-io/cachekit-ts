import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { MEMOISABLE_KEYS, PINNED_NAMESPACE } from '../fixtures/auto-mode-keys.js';

/**
 * A published @cachekit-io/cachekit can depend on a core-ts released before
 * blake2b256Hex existed. Node's own ESM loader must then load the built entry
 * and key in JS, not fail the import on a missing named export. Only a real
 * Node process shows this: the loader reads a CommonJS module's export names
 * from its source, and bundlers and vitest resolve them differently.
 */

const run = promisify(execFile);
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(pkgDir, 'dist', 'index.js');
const probe = join(pkgDir, 'test', 'node-entry', 'key-probe.mjs');
const { args, key } = MEMOISABLE_KEYS.find((k) => k.name === 'one')!;
let dir: string;

beforeAll(async () => {
  if (!existsSync(entry)) throw new Error(`${entry} is missing: run \`pnpm build\` first`);
  dir = await mkdtemp(join(tmpdir(), 'cachekit-older-core-'));
  // The real core-ts, minus blake2b256Hex, with each export assigned by name
  // so Node's CommonJS lexer lists exactly those.
  const real = createRequire(entry).resolve('@cachekit-io/cachekit-core-ts');
  const names = Object.keys(createRequire(entry)(real)).filter((n) => n !== 'blake2b256Hex');
  await writeFile(
    join(dir, 'older-core.cjs'),
    `const real = require(${JSON.stringify(real)});\n` +
      names.map((n) => `module.exports.${n} = real.${n};\n`).join('')
  );
  const stub = pathToFileURL(join(dir, 'older-core.cjs')).href;
  await writeFile(
    join(dir, 'hooks.mjs'),
    `export async function resolve(specifier, context, next) {\n` +
      `  if (specifier === '@cachekit-io/cachekit-core-ts') return { url: ${JSON.stringify(stub)}, shortCircuit: true };\n` +
      `  return next(specifier, context);\n}\n`
  );
  await writeFile(
    join(dir, 'register.mjs'),
    `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(join(dir, 'hooks.mjs')).href)});\n`
  );
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const keyThrough = async (nodeArgs: string[]) => {
  const { stdout } = await run(
    process.execPath,
    [...nodeArgs, probe, entry, PINNED_NAMESPACE, JSON.stringify(args)],
    { timeout: 20_000 }
  );
  return JSON.parse(stdout) as { bound: boolean; key: string };
};

describe('built ESM entry', () => {
  it('keys in JS when core-ts has no blake2b256Hex', async () => {
    expect(await keyThrough(['--import', join(dir, 'register.mjs')])).toEqual({
      bound: false,
      key,
    });
  });

  // The control: the same probe sees the binding when core-ts has it.
  it('keys through the binding when core-ts has blake2b256Hex', async () => {
    expect(await keyThrough([])).toEqual({ bound: true, key });
  });
});

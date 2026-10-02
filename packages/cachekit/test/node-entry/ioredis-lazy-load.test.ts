import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build, type Plugin } from 'esbuild';
import { startFakeRedis, type FakeRedis } from '../fixtures/fake-redis.js';

/**
 * The Node entry must not load ioredis until the app creates a Redis
 * backend: ioredis costs about 30 ms of every cold start, and most apps never
 * use Redis. These tests run the BUILT entries (`pnpm build` first), because
 * the CommonJS build is where TypeScript rewrites the lazy import, and they
 * bundle with esbuild, because a loader a bundler cannot see would break
 * every bundled app that does use Redis.
 */

const run = promisify(execFile);
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entries = {
  esm: join(pkgDir, 'dist', 'index.js'),
  cjs: join(pkgDir, 'dist', 'cjs', 'index.js'),
} as const;

beforeAll(() => {
  for (const entry of Object.values(entries)) {
    if (!existsSync(entry)) throw new Error(`${entry} is missing: run \`pnpm build\` first`);
  }
});

describe.each(['esm', 'cjs'] as const)('built %s entry', (format) => {
  it('loads ioredis only once a Redis backend is created', async () => {
    const { stdout } = await run(
      process.execPath,
      [join(pkgDir, 'test', 'node-entry', 'load-probe.mjs'), format, entries[format]],
      { timeout: 20_000 }
    );
    // afterRedis is the positive control: the probe can see ioredis at all.
    expect(JSON.parse(stdout)).toEqual({ afterImport: false, afterRedis: true });
  });
});

/**
 * The native core is stubbed, so the bundle runs from a directory with no
 * node_modules: the only ioredis it can reach is the copy inside it. The
 * minimal app never touches the core.
 */
const stubNativeCore: Plugin = {
  name: 'stub-native-core',
  setup(api) {
    api.onResolve({ filter: /^@cachekit-io\/cachekit-core-ts$/ }, () => ({
      path: 'core',
      namespace: 'stub',
    }));
    api.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};' }));
  },
};

// ioredis is CommonJS and requires Node builtins, which code in an esbuild
// ESM bundle can only do with a `require` in scope: the usual banner for ESM
// bundles on Node.
const ESM_REQUIRE_BANNER =
  "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

const APP_BODY = `
  const backend = redis({ url: process.env.REDIS_URL });
  await backend.set('k', new Uint8Array([1, 2, 3]), 60);
  const value = await backend.get('k');
  await backend.close();
  console.log(JSON.stringify({ value: Array.from(value) }));
`;

const apps = {
  esm: `import { redis } from ${JSON.stringify(entries.esm)};\n${APP_BODY}`,
  cjs: `const { redis } = require(${JSON.stringify(entries.cjs)});\n(async () => {${APP_BODY}})();`,
} as const;

describe('bundled app (esbuild, platform node)', () => {
  let fakeRedis: FakeRedis;
  let outDir: string;

  beforeAll(async () => {
    fakeRedis = await startFakeRedis();
    outDir = await mkdtemp(join(tmpdir(), 'cachekit-bundle-'));
  });

  afterAll(async () => {
    await fakeRedis?.close();
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });

  it.each(['esm', 'cjs'] as const)(
    '%s output bundles ioredis and loads it at the first command',
    async (format) => {
      const outfile = join(outDir, `app.${format === 'esm' ? 'mjs' : 'cjs'}`);
      const result = await build({
        stdin: { contents: apps[format], resolveDir: pkgDir, sourcefile: `app.${format}.js` },
        bundle: true,
        platform: 'node',
        format,
        outfile,
        metafile: true,
        banner: format === 'esm' ? { js: ESM_REQUIRE_BANNER } : undefined,
        plugins: [stubNativeCore],
        logLevel: 'silent',
      });
      const bundled = Object.keys(result.metafile.inputs).some((input) =>
        input.includes('node_modules/ioredis/')
      );
      expect(bundled, 'esbuild did not follow the ioredis import into the bundle').toBe(true);

      const { stdout } = await run(process.execPath, [outfile], {
        cwd: outDir,
        env: { ...process.env, REDIS_URL: fakeRedis.url },
        timeout: 20_000,
      });
      expect(JSON.parse(stdout)).toEqual({ value: [1, 2, 3] });
    },
    30_000
  );
});

/**
 * Telemetry off through the Worker's bindings where `cloudflare:workers` does
 * not export them (protocol spec/saas-api.md, API-94 and API-96). The
 * @cloudflare/vitest-plugin pool cannot run under `disallow_importable_env`:
 * its own runner reads the importable env. So this test bundles the real
 * Workers entry (telemetry-probe.worker.ts) and runs it in workerd through
 * Miniflare, and reads each request's headers off the outbound service.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

interface MiniflareLike {
  dispatchFetch(url: string): Promise<{ text(): Promise<string> }>;
  dispose(): Promise<void>;
}
interface MiniflareModule {
  Miniflare: new (options: unknown) => MiniflareLike;
  convertV4MiniflareOptions(options: unknown): unknown;
}

// Miniflare comes with @cloudflare/vitest-plugin, which pins its version.
const { Miniflare, convertV4MiniflareOptions } = createRequire(
  import.meta.resolve('@cloudflare/vitest-plugin')
)('miniflare') as MiniflareModule;

const OPTIONAL_METRICS = [
  'x-cachekit-session-id',
  'x-cachekit-session-start',
  'x-cachekit-l1-hits',
  'x-cachekit-l2-hits',
  'x-cachekit-misses',
  'x-cachekit-l1-hit-rate',
  'x-cachekit-l1-latency-buckets',
  'x-cachekit-l1-latency-sum-ns',
  'x-cachekit-l1-latency-one-in',
];
const PATHS = ['/instance', '/instance-telemetry-true', '/config', '/io'];

let worker: string;
let wasm: Buffer;

beforeAll(async () => {
  let wasmPath: string | undefined;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./telemetry-probe.worker.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd'],
    external: ['cloudflare:*'],
    logLevel: 'silent',
    plugins: [
      {
        // wrangler's CompiledWasm rule: the .wasm import is a WebAssembly.Module.
        name: 'compiled-wasm',
        setup(builder) {
          builder.onResolve({ filter: /\.wasm$/ }, (args) => {
            wasmPath = join(args.resolveDir, args.path);
            return { path: './core.wasm', external: true };
          });
        },
      },
    ],
  });
  worker = bundle.outputFiles[0].text;
  wasm = await readFile(wasmPath!);
});

/** Run `paths` in a fresh workerd; return its runtime facts and every request's headers. */
async function run(
  compatibilityFlags: string[],
  bindings: Record<string, string>,
  paths: string[]
) {
  const sent: Record<string, string>[] = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: [
        { type: 'ESModule', path: 'worker.mjs', contents: worker },
        { type: 'CompiledWasm', path: 'core.wasm', contents: wasm },
      ],
      compatibilityDate: '2026-07-01',
      compatibilityFlags,
      bindings,
      outboundService: (request: Request) => {
        sent.push(Object.fromEntries(request.headers));
        return request.method === 'PUT' ? new Response('{}') : new Response(null, { status: 404 });
      },
    })
  );
  try {
    const runtime = JSON.parse(await (await mf.dispatchFetch('http://probe/runtime')).text());
    for (const path of paths) {
      expect(await (await mf.dispatchFetch(`http://probe${path}`)).text(), path).toBe('ok');
    }
    return { runtime, sent };
  } finally {
    await mf.dispose();
  }
}

function expectNoOptionalHeader(sent: Record<string, string>[]): void {
  expect(sent.length).toBeGreaterThanOrEqual(PATHS.length);
  for (const headers of sent) {
    for (const name of OPTIONAL_METRICS) expect(headers[name], name).toBeUndefined();
    // Kept with telemetry off: API-1 requires L1-Status on every ck_sdk_ request.
    expect(headers['x-cachekit-l1-status']).toBeDefined();
    expect(headers['user-agent']).toMatch(/cachekit/i);
  }
}

describe('Workers telemetry switch in real workerd (API-94, API-96)', () => {
  it('control: with the bindings importable and no variable, telemetry is on', async () => {
    const { runtime, sent } = await run([], {}, ['/instance']);
    expect(runtime).toEqual({ disallowImportableEnv: false, binding: null });
    expect(sent[0]['x-cachekit-session-id']).toBeDefined();
    expect(sent[0]['x-cachekit-l1-hits']).toBe('3');
  });

  it.each([[[]], [['nodejs_compat']]])(
    'with disallow_importable_env and %j, a binding set to off sends no optional header',
    async (extraFlags) => {
      const { runtime, sent } = await run(
        ['disallow_importable_env', ...extraFlags],
        { CACHEKIT_TELEMETRY: 'off' },
        PATHS
      );
      expect(runtime).toEqual({ disallowImportableEnv: true, binding: 'off' });
      expectNoOptionalHeader(sent);
    }
  );

  it('with disallow_importable_env, telemetry is off even with no binding: it cannot be read', async () => {
    const { runtime, sent } = await run(['disallow_importable_env'], {}, PATHS);
    expect(runtime).toEqual({ disallowImportableEnv: true, binding: null });
    expectNoOptionalHeader(sent);
  });
});

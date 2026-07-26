import { readFileSync } from 'node:fs';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/** Minimal cachekit.io SaaS emulation: PUT/GET/HEAD/DELETE /v1/cache/:key. */
function createMockCachekitIO() {
  const store = new Map<string, Uint8Array>();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.hostname !== 'api.cachekit.io') {
      return new Response(`unexpected outbound host: ${url.hostname}`, { status: 502 });
    }
    if (request.headers.get('Authorization')?.startsWith('Bearer ') !== true) {
      return new Response('missing bearer token', { status: 401 });
    }
    const match = url.pathname.match(/^\/v1\/cache\/(.+)$/);
    if (!match) return new Response('not found', { status: 404 });
    const key = decodeURIComponent(match[1]);

    switch (request.method) {
      case 'PUT':
        store.set(key, new Uint8Array(await request.arrayBuffer()));
        return new Response('ok');
      case 'GET': {
        const value = store.get(key);
        if (value === undefined) return new Response('not found', { status: 404 });
        return new Response(value.slice());
      }
      case 'HEAD':
        return new Response(null, { status: store.has(key) ? 200 : 404 });
      case 'DELETE':
        return new Response(null, { status: store.delete(key) ? 200 : 404 });
      default:
        return new Response('method not allowed', { status: 405 });
    }
  };
}

const mockCachekitIOService = createMockCachekitIO();

/**
 * Workers test lane (LAB-595): runs test/workers/** inside real workerd via
 * @cloudflare/vitest-pool-workers — protocol vector suites against the wasm
 * bindings, plus a CachekitIO backend smoke test. The default vitest config
 * (Node lane) excludes these tests.
 *
 * The wasmCompiledModule plugin reproduces wrangler's CompiledWasm semantics
 * for `.wasm` imports (default export = WebAssembly.Module) so the package's
 * production entry — wasm module import + initSync — runs verbatim under
 * test. Without it, vite's own SSR wasm transform tries a runtime fs read,
 * which cannot work inside workerd; the pool's UnsafeEval binding
 * (newWasmModule) is miniflare's own mechanism for exactly this.
 */
export default defineConfig({
  plugins: [
    {
      name: 'wasm-compiled-module',
      enforce: 'pre',
      load(id) {
        const path = id.split('?')[0];
        if (!path.endsWith('.wasm')) return null;
        const base64 = readFileSync(path).toString('base64');
        return `
          import { env } from 'cloudflare:test';
          const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));
          export default env.__VITEST_POOL_WORKERS_UNSAFE_EVAL.newWasmModule(bytes);
        `;
      },
    },
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-07-01',
        // In-memory mock of the CachekitIO API for the backend smoke test:
        // every fetch the tests make leaves workerd through this service
        // (real Request/Response marshalling, binary-safe bodies). Unknown
        // hosts 502 so tests can never reach the network.
        outboundService: mockCachekitIOService,
        // Real KV binding for the Workers KV backend tests (LAB-750).
        kvNamespaces: ['TEST_KV'],
      },
    }),
  ],
  test: {
    include: ['test/workers/**/*.test.ts'],
    testTimeout: 10000,
  },
});

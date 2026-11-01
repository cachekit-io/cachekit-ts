/**
 * Workers has no clock that advances during synchronous execution, so it
 * sends no L1-latency header at all (protocol spec/saas-api.md, API-82), and
 * it reads CACHEKIT_TELEMETRY from the Worker's bindings (API-94).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { createCache, cachekitio } from '../../src/workers/index.js';

const BACKEND = { apiKey: 'ck_test_fake-not-a-secret' }; // pragma: allowlist secret
const LATENCY = [
  'X-CacheKit-L1-Latency-Buckets',
  'X-CacheKit-L1-Latency-Sum-Ns',
  'X-CacheKit-L1-Latency-One-In',
];

let fetchSpy: ReturnType<typeof vi.fn>;
const bindings = env as unknown as Record<string, unknown>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete bindings.CACHEKIT_TELEMETRY;
});

function sentHeaders(): Record<string, string>[] {
  return (fetchSpy.mock.calls as [string, RequestInit][]).map(
    ([, init]) => init.headers as Record<string, string>
  );
}

describe('telemetry on Workers', () => {
  it('times no L1 hit and sends no latency header, never zeros (API-82)', async () => {
    const cache = createCache({ backend: BACKEND, metrics: false });
    const fn = cache.wrap(async (id: number) => ({ id }), { namespace: 'svc:get', ttl: 60 });
    for (let i = 0; i < 5_000; i++) await fn(7);
    await cache.get('svc:other');
    const headers = sentHeaders();
    expect(headers.length).toBeGreaterThan(0);
    for (const sent of headers) {
      for (const name of LATENCY) expect(sent[name], name).toBeUndefined();
    }
    // Telemetry itself is on: the session headers still go.
    expect(headers.at(-1)!['X-CacheKit-Session-ID']).toBeDefined();
    await cache.close();
  });

  it("reads CACHEKIT_TELEMETRY from the Worker's bindings: off wins (API-94)", async () => {
    bindings.CACHEKIT_TELEMETRY = 'off';
    const backend = cachekitio(BACKEND);
    await backend.get('svc:k');
    const sent = sentHeaders().at(-1)!;
    expect(sent['X-CacheKit-Session-ID']).toBeUndefined();
    expect(sent['X-CacheKit-L1-Status']).toBeDefined();
    expect(backend.l1Latency).toBeUndefined();
  });
});

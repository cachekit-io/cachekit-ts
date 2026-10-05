/**
 * Call-shape gates for the CachekitIO backend: the exact requests each op
 * puts on the wire, and the TLS connections a client opens, against a local
 * TLS fake of the SaaS (fake-saas.ts).
 *
 * These are deterministic counts, so the assertions are exact. Every extra
 * request is one more round trip to the SaaS, and every extra connection is
 * a TCP + TLS handshake, so a change to any number here is a latency change
 * and must be deliberate: update the expectation in the same PR, and say why.
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CachekitIOCore } from '../../src/backends/cachekitio.js';
import { createCache } from '../../src/index.js';
import type { Cache, CacheOptions } from '../../src/index.js';
import { startFakeSaas, type FakeSaas } from './fake-saas.js';

// Requests the global fetch dispatcher has started and not yet finished.
// A release the SDK fires without awaiting (the lock DELETE) is still in
// flight when the op resolves; settle() waits it out before counting.
let inFlight = 0;
const onCreate = () => inFlight++;
const onDone = () => inFlight--;

async function settle(): Promise<void> {
  // A fetch the op started but did not await is dispatched within the
  // microtasks that follow; a macrotask boundary drains them.
  await nextMacrotask();
  const deadline = Date.now() + 5_000;
  while (inFlight > 0) {
    if (Date.now() > deadline) throw new Error(`${inFlight} request(s) still in flight after 5 s`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const FAKE_API_KEY = 'ck_test_fake-not-a-secret'; // pragma: allowlist secret
let saas: FakeSaas;
const caches: Cache[] = [];

function cacheFor(extra: Partial<CacheOptions> = {}): Cache {
  const cache = createCache({
    backend: { apiKey: FAKE_API_KEY, apiUrl: saas.url, allowCustomHost: true },
    l1: { enabled: false },
    metrics: false,
    ...extra,
  });
  caches.push(cache);
  return cache;
}

/** Run `op` once per index and return the request sequence each produced. */
async function shapes(n: number, op: (i: number) => Promise<unknown>): Promise<string[][]> {
  const out: string[][] = [];
  for (let i = 0; i < n; i++) {
    const before = saas.requests().length;
    await op(i);
    await settle();
    out.push(saas.requests().slice(before));
  }
  return out;
}

const compute = async (id: number) => ({ id, name: `user-${id}` });

/** Requests each op sends, as asserted per op below and over whole runs. */
const SHAPES: Record<string, string[]> = {
  'wrap miss': ['GET cache', 'PUT cache'],
  'wrap L2 hit': ['GET cache'],
  'locked wrap miss': ['GET cache', 'POST lock', 'PUT cache', 'DELETE lock'],
};

beforeEach(async () => {
  diagnosticsChannel.subscribe('undici:request:create', onCreate);
  diagnosticsChannel.subscribe('undici:request:trailers', onDone);
  diagnosticsChannel.subscribe('undici:request:error', onDone);
  inFlight = 0;
  // A fresh listener per test is a fresh origin, so the dispatcher's pool
  // starts empty and the first op's connection is counted.
  saas = await startFakeSaas();
});

afterEach(async () => {
  await Promise.all(caches.splice(0).map((c) => c.close()));
  await saas.close();
  diagnosticsChannel.unsubscribe('undici:request:create', onCreate);
  diagnosticsChannel.unsubscribe('undici:request:trailers', onDone);
  diagnosticsChannel.unsubscribe('undici:request:error', onDone);
});

describe('CachekitIO call shape: requests per op', () => {
  const N = 10;

  it('wrap miss is GET then PUT', async () => {
    const getUser = cacheFor().wrap(compute, { namespace: 'shape', ttl: 60 });
    const seen = await shapes(N, (i) => getUser(i));
    expect(seen).toEqual(Array.from({ length: N }, () => SHAPES['wrap miss']));
  });

  it('wrap L2 hit is one GET', async () => {
    const getUser = cacheFor().wrap(compute, { namespace: 'shape', ttl: 60 });
    for (let i = 0; i < N; i++) await getUser(i);
    await settle();
    const seen = await shapes(N, (i) => getUser(i));
    expect(seen).toEqual(Array.from({ length: N }, () => SHAPES['wrap L2 hit']));
  });

  // An uncontended grant after a clean miss skips the double-check GET (LAB-7119):
  // 5 requests to 4. The unlock is sent in the background, off the caller's path.
  it('locked wrap miss is GET, lock, PUT, unlock', async () => {
    const cache = cacheFor({ stampede: { distributedLock: true } });
    const getUser = cache.wrap(compute, { namespace: 'shape', ttl: 60 });
    const seen = await shapes(N, (i) => getUser(i));
    expect(seen).toEqual(Array.from({ length: N }, () => SHAPES['locked wrap miss']));
  });
});

describe('CachekitIO call shape: connections', () => {
  // Node's fetch opens a second connection when the next request is
  // dispatched in the same macrotask that finished reading the previous
  // response (measured on Node 22.23, 24.21 and 26.8, undici 6 to 8). So a
  // wrap miss's PUT, which follows its GET with no gap, opens a second
  // connection on a cold client and pays a TCP + TLS handshake, and so does
  // any caller that awaits ops back to back. The control shows that one
  // macrotask between requests keeps it at one.
  const ops = 100;

  it('control: requests a macrotask apart share one connection', async () => {
    const cache = cacheFor();
    for (let i = 0; i < ops; i++) {
      await cache.get(`shape:raw:${i}`);
      await nextMacrotask();
    }
    expect(saas.requests()).toHaveLength(ops);
    expect(saas.connections()).toBe(1);
  });

  // These runs cannot go through shapes(): its settle() puts a macrotask
  // between ops, which is exactly what changes the connection count. So the
  // per-op shape is checked over the whole run instead: the request list must
  // be that shape repeated, so an op that gains a request cannot hide behind
  // one that loses one. Connections stay a run total; they belong to the run.
  it.each([
    { scenario: 'wrap miss', lock: false, prefill: false, connections: 2, ordered: true },
    { scenario: 'wrap L2 hit', lock: false, prefill: true, connections: 2, ordered: true },
    // The unlock is not awaited, so it is still in flight when the next op
    // starts: that op needs a third connection, and the unlock can land after
    // its first GET. So only the multiset of requests is fixed, not the order.
    { scenario: 'locked wrap miss', lock: true, prefill: false, connections: 3, ordered: false },
  ])(
    '$connections connections per $scenario x 100, back to back',
    async ({ scenario, lock, prefill, connections, ordered }) => {
      const shape = SHAPES[scenario];
      const getUser = cacheFor({ stampede: { distributedLock: lock } }).wrap(compute, {
        namespace: 'shape',
        ttl: 60,
      });
      if (prefill) {
        for (let i = 0; i < ops; i++) await getUser(i);
        await settle();
        saas.resetCounters();
      }
      for (let i = 0; i < ops; i++) await getUser(i);
      await settle();
      const expected = Array.from({ length: ops }, () => shape).flat();
      const seen = saas.requests();
      if (ordered) expect(seen).toEqual(expected);
      else expect([...seen].sort()).toEqual([...expected].sort());
      expect(saas.connections()).toBe(connections);
    }
  );
});

describe('CachekitIO call shape: redirects', () => {
  // The API never redirects, so a 3xx is an error and the client sends
  // nothing to the Location it names: exactly one request per op.
  const ops = {
    get: { method: 'GET', run: (b: CachekitIOCore, key: string) => b.get(key) },
    set: {
      method: 'PUT',
      run: (b: CachekitIOCore, key: string) => b.set(key, new Uint8Array([1]), 60),
    },
    delete: { method: 'DELETE', run: (b: CachekitIOCore, key: string) => b.delete(key) },
    exists: { method: 'HEAD', run: (b: CachekitIOCore, key: string) => b.exists(key) },
  };
  const cases = Object.keys(ops).flatMap((op) =>
    [301, 302, 303, 307, 308].map((status) => ({ op: op as keyof typeof ops, status }))
  );

  it('control: a fetch that follows reaches the redirect target', async () => {
    const response = await fetch(`${saas.url}/v1/cache/redirect-307`, { method: 'PUT', body: 'x' });
    expect(await response.text()).toBe('followed');
    expect(saas.requests()).toEqual(['PUT redirect', 'PUT redirected']);
  });

  it.each(cases)(
    '$op on HTTP $status is a permanent error and is not followed',
    async ({ op, status }) => {
      const backend = new CachekitIOCore({
        apiKey: FAKE_API_KEY,
        apiUrl: saas.url,
        allowCustomHost: true,
      });
      await expect(ops[op].run(backend, `redirect-${status}`)).rejects.toMatchObject({
        name: 'BackendError',
        classification: 'permanent',
      });
      expect(saas.requests()).toEqual([`${ops[op].method} redirect`]);
    }
  );
});

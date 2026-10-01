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
    expect(seen).toEqual(Array.from({ length: N }, () => ['GET cache', 'PUT cache']));
  });

  it('wrap L2 hit is one GET', async () => {
    const getUser = cacheFor().wrap(compute, { namespace: 'shape', ttl: 60 });
    for (let i = 0; i < N; i++) await getUser(i);
    await settle();
    const seen = await shapes(N, (i) => getUser(i));
    expect(seen).toEqual(Array.from({ length: N }, () => ['GET cache']));
  });

  it('locked wrap miss is GET, lock, double-check GET, PUT, unlock', async () => {
    const cache = cacheFor({ stampede: { distributedLock: true } });
    const getUser = cache.wrap(compute, { namespace: 'shape', ttl: 60 });
    const seen = await shapes(N, (i) => getUser(i));
    expect(seen).toEqual(
      Array.from({ length: N }, () => [
        'GET cache',
        'POST lock',
        'GET cache',
        'PUT cache',
        'DELETE lock',
      ])
    );
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

  it('a wrap miss on a cold client opens a second connection for its PUT', async () => {
    const getUser = cacheFor().wrap(compute, { namespace: 'shape', ttl: 60 });
    await getUser(1);
    await settle();
    expect(saas.requests()).toEqual(['GET cache', 'PUT cache']);
    expect(saas.connections()).toBe(2);
  });

  it('control: requests a macrotask apart share one connection', async () => {
    const cache = cacheFor();
    for (let i = 0; i < ops; i++) {
      await cache.get(`shape:raw:${i}`);
      await nextMacrotask();
    }
    expect(saas.requests()).toHaveLength(ops);
    expect(saas.connections()).toBe(1);
  });

  it.each([
    { scenario: 'wrap miss', lock: false, prefill: false, perOp: 2, connections: 2 },
    { scenario: 'wrap L2 hit', lock: false, prefill: true, perOp: 1, connections: 2 },
    // The unlock is not awaited, so it is still in flight when the next op
    // starts, and that op needs a third connection.
    { scenario: 'locked wrap miss', lock: true, prefill: false, perOp: 5, connections: 3 },
  ])(
    '$connections connections per $scenario x 100, back to back',
    async ({ lock, prefill, perOp, connections }) => {
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
      expect(saas.requests()).toHaveLength(ops * perOp);
      expect(saas.connections()).toBe(connections);
    }
  );
});

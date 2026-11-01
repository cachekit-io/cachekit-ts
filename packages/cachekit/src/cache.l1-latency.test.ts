/**
 * L1 hit latency as the cache times it on Node (protocol spec/saas-api.md
 * § L1 hit latency): which calls are timed, over what interval, and how they
 * reach the CachekitIO backend's next request. The clock is faked; each test
 * names the requirement it pins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCache } from './index.js';
import { cachekitio } from './backends/cachekitio-factory.js';
import { L1LatencyReport } from './backends/telemetry.js';
import { generateKey } from './serialization/key-generator.js';
import type { SecureCache } from './types/cache.js';
import { InMemoryBackend } from '../test/fixtures/metrics.js';

const API_URL = 'https://api.test.cachekit.io';
const API_KEY = 'ck_test_fake-not-a-secret'; // pragma: allowlist secret
const BACKEND = { apiKey: API_KEY, apiUrl: API_URL, allowCustomHost: true };
const OPTIONS = { namespace: 'svc:getThing', ttl: 60 };

/** Each read of the fake clock returns `now`, then moves it on by STEP ns. */
const STEP = 250n;
let now: bigint;
let clockReads: number;
let fetchSpy: ReturnType<typeof vi.fn>;
let caches: SecureCache[];

/** A fake of the cache API: GET serves what PUT stored, a lock is always contested. */
function fakeServer() {
  const store = new Map<string, Uint8Array>();
  return vi.fn(async (url: string, init: RequestInit) => {
    const key = decodeURIComponent(new URL(url).pathname.slice('/v1/cache/'.length));
    if (key.endsWith('/lock')) return new Response(null, { status: 409 });
    switch (init.method) {
      case 'GET': {
        const value = store.get(key);
        return value ? new Response(value.slice()) : new Response(null, { status: 404 });
      }
      case 'PUT':
        store.set(key, init.body as Uint8Array);
        return new Response('{}');
      default:
        return new Response('{}');
    }
  });
}

function sent(call = -1): Record<string, string> {
  const calls = fetchSpy.mock.calls;
  const [, init] = calls[call < 0 ? calls.length + call : call] as [string, RequestInit];
  return init.headers as Record<string, string>;
}

/**
 * The report the requests since the last call carried, ending with a
 * cache.delete so that one request at least follows the hits. A background
 * refresh's write can be the one that carries it. At most one may.
 */
let scanned = 0;
async function nextReport(cache: SecureCache) {
  await cache.delete('svc:probe');
  const reports = (fetchSpy.mock.calls as [string, RequestInit][])
    .slice(scanned)
    .map(([, init]) => init.headers as Record<string, string>)
    .filter((headers) => headers['X-CacheKit-L1-Latency-Sum-Ns'] !== undefined);
  scanned = fetchSpy.mock.calls.length;
  expect(reports.length).toBeLessThanOrEqual(1);
  const headers = reports[0] ?? {};
  return {
    buckets: headers['X-CacheKit-L1-Latency-Buckets']?.split(',').map(Number),
    sum: headers['X-CacheKit-L1-Latency-Sum-Ns'],
    oneIn: headers['X-CacheKit-L1-Latency-One-In'],
  };
}

/** Bucket counts with `count` hits in bucket `index` (from 0). */
function only(index: number, count: number): number[] {
  const buckets = new Array<number>(16).fill(0);
  buckets[index] = count;
  return buckets;
}

/** Time every call of `cache`: tests the timing, not the sampling. */
function timeEveryCall(cache: SecureCache): SecureCache {
  (cache as unknown as { l1LatencyBelow: number }).l1LatencyBelow = 2 ** 30;
  return cache;
}

function track(cache: SecureCache): SecureCache {
  caches.push(cache);
  return cache;
}

beforeEach(() => {
  now = 1_000n;
  clockReads = 0;
  scanned = 0;
  caches = [];
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => {
    clockReads++;
    const reading = now;
    now += STEP;
    return reading;
  });
  fetchSpy = fakeServer();
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubEnv('CACHEKIT_TELEMETRY', undefined);
});

afterEach(async () => {
  for (const cache of caches) await cache.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('what is timed (API-79)', () => {
  it('times a memoised wrap() hit and an SWR L1 read, each once, over the whole call', async () => {
    const cache = track(timeEveryCall(createCache({ backend: BACKEND, metrics: false })));
    const fn = cache.wrap(async (id: number) => ({ id }), OPTIONS);
    await fn(7); // miss: drawn and started, then discarded
    await fn(7); // the L1 read by key, which hands the entry to the memo
    await fn(7); // the memoised hit
    // Two hits, each one STEP from its start to its stop.
    expect(await nextReport(cache)).toEqual({
      buckets: only(1, 2),
      sum: String(2n * STEP),
      oneIn: '1024',
    });
  });

  it('times an object-argument wrap() hit, which no memo keeps', async () => {
    const cache = track(timeEveryCall(createCache({ backend: BACKEND, metrics: false })));
    const fn = cache.wrap(async (q: { id: number }) => q, OPTIONS);
    await fn({ id: 1 });
    await fn({ id: 1 });
    expect((await nextReport(cache)).buckets).toEqual(only(1, 1));
  });

  it('times a get() that L1 serves', async () => {
    const cache = track(timeEveryCall(createCache({ backend: BACKEND, metrics: false })));
    await cache.set('svc:k', { v: 1 });
    expect(await cache.get('svc:k')).toEqual({ v: 1 });
    expect((await nextReport(cache)).buckets).toEqual(only(1, 1));
  });

  it('times hits on a cachekitio() instance passed as the backend', async () => {
    const backend = cachekitio(BACKEND);
    // One in 1: every call is timed, and the report says so.
    (backend as { l1Latency?: L1LatencyReport }).l1Latency = new L1LatencyReport(1);
    const cache = track(createCache({ backend, metrics: false }));
    await cache.set('svc:k', 1);
    await cache.get('svc:k');
    await cache.get('svc:k');
    expect(await nextReport(cache)).toEqual({
      buckets: only(1, 2),
      sum: String(2n * STEP),
      oneIn: '1',
    });
  });

  it("includes a stale serve's synchronous start of its revalidation", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const cache = track(timeEveryCall(createCache({ backend: BACKEND, metrics: false })));
    // The wrapped function's synchronous part takes 1 ms on the fake clock.
    const fn = cache.wrap(async (id: number) => {
      now += 1_000_000n;
      return { id };
    }, OPTIONS);
    await fn(7);
    // Past the stale point (half the ttl, plus at most 10% jitter), not past the ttl.
    vi.setSystemTime(Date.now() + 40_000);
    await fn(7);
    // The fn ran twice: the miss, and the revalidation the stale serve started.
    expect(now).toBe(1_000n + 2_000_000n + 3n * STEP);
    const report = await nextReport(cache);
    expect(report.sum).toBe(String(1_000_000n + STEP));
    expect(report.buckets).toEqual(only(13, 1)); // 524,289 to 1,048,576 ns
  });

  it('times a wrap() call whose cold-path read L1 serves', async () => {
    const cache = track(
      timeEveryCall(
        createCache({
          backend: BACKEND,
          metrics: false,
          stampede: { distributedLock: true, lockWaitMs: 40, lockPollMs: 10 },
        })
      )
    );
    const compute = vi.fn(async (id: number) => ({ id, computed: true }));
    const fn = cache.wrap(compute, OPTIONS);
    // L1 misses, L2 misses, the lock is contested: the call waits, then reads again.
    const call = fn(7);
    await new Promise((resolve) => setTimeout(resolve, 15));
    // Filled meanwhile, in process: the call's re-check finds it in L1.
    await cache.set(generateKey(OPTIONS.namespace, [7]), { id: 7, computed: false });
    expect(await call).toEqual({ id: 7, computed: false });
    expect(compute).not.toHaveBeenCalled();
    const report = await nextReport(cache);
    expect(report.buckets).toEqual(only(1, 1));
    expect(report.sum).toBe(String(STEP));
  });

  it('discards a timed call that turns out a miss or an L2 hit', async () => {
    const cache = track(timeEveryCall(createCache({ backend: BACKEND, metrics: false })));
    await cache.get('svc:absent'); // miss
    const other = track(timeEveryCall(createCache({ backend: BACKEND, metrics: false })));
    await other.set('svc:k', 1);
    await cache.get('svc:k'); // an L2 hit in `cache`, which backfills its L1
    expect(clockReads).toBe(2); // two starts, no stop
    expect((await nextReport(cache)).sum).toBeUndefined();
  });
});

describe('what is never timed (API-80)', () => {
  it('a wrap() call that joined another call for the same key', async () => {
    const cache = track(timeEveryCall(createCache({ backend: BACKEND, metrics: false })));
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const fn = cache.wrap(async (id: number) => {
      await gate;
      return { id };
    }, OPTIONS);
    const leader = fn(7);
    const joined = fn(7);
    finish();
    await Promise.all([leader, joined]);
    expect((await nextReport(cache)).sum).toBeUndefined();
    // The joined call counted its one L1 hit, and nothing was timed.
    expect(sent()['X-CacheKit-L1-Hits']).toBe('1');
  });

  it('an exists() check, which draws no clock at all', async () => {
    const cache = track(timeEveryCall(createCache({ backend: BACKEND, metrics: false })));
    await cache.set('svc:k', 1);
    expect(await cache.exists('svc:k')).toBe(true);
    expect(clockReads).toBe(0);
    expect((await nextReport(cache)).sum).toBeUndefined();
  });

  it('a read inside a wrap() call: an L1-served wrap() call is timed once, not twice', async () => {
    const cache = track(timeEveryCall(createCache({ backend: BACKEND, metrics: false })));
    const fn = cache.wrap(async (q: { id: number }) => q, OPTIONS);
    await fn({ id: 1 });
    clockReads = 0;
    await fn({ id: 1 });
    expect(clockReads).toBe(2);
  });
});

describe('sampling (API-81)', () => {
  it('times about 1 in N calls, by a draw independent of the key, never every Nth', async () => {
    const backend = cachekitio(BACKEND);
    (backend as { l1Latency?: L1LatencyReport }).l1Latency = new L1LatencyReport(4);
    const cache = track(createCache({ backend, metrics: false }));
    const fn = cache.wrap(async (id: number) => ({ id }), OPTIONS);
    await fn(1);
    await fn(2);
    const timed = { 1: 0, 2: 0 };
    const gaps = new Set<number>();
    let last = 0;
    const calls = 40_000;
    for (let i = 1; i <= calls; i++) {
      const key = (i % 2) + 1;
      const before = clockReads;
      await fn(key);
      if (clockReads - before === 2) {
        timed[key as 1 | 2]++;
        gaps.add(i - last);
        last = i;
      }
    }
    // Each key alternates with the other on every call: a counter would time
    // only one of them. Binomial(20,000, 1/4): mean 5,000, sd 61.
    expect(timed[1]).toBeGreaterThan(4_600);
    expect(timed[1]).toBeLessThan(5_400);
    expect(timed[2]).toBeGreaterThan(4_600);
    expect(timed[2]).toBeLessThan(5_400);
    expect(gaps.size).toBeGreaterThan(10);
  });

  it('draws before the outcome is known: a miss reads the clock too', async () => {
    const cache = track(timeEveryCall(createCache({ backend: BACKEND, metrics: false })));
    const fn = cache.wrap(async (id: number) => ({ id }), OPTIONS);
    await fn(7);
    expect(clockReads).toBe(1);
  });
});

describe('only the CachekitIO backend reports (API-77, API-82)', () => {
  it('a cache on any other backend never draws or reads the clock', async () => {
    const cache = track(createCache({ backend: new InMemoryBackend(), metrics: false }));
    const fn = cache.wrap(async (id: number) => ({ id }), OPTIONS);
    for (let i = 0; i < 5_000; i++) await fn(7);
    await cache.get(generateKey(OPTIONS.namespace, [7]));
    expect(clockReads).toBe(0);
  });

  it('with telemetry off, no call is timed and no latency header is sent', async () => {
    vi.stubEnv('CACHEKIT_TELEMETRY', 'off');
    const cache = track(createCache({ backend: BACKEND, metrics: false }));
    const fn = cache.wrap(async (id: number) => ({ id }), OPTIONS);
    for (let i = 0; i < 5_000; i++) await fn(7);
    expect(clockReads).toBe(0);
    const headers = sent();
    expect(headers['X-CacheKit-L1-Latency-Buckets']).toBeUndefined();
    expect(headers['X-CacheKit-Session-ID']).toBeUndefined();
  });

  it('createCache.io takes the telemetry setting', async () => {
    const cache = track(createCache.io({ apiKey: API_KEY, telemetry: false, metrics: false }));
    await cache.get('svc:k');
    expect(sent()['X-CacheKit-Session-ID']).toBeUndefined();
    expect(sent()['X-CacheKit-L1-Status']).toBe('miss');
  });

  it('times with the Node clock by default, one call in 1024', async () => {
    const cache = track(createCache({ backend: BACKEND, metrics: false }));
    const fn = cache.wrap(async (id: number) => ({ id }), OPTIONS);
    for (let i = 0; i < 20_000; i++) await fn(7);
    // Binomial(20,000, 1/1024): mean 19.5, sd 4.4. Each timed hit reads twice.
    expect(clockReads).toBeGreaterThan(2 * 3);
    expect(clockReads).toBeLessThan(2 * 45);
    const report = await nextReport(cache);
    expect(report.oneIn).toBe('1024');
    expect(Number(report.sum)).toBe(Number(STEP) * report.buckets!.reduce((a, b) => a + b, 0));
  });
});

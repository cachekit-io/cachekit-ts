import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshnessFromHeaders } from './cachekitio.js';
import {
  cachekitio,
  cachekitioFull,
  cachekitioWithLocking,
  cachekitioWithTTL,
} from './cachekitio-factory.js';
import type { Backend, CachekitIOBackendConfig, SetResult } from './types.js';
import { createCache } from '../cache.js';
import { CacheImpl } from '../cache-core.js';
import { generateKey } from '../serialization/key-generator.js';
import type { L1Cache } from '../l1/lru-cache.js';

// The L1 backfill honours X-CacheKit-Freshness and X-CacheKit-Fresh-For
// (protocol spec/saas-api.md § Remaining Freshness, § Reading a stale entry).

const config: CachekitIOBackendConfig = {
  apiKey: 'ck_test_fake-not-a-secret', // pragma: allowlist secret
  apiUrl: 'https://api.test.cachekit.io',
  allowCustomHost: true,
};

describe('freshnessFromHeaders', () => {
  const parse = (headers: Record<string, string>) => freshnessFromHeaders(new Headers(headers));

  it('treats absent headers as fresh with no bound', () => {
    expect(parse({})).toEqual({ isStale: false });
  });

  it('accepts exactly `fresh` and treats every other label as stale', () => {
    expect(parse({ 'X-CacheKit-Freshness': 'fresh' }).isStale).toBe(false);
    for (const label of ['stale', 'Fresh', 'FRESH', 'unknown', '', 'fresh, fresh']) {
      expect(parse({ 'X-CacheKit-Freshness': label }).isStale, label).toBe(true);
    }
  });

  it('parses 1-7 ASCII digits up to the 30-day cap', () => {
    expect(parse({ 'X-CacheKit-Fresh-For': '0' }).freshFor).toBe(0);
    expect(parse({ 'X-CacheKit-Fresh-For': '1' }).freshFor).toBe(1);
    expect(parse({ 'X-CacheKit-Fresh-For': '0000042' }).freshFor).toBe(42);
    expect(parse({ 'X-CacheKit-Fresh-For': '2592000' }).freshFor).toBe(2_592_000);
  });

  // The header's cap is its own grammar bound, not the 90-day TTL range.
  it('keeps the 2,592,000 cap below the TTL range', () => {
    expect(parse({ 'X-CacheKit-Fresh-For': '2592000' }).freshFor).toBe(2_592_000);
    expect(parse({ 'X-CacheKit-Fresh-For': '2592001' }).freshFor).toBe(0);
    expect(parse({ 'X-CacheKit-Fresh-For': '7776000' }).freshFor).toBe(0);
  });

  it('maps every malformed Fresh-For to 0', () => {
    for (const raw of [
      '',
      '-1',
      '+5',
      '1_0',
      '0x10',
      '1e3',
      '1.5',
      '12345678',
      '2592001',
      '4297559296',
      '²', // non-ASCII digit (Latin-1: Headers rejects wider code points)
      '5, 5', // repeated header
    ]) {
      expect(parse({ 'X-CacheKit-Fresh-For': raw }).freshFor, raw).toBe(0);
    }
  });
});

describe('CachekitIO L1 backfill bound', () => {
  /** In-memory stand-in for the server: PUT stores, GET replays with `headers`. */
  let store: Map<string, Uint8Array>;
  let headers: Record<string, string>;
  let gets: number;

  beforeEach(() => {
    store = new Map();
    headers = {};
    gets = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (init.method === 'PUT') {
          if (!(init.body instanceof Uint8Array)) throw new TypeError('PUT body must be bytes');
          store.set(url, init.body);
          return new Response(null, { status: 200 });
        }
        gets++;
        const body = store.get(url);
        return body
          ? new Response(body, { status: 200, headers })
          : new Response(null, { status: 404 });
      })
    );
    // Only Date: L1 expiry reads Date.now(), and nothing else needs faking.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A reader in a second process: its own empty L1 over the shared store. */
  async function seed(backend: () => Backend) {
    const writer = createCache({ backend: backend(), defaultTtl: 3600 });
    await writer.set('ns:k', 'v1', { ttl: 3600 });
    await writer.close();
    return createCache({ backend: backend(), defaultTtl: 3600 });
  }

  // Every factory wraps CachekitIOCore differently; each must forward getWithTtl.
  const factories = { cachekitio, cachekitioWithLocking, cachekitioWithTTL, cachekitioFull };

  for (const [name, factory] of Object.entries(factories)) {
    it(`never backfills a stale read (${name})`, async () => {
      const reader = await seed(() => factory(config));
      headers = { 'X-CacheKit-Freshness': 'stale', 'X-CacheKit-Fresh-For': '0' };

      expect(await reader.get('ns:k')).toBe('v1'); // stale bytes still reach the caller
      expect(await reader.get('ns:k')).toBe('v1');
      expect(gets).toBe(2); // both reads reached L2

      await reader.close();
    });
  }

  // Each shape fails differently: the label check, the unknown-label default, the 0 bound.
  it.each([
    [
      'stale with a positive Fresh-For',
      { 'X-CacheKit-Freshness': 'stale', 'X-CacheKit-Fresh-For': '600' },
    ],
    ['an unknown label', { 'X-CacheKit-Freshness': 'stale-ish' }],
    ['fresh with Fresh-For: 0', { 'X-CacheKit-Freshness': 'fresh', 'X-CacheKit-Fresh-For': '0' }],
  ])('never backfills %s', async (_name, sent) => {
    const reader = await seed(() => cachekitio(config));
    headers = sent;

    expect(await reader.get('ns:k')).toBe('v1');
    expect(await reader.get('ns:k')).toBe('v1');
    expect(gets).toBe(2);

    await reader.close();
  });

  it('caps the L1 copy at Fresh-For, not the 3600 s TTL', async () => {
    const reader = await seed(() => cachekitioFull(config));
    headers = { 'X-CacheKit-Freshness': 'fresh', 'X-CacheKit-Fresh-For': '1' };

    expect(await reader.get('ns:k')).toBe('v1');
    vi.advanceTimersByTime(900);
    expect(await reader.get('ns:k')).toBe('v1');
    expect(gets).toBe(1); // inside the bound: L1 hit

    vi.advanceTimersByTime(200);
    expect(await reader.get('ns:k')).toBe('v1');
    expect(gets).toBe(2); // past the bound: L1 copy gone, back to L2

    await reader.close();
  });

  it('holds the Fresh-For bound on the wrap() SWR path', async () => {
    const reader = createCache({ backend: cachekitioFull(config), defaultTtl: 3600 });
    const fn = vi.fn(async () => 'computed');
    const wrapped = reader.wrap(fn, { namespace: 'swr', ttl: 3600 });

    expect(await wrapped()).toBe('computed'); // miss: compute + PUT
    const fresh = createCache({ backend: cachekitioFull(config), defaultTtl: 3600 });
    const wrappedFresh = fresh.wrap(fn, { namespace: 'swr', ttl: 3600 });
    headers = { 'X-CacheKit-Freshness': 'fresh', 'X-CacheKit-Fresh-For': '1' };

    gets = 0;
    expect(await wrappedFresh()).toBe('computed'); // L2 hit, backfilled for 1 s
    expect(gets).toBe(1);

    vi.advanceTimersByTime(1_100);
    expect(await wrappedFresh()).toBe('computed');
    expect(gets).toBe(2); // getWithSwr did not serve the expired copy
    expect(fn).toHaveBeenCalledTimes(1);

    await reader.close();
    await fresh.close();
  });

  it('stops serving the L1 copy at exactly the bound', async () => {
    const reader = await seed(() => cachekitio(config));
    headers = { 'X-CacheKit-Freshness': 'fresh', 'X-CacheKit-Fresh-For': '1' };

    await reader.get('ns:k');
    vi.advanceTimersByTime(1_000);
    await reader.get('ns:k');
    expect(gets).toBe(2);

    await reader.close();
  });

  /** Make the next L2 decode take `ms` on the faked clock (a cold native load, a decrypt). */
  function slowNextDecode(ms: number) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = CacheImpl.prototype as any;
    const decode = proto.decodeEntry;
    vi.spyOn(proto, 'decodeEntry').mockImplementationOnce(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      vi.advanceTimersByTime(ms);
      return decode.apply(this, args);
    });
  }

  it('counts the bound from receipt, not from after a slow decode', async () => {
    const reader = await seed(() => cachekitio(config));
    headers = { 'X-CacheKit-Freshness': 'fresh', 'X-CacheKit-Fresh-For': '2' };
    slowNextDecode(1_500);

    expect(await reader.get('ns:k')).toBe('v1'); // received at 0, written to L1 at 1.5 s
    vi.advanceTimersByTime(400);
    await reader.get('ns:k');
    expect(gets).toBe(1); // 1.9 s after receipt: inside the bound

    vi.advanceTimersByTime(200);
    await reader.get('ns:k');
    expect(gets).toBe(2); // 2.1 s after receipt: past it, though only 0.6 s after the L1 write

    await reader.close();
  });

  it('never backfills when the decode outlasts the bound', async () => {
    const reader = await seed(() => cachekitio(config));
    headers = { 'X-CacheKit-Freshness': 'fresh', 'X-CacheKit-Fresh-For': '1' };
    slowNextDecode(1_500);

    expect(await reader.get('ns:k')).toBe('v1');
    await reader.get('ns:k');
    expect(gets).toBe(2);

    await reader.close();
  });

  it('keeps the declared lifetime when no freshness header is sent', async () => {
    const reader = await seed(() => cachekitio(config));

    expect(await reader.get('ns:k')).toBe('v1');
    vi.advanceTimersByTime(3_599_000);
    expect(await reader.get('ns:k')).toBe('v1');
    expect(gets).toBe(1); // L1 copy lives out defaultTtl, as before

    vi.advanceTimersByTime(2_000);
    await reader.get('ns:k');
    expect(gets).toBe(2);

    await reader.close();
  });
});

// The writer's own copy (protocol spec/saas-api.md § Remaining Freshness,
// API-103): the X-CacheKit-Fresh-For on the PUT 2xx caps the L1 copy of the
// value written, counted from receipt; absent leaves the TTL; malformed or 0
// keeps no copy. And a PATCH /ttl response never touches an L1 bound (API-104).
describe('CachekitIO writer L1 bound', () => {
  let store: Map<string, Uint8Array>;
  /** Headers on every PUT 2xx. */
  let putHeaders: Record<string, string>;
  let gets: number;
  let patches: number;

  beforeEach(() => {
    store = new Map();
    putHeaders = {};
    gets = 0;
    patches = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (init.method === 'PUT') {
          if (!(init.body instanceof Uint8Array)) throw new TypeError('PUT body must be bytes');
          store.set(url, init.body);
          return new Response(null, { status: 200, headers: putHeaders });
        }
        if (init.method === 'PATCH') {
          patches++;
          // A hostile or buggy hop's header on the PATCH: it must change nothing.
          return new Response(null, {
            status: 200,
            headers: { 'X-CacheKit-Fresh-For': '2592000' },
          });
        }
        gets++;
        const body = store.get(url);
        return body ? new Response(body, { status: 200 }) : new Response(null, { status: 404 });
      })
    );
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Every factory wraps CachekitIOCore differently; each must return set's result.
  const factories = { cachekitio, cachekitioWithLocking, cachekitioWithTTL, cachekitioFull };

  for (const [name, factory] of Object.entries(factories)) {
    it(`caps the L1 copy at a Fresh-For shorter than the TTL (${name})`, async () => {
      const cache = createCache({ backend: factory(config), defaultTtl: 3600 });
      putHeaders = { 'X-CacheKit-Fresh-For': '2' };
      await cache.set('ns:k', 'v1', { ttl: 3600 });

      vi.advanceTimersByTime(1_900);
      expect(await cache.get('ns:k')).toBe('v1');
      expect(gets).toBe(0); // inside the bound: L1 hit

      vi.advanceTimersByTime(100);
      expect(await cache.get('ns:k')).toBe('v1');
      expect(gets).toBe(1); // at the bound: the L1 copy is gone, back to L2

      await cache.close();
    });
  }

  it('keeps the TTL when the PUT carries no Fresh-For', async () => {
    const cache = createCache({ backend: cachekitio(config), defaultTtl: 3600 });
    await cache.set('ns:k', 'v1', { ttl: 3600 });

    vi.advanceTimersByTime(3_599_000);
    expect(await cache.get('ns:k')).toBe('v1');
    expect(gets).toBe(0);

    vi.advanceTimersByTime(1_000);
    await cache.get('ns:k');
    expect(gets).toBe(1);

    await cache.close();
  });

  it('never lets a Fresh-For longer than the TTL extend the copy', async () => {
    const cache = createCache({ backend: cachekitio(config), defaultTtl: 3600 });
    putHeaders = { 'X-CacheKit-Fresh-For': '2592000' };
    await cache.set('ns:k', 'v1', { ttl: 60 });

    vi.advanceTimersByTime(59_999);
    await cache.get('ns:k');
    expect(gets).toBe(0); // the copy was kept, for the TTL

    vi.advanceTimersByTime(1);
    await cache.get('ns:k');
    expect(gets).toBe(1);

    await cache.close();
  });

  it.each(['0', 'abc', '-1', '2592001', '12345678', ''])(
    'keeps no L1 copy when the PUT Fresh-For is %j',
    async (raw) => {
      const cache = createCache({ backend: cachekitio(config), defaultTtl: 3600 });
      await cache.set('ns:k', 'v0', { ttl: 3600 }); // an older copy the write must not leave behind
      putHeaders = { 'X-CacheKit-Fresh-For': raw };
      await cache.set('ns:k', 'v1', { ttl: 3600 });

      expect(await cache.get('ns:k')).toBe('v1');
      expect(gets).toBe(1);

      await cache.close();
    }
  );

  it('counts the bound from receipt of the 2xx, not from dispatch', async () => {
    const cache = createCache({ backend: cachekitio(config), defaultTtl: 3600 });
    putHeaders = { 'X-CacheKit-Fresh-For': '2' };
    // The PUT takes 1.5 s on the faked clock between dispatch and receipt.
    const fetchStub = vi.mocked(fetch);
    const inner = fetchStub.getMockImplementation()!;
    fetchStub.mockImplementationOnce(async (url, init) => {
      vi.advanceTimersByTime(1_500);
      return inner(url, init);
    });
    await cache.set('ns:k', 'v1', { ttl: 3600 });

    vi.advanceTimersByTime(1_900);
    await cache.get('ns:k');
    expect(gets).toBe(0); // 1.9 s after receipt (3.4 s after dispatch): inside the bound

    vi.advanceTimersByTime(100);
    await cache.get('ns:k');
    expect(gets).toBe(1);

    await cache.close();
  });

  it('holds the bound on the stale-window write (X-CacheKit-Stale-TTL never lengthens it)', async () => {
    const cache = createCache({ backend: cachekitioFull(config), defaultTtl: 3600 });
    putHeaders = { 'X-CacheKit-Fresh-For': '1' };
    const fn = vi.fn(async () => 'computed');
    const wrapped = cache.wrap(fn, { namespace: 'sg', ttl: 3600, staleTtl: 600 });

    expect(await wrapped()).toBe('computed'); // cold miss: GET 404, then the PUT
    expect(gets).toBe(1);
    expect(await wrapped()).toBe('computed');
    expect(gets).toBe(1); // L1 hit

    vi.advanceTimersByTime(1_000);
    expect(await wrapped()).toBe('computed');
    expect(gets).toBe(2); // past Fresh-For, though inside both TTL and stale window
    expect(fn).toHaveBeenCalledTimes(1);

    await cache.close();
  });

  it('caps a write-behind copy once its PUT lands', async () => {
    const cache = createCache({ backend: cachekitio(config), defaultTtl: 3600 });
    putHeaders = { 'X-CacheKit-Fresh-For': '1' };
    const wrapped = cache.wrap(async () => 'computed', {
      namespace: 'wb',
      ttl: 3600,
      writeBehind: true,
    });

    expect(await wrapped()).toBe('computed'); // L1 filled before the PUT is sent
    await vi.waitFor(() => expect(store.size).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the write settle
    expect(gets).toBe(1);

    vi.advanceTimersByTime(1_000);
    expect(await wrapped()).toBe('computed');
    expect(gets).toBe(2); // the copy was capped at the PUT's Fresh-For

    await cache.close();
  });

  it('measures SWR staleness of a capped write-behind copy against the cap, not the TTL', async () => {
    const cache = createCache({
      backend: cachekitio(config),
      defaultTtl: 3600,
      l1: { swrEnabled: true },
    });
    putHeaders = { 'X-CacheKit-Fresh-For': '60' };
    const fn = vi.fn(async () => 'computed');
    const wrapped = cache.wrap(fn, { namespace: 'wb', ttl: 3600, writeBehind: true });

    expect(await wrapped()).toBe('computed');
    await vi.waitFor(() => expect(store.size).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 60 s left of a 60 s bound is fresh; read against the 3600 s TTL it
    // would look stale and refresh the origin on every call.
    const l1 = (cache as unknown as { l1: L1Cache }).l1;
    const entry = l1.entry(generateKey('wb', [])) as unknown as { originalTtl: number };
    expect(entry.originalTtl).toBeLessThanOrEqual(60_000);
    expect(await wrapped()).toBe('computed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fn).toHaveBeenCalledTimes(1);

    await cache.close();
  });

  it('drops a write-behind copy when its PUT Fresh-For is 0', async () => {
    const cache = createCache({ backend: cachekitio(config), defaultTtl: 3600 });
    putHeaders = { 'X-CacheKit-Fresh-For': '0' };
    const wrapped = cache.wrap(async () => 'computed', {
      namespace: 'wb',
      ttl: 3600,
      writeBehind: true,
    });

    expect(await wrapped()).toBe('computed');
    await vi.waitFor(() => expect(store.size).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await wrapped()).toBe('computed');
    expect(gets).toBe(2);

    await cache.close();
  });

  describe('SWR refresh (L1 written only through completeRefresh)', () => {
    // swrThresholdRatio 2 makes every live L1 entry stale, so the second call refreshes.
    const swr = () =>
      createCache({
        backend: cachekitio(config),
        defaultTtl: 3600,
        l1: { swrEnabled: true, swrThresholdRatio: 2 },
      });

    it('caps the refreshed copy at the refresh PUT Fresh-For', async () => {
      const cache = swr();
      let gen = 0;
      const wrapped = cache.wrap(async () => ++gen, { namespace: 'swr', ttl: 3600 });
      const key = generateKey('swr', []);

      expect(await wrapped()).toBe(1);
      putHeaders = { 'X-CacheKit-Fresh-For': '1' };
      expect(await wrapped()).toBe(1); // stale hit: refresh scheduled
      await vi.waitFor(async () => expect(await cache.get(key)).toBe(2));
      expect(gets).toBe(1); // the cold miss only: gen 2 came from L1

      vi.advanceTimersByTime(1_000);
      expect(await cache.get(key)).toBe(2);
      expect(gets).toBe(2);

      await cache.close();
    });

    it('keeps neither copy when the refresh PUT Fresh-For is 0', async () => {
      const cache = swr();
      let gen = 0;
      const wrapped = cache.wrap(async () => ++gen, { namespace: 'swr', ttl: 3600 });
      const key = generateKey('swr', []);

      expect(await wrapped()).toBe(1);
      putHeaders = { 'X-CacheKit-Fresh-For': '0' };
      expect(await wrapped()).toBe(1);
      await vi.waitFor(() => expect(gen).toBe(2));
      await vi.waitFor(async () => {
        const before = gets;
        expect(await cache.get(key)).toBe(2); // read from L2: L1 holds neither generation
        expect(gets).toBe(before + 1);
      });

      await cache.close();
    });
  });

  it('a PATCH /ttl response never creates, refreshes or extends an L1 bound (API-104)', async () => {
    const backend = cachekitioFull(config);
    const cache = createCache({ backend, defaultTtl: 3600 });
    putHeaders = { 'X-CacheKit-Fresh-For': '2' };
    await cache.set('ns:k', 'v1', { ttl: 3600 });

    vi.advanceTimersByTime(1_000);
    expect(await backend.refreshTTL('ns:k', 7_776_000)).toBe(true);
    expect(patches).toBe(1);

    vi.advanceTimersByTime(1_000);
    await cache.get('ns:k');
    expect(gets).toBe(1); // still expired at the PUT's bound

    // Nor does a PATCH of a key L1 does not hold create a copy.
    expect(await backend.refreshTTL('ns:other', 3600)).toBe(true);
    expect(await cache.get('ns:other')).toBeNull();
    expect(gets).toBe(2);

    await cache.close();
  });
});

describe('a custom backend reporting a bound', () => {
  /** In-memory backend whose set resolves to `result`. */
  class ReportingBackend implements Backend {
    store = new Map<string, Uint8Array>();
    gets = 0;
    constructor(private readonly result: unknown) {}
    async get(key: string) {
      this.gets++;
      return this.store.get(key) ?? null;
    }
    async set(key: string, value: Uint8Array) {
      this.store.set(key, value);
      return this.result as SetResult;
    }
    async delete(key: string) {
      return this.store.delete(key);
    }
    async exists(key: string) {
      return this.store.has(key);
    }
    async close() {}
  }

  it.each([NaN, -1, '60'])(
    'keeps no L1 copy for a freshFor of %j (fails closed)',
    async (freshFor) => {
      const backend = new ReportingBackend({ freshFor });
      const cache = createCache({ backend, defaultTtl: 3600 });
      await cache.set('ns:k', 'v1');

      expect(await cache.get('ns:k')).toBe('v1');
      expect(backend.gets).toBe(1);

      await cache.close();
    }
  );

  it('keeps the TTL for a backend that resolves to nothing', async () => {
    const backend = new ReportingBackend(undefined);
    const cache = createCache({ backend, defaultTtl: 3600 });
    await cache.set('ns:k', 'v1');

    expect(await cache.get('ns:k')).toBe('v1');
    expect(backend.gets).toBe(0);

    await cache.close();
  });
});

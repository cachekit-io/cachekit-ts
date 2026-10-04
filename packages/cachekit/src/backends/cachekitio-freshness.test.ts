import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshnessFromHeaders } from './cachekitio.js';
import {
  cachekitio,
  cachekitioFull,
  cachekitioWithLocking,
  cachekitioWithTTL,
} from './cachekitio-factory.js';
import type { Backend, CachekitIOBackendConfig } from './types.js';
import { createCache } from '../cache.js';
import { CacheImpl } from '../cache-core.js';

// LAB-7883: the L1 backfill honours X-CacheKit-Freshness and X-CacheKit-Fresh-For
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
          store.set(url, init.body as Uint8Array);
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

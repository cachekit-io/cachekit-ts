import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CacheAPIBackend, workersCacheAPI, type CacheLike } from './workers-cache-api.js';

/**
 * Node-lane unit tests for the Cache API backend's header math and
 * advertised defaults (LAB-1388). The real-workerd behavior (actual
 * caches.default storage) is covered by test/workers/edge-backends —
 * these tests pin the freshness arithmetic getWithTtl derives from the
 * stored response's Cache-Control/Age headers, which workerd's local
 * cache emulation cannot exercise (it never reports Age).
 */
class FakeCache implements CacheLike {
  readonly store = new Map<string, Response>();

  async match(url: string): Promise<Response | undefined> {
    // Clone so repeated matches can each consume their body, like the real
    // Cache API.
    return this.store.get(url)?.clone();
  }

  async put(url: string, response: Response): Promise<void> {
    this.store.set(url, response);
  }

  async delete(url: string): Promise<boolean> {
    return this.store.delete(url);
  }
}

describe('CacheAPIBackend (unit, mocked caches global)', () => {
  let fake: FakeCache;

  beforeEach(() => {
    fake = new FakeCache();
    (globalThis as { caches?: unknown }).caches = { default: fake };
  });

  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches;
  });

  const value = new Uint8Array([1, 2, 3, 4]);

  it('advertises compression off (Cloudflare compresses response bodies at rest)', () => {
    expect(new CacheAPIBackend().compressionDefault).toBe(false);
  });

  it('getWithTtl returns null on miss', async () => {
    expect(await workersCacheAPI().getWithTtl('ns:missing')).toBeNull();
  });

  it('getWithTtl reports the stored max-age when the edge reports no Age', async () => {
    const backend = workersCacheAPI();
    await backend.set('ns:key', value, 30);

    const result = await backend.getWithTtl('ns:key');
    expect(result).not.toBeNull();
    expect(Array.from(result!.value)).toEqual([1, 2, 3, 4]);
    expect(result!.ttlSeconds).toBe(30);
  });

  it('getWithTtl subtracts the Age header from max-age', async () => {
    const backend = workersCacheAPI();
    await backend.set('ns:key', value, 30);

    // Simulate the Cloudflare edge reporting the entry's age on match.
    const [url, stored] = [...fake.store.entries()][0];
    const headers = new Headers(stored.headers);
    headers.set('Age', '29');
    fake.store.set(url, new Response(value, { headers }));

    const result = await backend.getWithTtl('ns:key');
    expect(result!.ttlSeconds).toBe(1);
  });

  it('getWithTtl floors remaining freshness at zero when Age >= max-age', async () => {
    const backend = workersCacheAPI();
    await backend.set('ns:key', value, 30);

    const [url, stored] = [...fake.store.entries()][0];
    const headers = new Headers(stored.headers);
    headers.set('Age', '45');
    fake.store.set(url, new Response(value, { headers }));

    const result = await backend.getWithTtl('ns:key');
    expect(result!.ttlSeconds).toBe(0);
  });

  it('getWithTtl reports null (no expiry) for ttl <= 0 via the marker header', async () => {
    const backend = workersCacheAPI();
    await backend.set('ns:key', value, 0); // ttl <= 0 → marker header + 1-year max-age

    const result = await backend.getWithTtl('ns:key');
    expect(result!.ttlSeconds).toBeNull();
  });

  it('getWithTtl treats a legitimate exactly-one-year TTL as a real TTL, not the sentinel', async () => {
    const backend = workersCacheAPI();
    await backend.set('ns:key', value, 31_536_000); // same max-age as the sentinel, no marker

    const result = await backend.getWithTtl('ns:key');
    expect(result!.ttlSeconds).toBe(31_536_000);
  });

  it('getWithTtl reports null when freshness headers are absent', async () => {
    const backend = workersCacheAPI();
    await backend.set('ns:key', value, 30);

    const [url] = [...fake.store.keys()];
    fake.store.set(url, new Response(value)); // no Cache-Control at all

    const result = await backend.getWithTtl('ns:key');
    expect(result!.ttlSeconds).toBeNull();
  });

  it('getWithTtl ignores a malformed Age header', async () => {
    const backend = workersCacheAPI();
    await backend.set('ns:key', value, 30);

    const [url, stored] = [...fake.store.entries()][0];
    const headers = new Headers(stored.headers);
    headers.set('Age', 'bogus');
    fake.store.set(url, new Response(value, { headers }));

    const result = await backend.getWithTtl('ns:key');
    expect(result!.ttlSeconds).toBe(30);
  });

  it('get() round-trips unchanged (regression)', async () => {
    const backend = workersCacheAPI();
    await backend.set('ns:key', value, 30);
    expect(Array.from((await backend.get('ns:key'))!)).toEqual([1, 2, 3, 4]);
  });
});

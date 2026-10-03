/**
 * What L1 charges a plaintext entry against maxMemory, through createCache on
 * every path that fills L1: set, an L2 hit, and the SWR refresh, in auto and
 * interop mode. Each charge must count the value's containers, which the
 * codec counts on its own walk, so a value of many empty objects is not
 * charged as the handful of bytes it serializes to.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCache } from './cache.js';
import { L1Cache } from './l1/lru-cache.js';
import { defaultSerializer } from './serialization/serializer.js';
import { encodeInteropValue } from './serialization/interop.js';
import type { SecureCache } from './types/cache.js';
import type { Backend } from './backends/types.js';

const MASTER_KEY = createHash('sha256').update('cachekit l1 charge test fixture').digest('hex');

class InMemoryBackend implements Backend {
  store = new Map<string, Uint8Array>();
  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: Uint8Array): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async close(): Promise<void> {}
}

const memoryUsed = (cache: SecureCache): number =>
  (cache as unknown as { l1: L1Cache }).l1.stats.memoryUsed;

/** 2,001 containers in 2,003 bytes of MessagePack. */
const containerHeavy = () => Array.from({ length: 2000 }, () => ({}));

/** The charge for one entry, from the serialized length and the container count. */
function chargeFor(value: unknown, interop = false): number {
  const count = { containers: 0 };
  const bytes = interop ? encodeInteropValue(value, count) : defaultSerializer.encode(value, count);
  // A container-heavy value must count, or these tests prove nothing.
  expect(count.containers).toBeGreaterThan(bytes.length / 2);
  const l1 = new L1Cache();
  l1.set('k', value, 0, 'ns', bytes.length, count.containers);
  expect(l1.stats.memoryUsed).toBeGreaterThan(bytes.length * 2.5);
  return l1.stats.memoryUsed;
}

describe('L1 charge for container-heavy values', () => {
  const caches: SecureCache[] = [];
  function makeCache(backend: Backend, encrypted = false): SecureCache {
    const cache = createCache({
      backend,
      defaultTtl: 3600,
      l1: { enabled: true },
      ...(encrypted ? { encryption: { masterKey: MASTER_KEY, tenantId: 'charge' } } : {}),
    });
    caches.push(cache);
    return cache;
  }

  afterEach(async () => {
    await Promise.all(caches.splice(0).map((c) => c.close()));
  });

  it('set() charges the containers', async () => {
    const cache = makeCache(new InMemoryBackend());
    await cache.set('users:1', containerHeavy());
    expect(memoryUsed(cache)).toBe(chargeFor(containerHeavy()));
  });

  it('an L2 hit charges the containers it decoded', async () => {
    const backend = new InMemoryBackend();
    await makeCache(backend).set('users:1', containerHeavy());

    const reader = makeCache(backend);
    expect(await reader.get('users:1')).toEqual(containerHeavy());
    expect(memoryUsed(reader)).toBe(chargeFor(containerHeavy()));
  });

  it('interop writes and L2 hits charge the containers', async () => {
    const backend = new InMemoryBackend();
    const options = { namespace: 'users', interop: 'list', interopArity: 1, ttl: 300 };
    const writer = makeCache(backend);
    await writer.wrap(async (_id: number) => containerHeavy(), options)(1);
    expect(memoryUsed(writer)).toBe(chargeFor(containerHeavy(), true));

    const reader = makeCache(backend);
    const load = reader.wrap(async (_id: number): Promise<object[]> => [], options);
    expect(await load(1)).toEqual(containerHeavy());
    expect(memoryUsed(reader)).toBe(chargeFor(containerHeavy(), true));
  });

  it('the SWR refresh charges the containers', async () => {
    const cache = makeCache(new InMemoryBackend());
    let generation = 0;
    // 2s TTL, read at 1.4s: stale for every jitter draw, not yet expired
    // (the same timing as the LAB-238 SWR test).
    const load = cache.wrap(
      async (_id: number) => ({ generation: ++generation, items: containerHeavy() }),
      { namespace: 'users', ttl: 2 }
    );
    await load(1);
    // Charged on set first; the refresh below must keep charging the count.
    expect(memoryUsed(cache)).toBe(chargeFor({ generation: 1, items: containerHeavy() }));

    await new Promise((r) => setTimeout(r, 1400));
    expect((await load(1)).generation).toBe(1); // stale hit, refresh scheduled
    await vi.waitFor(async () => expect(generation).toBe(2));
    await vi.waitFor(async () => expect((await load(1)).generation).toBe(2));

    expect(memoryUsed(cache)).toBe(chargeFor({ generation: 2, items: containerHeavy() }));
  });

  it('a secure cache is still charged its ciphertext length', async () => {
    const backend = new InMemoryBackend();
    const cache = makeCache(backend, true);
    await cache.set('users:1', containerHeavy());
    expect(memoryUsed(cache)).toBe(backend.store.get('users:1')!.byteLength);

    const reader = makeCache(backend, true);
    await reader.get('users:1');
    expect(memoryUsed(reader)).toBe(backend.store.get('users:1')!.byteLength);
  });
});

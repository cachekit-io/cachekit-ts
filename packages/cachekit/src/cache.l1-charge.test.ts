/**
 * What L1 charges a plaintext entry against maxMemory, through createCache on
 * every path that fills L1: set, an L2 hit, and the SWR refresh, in auto and
 * interop mode. Each charge must count the value's heap objects (arrays,
 * maps, bins) and values (their elements and entries), which the codec counts
 * on its own walk, so a value of many empty objects or small scalars is not
 * charged as the handful of bytes it serializes to.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCache } from './cache.js';
import { L1Cache } from './l1/lru-cache.js';
import { encodeCounted, resolveSerializerConfig } from './serialization/serializer.js';
import { encodeInteropValueCounted } from './serialization/interop.js';
import type { SecureCache } from './types/cache.js';
import type { Backend } from './backends/types.js';
import { InMemoryBackend } from '../test/fixtures/metrics.js';

const MASTER_KEY = createHash('sha256').update('cachekit l1 charge test fixture').digest('hex');

const memoryUsed = (cache: SecureCache): number =>
  (cache as unknown as { l1: L1Cache }).l1.stats.memoryUsed;

/** 2,001 heap objects in 2,003 bytes of MessagePack. */
const containerHeavy = () => Array.from({ length: 2000 }, () => ({}));

/** 10,000 slots in 10,003 bytes of MessagePack. */
const scalarHeavy = () => new Array<number>(10_000).fill(0);

/** The charge for one entry, from the serialized length and the counts. */
function chargeFor(value: unknown, interop = false): number {
  const count = { objects: 0, values: 0 };
  const bytes = interop
    ? encodeInteropValueCounted(value, count)
    : encodeCounted(value, resolveSerializerConfig(), count);
  // An object- or value-heavy value must count, or these tests prove nothing.
  expect(count.objects + count.values).toBeGreaterThan(bytes.length / 3);
  const l1 = new L1Cache();
  l1.set('k', value, 0, 'ns', bytes.length, count);
  expect(l1.stats.memoryUsed).toBeGreaterThan(bytes.length * 2.5);
  return l1.stats.memoryUsed;
}

describe('L1 charge for object-heavy values', () => {
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
    vi.useRealTimers();
    await Promise.all(caches.splice(0).map((c) => c.close()));
  });

  it('set() charges the objects', async () => {
    const cache = makeCache(new InMemoryBackend());
    await cache.set('users:1', containerHeavy());
    expect(memoryUsed(cache)).toBe(chargeFor(containerHeavy()));
  });

  it('an L2 hit charges the objects it decoded', async () => {
    const backend = new InMemoryBackend();
    await makeCache(backend).set('users:1', containerHeavy());

    const reader = makeCache(backend);
    expect(await reader.get('users:1')).toEqual(containerHeavy());
    expect(memoryUsed(reader)).toBe(chargeFor(containerHeavy()));
  });

  it('interop writes and L2 hits charge the objects', async () => {
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

  it('the SWR refresh charges the objects', async () => {
    vi.useFakeTimers();
    const cache = makeCache(new InMemoryBackend());
    let generation = 0;
    // 2s TTL, read at 1.4s: stale for every jitter draw, not yet expired
    // (the same timing as the encrypted-L1 SWR test).
    const load = cache.wrap(
      async (_id: number) => ({ generation: ++generation, items: containerHeavy() }),
      { namespace: 'users', ttl: 2 }
    );
    await load(1);
    // Charged on set first; the refresh below must keep charging the count.
    expect(memoryUsed(cache)).toBe(chargeFor({ generation: 1, items: containerHeavy() }));

    await vi.advanceTimersByTimeAsync(1400);
    expect((await load(1)).generation).toBe(1); // stale hit, refresh scheduled
    await vi.waitFor(async () => expect(generation).toBe(2));
    await vi.waitFor(async () => expect((await load(1)).generation).toBe(2));

    expect(memoryUsed(cache)).toBe(chargeFor({ generation: 2, items: containerHeavy() }));
  });

  it('set() and an L2 hit charge each small scalar', async () => {
    const backend = new InMemoryBackend();
    const writer = makeCache(backend);
    await writer.set('users:1', scalarHeavy());
    expect(memoryUsed(writer)).toBe(chargeFor(scalarHeavy()));

    const reader = makeCache(backend);
    expect(await reader.get('users:1')).toEqual(scalarHeavy());
    expect(memoryUsed(reader)).toBe(chargeFor(scalarHeavy()));
  });

  it('an L2 hit charges the bin values it decoded', async () => {
    const binHeavy = () => Array.from({ length: 2000 }, () => new Uint8Array(0));
    const backend = new InMemoryBackend();
    await makeCache(backend).set('users:1', binHeavy());

    const reader = makeCache(backend);
    expect(await reader.get('users:1')).toEqual(binHeavy());
    expect(memoryUsed(reader)).toBe(chargeFor(binHeavy()));
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

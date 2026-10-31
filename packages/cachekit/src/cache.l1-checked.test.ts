/**
 * An encrypted L1 hit on an entry this cache checked skips the decode's depth
 * walks; every byte read from L2, and any bytes that reach L1 another way,
 * are still walked.
 *
 * L1 holds ciphertext, so a hit decrypts, unpacks and decodes. The depth
 * pre-scan and the post-decode walk defend the decode against a hostile
 * document. An entry L1 got from getEntry (after a walked decode) or from
 * setEntry (this process's own encoder) already passed them, and decrypt
 * re-authenticates it on every hit, so its hits decode through decodeChecked.
 *
 * The decode functions are wrapped in call-through spies, so these tests see
 * which decode ran; the crypto path is the real one.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createCache } from './cache.js';
import { generateKey } from './serialization/key-generator.js';
import { generateInteropKey } from './serialization/interop.js';
import { decodeChecked, decodeCounted } from './serialization/serializer.js';
import { decodeInteropValueChecked, decodeInteropValueCounted } from './serialization/interop.js';
import { SerializationError } from './errors.js';
import type { SecureCache } from './types/cache.js';
import type { Backend } from './backends/types.js';
import type { L1Cache } from './l1/lru-cache.js';

vi.mock('./serialization/serializer.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./serialization/serializer.js')>();
  return {
    ...mod,
    decodeCounted: vi.fn(mod.decodeCounted),
    decodeChecked: vi.fn(mod.decodeChecked),
  };
});
vi.mock('./serialization/interop.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./serialization/interop.js')>();
  return {
    ...mod,
    decodeInteropValueCounted: vi.fn(mod.decodeInteropValueCounted),
    decodeInteropValueChecked: vi.fn(mod.decodeInteropValueChecked),
  };
});

const MASTER_KEY = createHash('sha256').update('cachekit L1-checked test fixture').digest('hex');
const TENANT = 'l1-checked';

class InMemoryBackend implements Backend {
  store = new Map<string, Uint8Array>();
  gets = 0;

  async get(key: string): Promise<Uint8Array | null> {
    this.gets++;
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

function l1Of(cache: SecureCache): L1Cache {
  return (cache as unknown as { l1: L1Cache }).l1;
}

/** `levels` arrays nested in each other around a 1. */
function nested(levels: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < levels; i++) v = [v];
  return v;
}

/** Calls of each decode since the last reset. */
function decodes() {
  return {
    walked: vi.mocked(decodeCounted).mock.calls.length,
    checked: vi.mocked(decodeChecked).mock.calls.length,
    interopWalked: vi.mocked(decodeInteropValueCounted).mock.calls.length,
    interopChecked: vi.mocked(decodeInteropValueChecked).mock.calls.length,
  };
}

const NONE = { walked: 0, checked: 0, interopWalked: 0, interopChecked: 0 };

describe('encrypted L1 hits on checked entries', () => {
  const caches: SecureCache[] = [];

  function makeCache(
    backend: Backend,
    options: { maxDepth?: number; degradation?: boolean; compression?: boolean } = {}
  ): SecureCache {
    const cache = createCache({
      backend,
      defaultTtl: 3600,
      l1: { enabled: true, maxEntries: 100 },
      encryption: { masterKey: MASTER_KEY, tenantId: TENANT },
      ...(options.maxDepth !== undefined ? { serializer: { maxDepth: options.maxDepth } } : {}),
      ...(options.degradation !== undefined
        ? { reliability: { degradation: options.degradation } }
        : {}),
      ...(options.compression !== undefined ? { compression: options.compression } : {}),
    });
    caches.push(cache);
    return cache;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(caches.splice(0).map((c) => c.close()));
  });

  it('a hit on an entry set() stored decodes without the walks', async () => {
    const backend = new InMemoryBackend();
    const cache = makeCache(backend);
    await cache.set('users:1', { name: 'ada', tags: [[1, 2], [3]] });
    vi.clearAllMocks();

    expect(await cache.get('users:1')).toEqual({ name: 'ada', tags: [[1, 2], [3]] });
    expect(await cache.get('users:1')).toEqual({ name: 'ada', tags: [[1, 2], [3]] });

    expect(decodes()).toEqual({ ...NONE, checked: 2 });
    expect(backend.gets).toBe(0);
  });

  it('an L2 read is walked, and the hits on the entry it stored are not', async () => {
    const backend = new InMemoryBackend();
    await makeCache(backend).set('users:2', { id: 2 });
    const reader = makeCache(backend);
    vi.clearAllMocks();

    expect(await reader.get('users:2')).toEqual({ id: 2 });
    expect(decodes()).toEqual({ ...NONE, walked: 1 });

    expect(await reader.get('users:2')).toEqual({ id: 2 });
    expect(decodes()).toEqual({ ...NONE, walked: 1, checked: 1 });
    expect(backend.gets).toBe(1);
  });

  it('a hit on the entry an SWR refresh stored decodes without the walks', async () => {
    vi.useFakeTimers();
    const backend = new InMemoryBackend();
    const cache = makeCache(backend);
    let generation = 0;
    // 2 s TTL read at 1.4 s: stale for every jitter draw (see the SWR test
    // in cache.encryption-l1.test.ts).
    const load = cache.wrap(async (_id: number) => ({ generation: ++generation }), {
      namespace: 'users',
      ttl: 2,
    });
    await load(3);
    const key = generateKey('users', [3]);
    const first = l1Of(cache).get(key);

    await vi.advanceTimersByTimeAsync(1400);
    expect(await load(3)).toEqual({ generation: 1 });
    await vi.waitFor(() => {
      const entry = l1Of(cache).get(key);
      expect(entry).toBeInstanceOf(Uint8Array);
      expect(entry).not.toBe(first);
    });
    vi.clearAllMocks();

    expect(await load(3)).toEqual({ generation: 2 });
    expect(decodes()).toEqual({ ...NONE, checked: 1 });
  });

  it('bytes put in L1 another way are walked on every hit', async () => {
    const backend = new InMemoryBackend();
    const cache = makeCache(backend);
    await cache.set('users:4', { id: 4 });
    // A valid ciphertext for this key, but not the object this cache stored.
    const copy = new Uint8Array(backend.store.get('users:4')!);
    l1Of(cache).set('users:4', copy, 3600_000, 'users');
    vi.clearAllMocks();

    expect(await cache.get('users:4')).toEqual({ id: 4 });
    expect(await cache.get('users:4')).toEqual({ id: 4 });

    expect(decodes()).toEqual({ ...NONE, walked: 2 });
    expect(backend.gets).toBe(0);
  });

  describe('a hostile document', () => {
    // A writer holding the same key with a looser depth bound stores a
    // document 150 levels deep; the reader's bound is the default 100.
    async function hostileCiphertext(backend: InMemoryBackend, key: string): Promise<Uint8Array> {
      const writer = makeCache(backend, { maxDepth: 1024 });
      await writer.set(key, nested(150));
      return backend.store.get(key)!;
    }

    it('from L2 is still rejected, though this cache once checked the key', async () => {
      const backend = new InMemoryBackend();
      const reader = makeCache(backend, { degradation: false });
      await reader.set('users:5', { id: 5 });
      await hostileCiphertext(backend, 'users:5');
      // The checked entry leaves L1 (expiry, eviction or an invalidation).
      l1Of(reader).invalidateByKey('users:5');
      vi.clearAllMocks();

      await expect(reader.get('users:5')).rejects.toThrow(SerializationError);
      await expect(reader.get('users:5')).rejects.toThrow(/max depth of 100/i);
      expect(decodes()).toEqual({ ...NONE, walked: 2 });
      expect(l1Of(reader).get('users:5')).toBeNull();
    });

    it('from L2 reads as a miss with degradation on, and never reaches L1', async () => {
      const backend = new InMemoryBackend();
      await hostileCiphertext(backend, 'users:6');
      const reader = makeCache(backend);
      vi.clearAllMocks();

      expect(await reader.get('users:6')).toBeNull();
      expect(decodes()).toEqual({ ...NONE, walked: 1 });
      expect(l1Of(reader).get('users:6')).toBeNull();
    });

    it('put in L1 is walked and refused, and L2 serves', async () => {
      const backend = new InMemoryBackend();
      const reader = makeCache(backend);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const hostile = await hostileCiphertext(backend, 'users:7');
        await reader.set('users:7', { id: 7 });
        l1Of(reader).set('users:7', hostile, 3600_000, 'users');
        vi.clearAllMocks();

        expect(await reader.get('users:7')).toEqual({ id: 7 });
        // The L1 entry's walk refused it; the L2 read was walked too.
        expect(decodes()).toEqual({ ...NONE, walked: 2 });
        expect(consoleSpy).toHaveBeenCalledWith(
          '[cachekit] L1 decrypt failed — entry dropped:',
          expect.stringMatching(/max depth of 100/i)
        );
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  it('an interop wrap() hit decodes without the pre-scan', async () => {
    const backend = new InMemoryBackend();
    const cache = makeCache(backend);
    const getUser = cache.wrap(async (id: number) => ({ id, at: new Date(0) }), {
      namespace: 'users',
      interop: 'get_user',
      interopArity: 1,
      ttl: 300,
    });
    await getUser(8);
    vi.clearAllMocks();

    expect(await getUser(8)).toEqual({ id: 8, at: new Date(0) });
    expect(decodes()).toEqual({ ...NONE, interopChecked: 1 });
  });

  it('an entry checked in the other mode is walked', async () => {
    // Compression off: an interop entry and a plain get() of its key share
    // the AAD's compressed flag, so the ciphertext decrypts under either.
    const backend = new InMemoryBackend();
    const cache = makeCache(backend, { compression: false });
    const getUser = cache.wrap(async (id: number) => ({ id }), {
      namespace: 'users',
      interop: 'get_user',
      interopArity: 1,
      ttl: 300,
    });
    await getUser(9);
    vi.clearAllMocks();

    expect(await cache.get(generateInteropKey('users', 'get_user', [9]))).toEqual({ id: 9 });
    expect(decodes()).toEqual({ ...NONE, walked: 1 });
  });
});

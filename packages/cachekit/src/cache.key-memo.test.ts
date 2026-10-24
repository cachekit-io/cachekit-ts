/**
 * wrap() remembers the key of each call whose arguments are all primitives
 * (see AutoKeys), so a repeat L1 hit skips key generation. Through the public
 * API: the keys that reach L1 and the backend stay the keys generateKey gives;
 * a cache that encrypts, a cache without L1 and a call that skips L1 keep no
 * memo; and every removal on request empties every memo of the cache.
 */

import { createHash } from 'node:crypto';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Encoder } from '@msgpack/msgpack';
import { createCache } from './cache.js';
import { CacheImpl, type CacheRuntime, type InvalidationChannelLike } from './cache-core.js';
import { L1Cache } from './l1/lru-cache.js';
import { AutoKeys } from './serialization/auto-keys.js';
import { generateKey } from './serialization/key-generator.js';
import { ByteStorage } from '@cachekit-io/cachekit-core-ts';
import { EncryptionManager } from './encryption/manager.js';
import { createInvalidationEvent } from './invalidation/event.js';
import type { InvalidationEvent } from './l1/types.js';
import type { CacheOptions, SecureCache } from './types/cache.js';
import { InMemoryBackend } from '../test/fixtures/metrics.js';
import {
  FULL_PATH_KEYS,
  MEMOISABLE_KEYS,
  PINNED_NAMESPACE,
} from '../test/fixtures/auto-mode-keys.js';

// Derived at runtime from a public fixture string, not a key literal.
const MASTER_KEY = createHash('sha256').update('cachekit key-memo test fixture').digest('hex');

let encodes: ReturnType<typeof vi.spyOn>;
let lookups: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  encodes = vi.spyOn(Encoder.prototype, 'encodeSharedRef');
  lookups = vi.spyOn(L1Cache.prototype, 'getWithSwr');
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** MessagePack encodes during `call`: a key generation, or a value written. */
const encodesDuring = async (call: () => Promise<unknown>): Promise<number> => {
  const before = encodes.mock.calls.length;
  await call();
  return encodes.mock.calls.length - before;
};

const lastL1Key = (): unknown => lookups.mock.calls.at(-1)?.[0];

/** A cache whose invalidation channel the test drives by hand. */
function cacheWithChannel(options: Omit<CacheOptions, 'backend'> = {}) {
  let deliver: (event: InvalidationEvent) => void = () => {
    throw new Error('the cache never subscribed');
  };
  const channel: InvalidationChannelLike = {
    publish: () => {},
    subscribe: (callback) => {
      deliver = callback;
    },
    start: async () => {},
    stop: async () => {},
  };
  const runtime: CacheRuntime = {
    resolveBackend: () => new InMemoryBackend(),
    createByteStorage: () => new ByteStorage(),
    createEncryption: (config) => new EncryptionManager(config.masterKey, config.tenantId),
    createInvalidationChannel: () => channel,
  };
  const cache = new CacheImpl(
    { backend: new InMemoryBackend(), invalidation: { redis: {} as never }, ...options },
    runtime
  );
  return { cache, deliver: (event: InvalidationEvent) => deliver(event) };
}

describe('wrap() key memo', () => {
  it('serves a repeat L1 hit on primitive arguments without generating its key', async () => {
    const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
    const fn = cache.wrap(async (id: number, kind: string) => ({ id, kind }), {
      namespace: 'svc:getThing',
      ttl: 60,
    });
    expect(await encodesDuring(() => fn(7, 'a'))).toBeGreaterThan(0);
    expect(await encodesDuring(() => fn(7, 'a'))).toBe(0);
    expect(lastL1Key()).toBe(generateKey('svc:getThing', [7, 'a']));
    await cache.close();
  });

  it('looks up and stores the pinned key of every corpus call, first and repeat', async () => {
    const backend = new InMemoryBackend();
    const writes = vi.spyOn(backend, 'set');
    const cache = createCache({ backend, metrics: false });
    // One wrapped function, so one memo, for the whole corpus.
    const fn = cache.wrap(async (...args: unknown[]) => ({ n: args.length }), {
      namespace: PINNED_NAMESPACE,
      ttl: 60,
    });
    const corpus = [...MEMOISABLE_KEYS, ...FULL_PATH_KEYS];
    for (const { name, args, key } of corpus) {
      await fn(...args);
      expect(lastL1Key(), name).toBe(key);
    }
    // Calls with equal keys (0 and -0, null and undefined) share one write.
    expect(new Set(writes.mock.calls.map((c) => c[0]))).toEqual(new Set(corpus.map((c) => c.key)));
    for (const { name, args, key } of corpus) {
      await fn(...args);
      expect(lastL1Key(), name).toBe(key);
    }
    await cache.close();
  });

  const OPTIONS = { namespace: 'svc:getThing', ttl: 60 };
  const encrypting = () =>
    createCache({ backend: new InMemoryBackend(), encryption: { masterKey: MASTER_KEY } });
  it.each<[string, () => SecureCache, (cache: SecureCache) => (id: number) => Promise<unknown>]>([
    [
      'secure.wrap',
      encrypting,
      (cache) => cache.secure.wrap(async (id: number) => ({ id }), OPTIONS),
    ],
    [
      'wrap on a cache that encrypts',
      encrypting,
      (cache) => cache.wrap(async (id: number) => ({ id }), OPTIONS),
    ],
    [
      'wrap on a cache without L1',
      () => createCache({ backend: new InMemoryBackend(), l1: { enabled: false } }),
      (cache) => cache.wrap(async (id: number) => ({ id }), OPTIONS),
    ],
  ])('keeps no memo: %s', async (_, build, wrapped) => {
    const cache = build();
    const memos = vi.spyOn(AutoKeys.prototype, 'key');
    const fn = wrapped(cache);
    await fn(7);
    await fn(7);
    const [memo] = memos.mock.contexts;
    if (!(memo instanceof AutoKeys)) throw new Error('wrap() did not key through AutoKeys');
    expect(memo.memoising).toBe(false);
    // Each call keys in full: the third, an L1 or L2 hit, still encodes.
    expect(await encodesDuring(() => fn(7))).toBeGreaterThan(0);
    await cache.close();
  });

  describe('on a closed cache', () => {
    const OPTIONS = { namespace: 'svc:getThing', ttl: 60 };

    it('rejects a call before keying it', async () => {
      const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
      const fn = cache.wrap(async (id: string) => ({ id }), OPTIONS);
      await fn('before-close');
      await cache.close();
      const keyed = vi.spyOn(AutoKeys.prototype, 'key');
      await expect(fn('after-close')).rejects.toThrow('Cache has been closed');
      expect(keyed).not.toHaveBeenCalled();
    });

    it('rejects a call made while close() runs, as get() does, although L1 still holds it', async () => {
      const { cache } = cacheWithChannel();
      const fn = cache.wrap(async (id: string) => ({ id }), OPTIONS);
      await fn('held');
      const keyed = vi.spyOn(AutoKeys.prototype, 'key');
      // close() awaits the invalidation channel before it clears L1.
      const closing = cache.close();
      await expect(fn('held')).rejects.toThrow('Cache has been closed');
      await expect(cache.get(generateKey(OPTIONS.namespace, ['held']))).rejects.toThrow(
        'Cache has been closed'
      );
      expect(keyed).not.toHaveBeenCalled();
      await closing;
    });
  });

  it('keeps no memo for a call that skips L1', async () => {
    const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
    const options = { namespace: 'svc:getThing', ttl: 60, skipL1: true };
    const fn = cache.wrap(async (id: number) => ({ id }), options);
    await fn(7);
    options.skipL1 = false;
    // Not memoised by the skipping call: this one keys in full and reaches L1.
    expect(await encodesDuring(() => fn(7))).toBeGreaterThan(0);
    expect(await encodesDuring(() => fn(7))).toBe(0);
    await cache.close();
  });

  it('keys a call under the namespace its options hold at the time', async () => {
    const backend = new InMemoryBackend();
    const writes = vi.spyOn(backend, 'set');
    const cache = createCache({ backend, metrics: false });
    const options = { namespace: 'a', ttl: 60 };
    const fn = cache.wrap(async (id: number) => ({ id }), options);
    await fn(1);
    options.namespace = 'b';
    await fn(1);
    expect(lastL1Key()).toBe(generateKey('b', [1]));
    expect(writes.mock.calls.map((c) => c[0])).toEqual([
      generateKey('a', [1]),
      generateKey('b', [1]),
    ]);
    await cache.close();
  });

  describe('forgets the arguments it holds', () => {
    /** Two memoised functions in two namespaces, each with an entry. */
    async function filled(cache: SecureCache) {
      const f = cache.wrap(async (id: number) => ({ id }), { namespace: 'a', ttl: 60 });
      const g = cache.wrap(async (id: number) => ({ id }), { namespace: 'b', ttl: 60 });
      await f(1);
      await g(1);
      expect(await encodesDuring(() => g(1))).toBe(0);
      return { f, g };
    }

    it.each<[string, (cache: SecureCache) => Promise<unknown>]>([
      ['delete', (cache) => cache.delete(generateKey('a', [1]))],
      ['invalidate params', (cache) => cache.invalidate('params', { key: generateKey('a', [1]) })],
      ['invalidate namespace', (cache) => cache.invalidate('namespace', { namespace: 'a' })],
    ])('on %s, in every function of the cache', async (_, remove) => {
      const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
      const { g } = await filled(cache);
      await remove(cache);
      // g's entry is still in L1, but its key is generated again.
      expect(await encodesDuring(() => g(1))).toBe(1);
      expect(lastL1Key()).toBe(generateKey('b', [1]));
      expect(await encodesDuring(() => g(1))).toBe(0);
      await cache.close();
    });

    it.each<[string, (cache: SecureCache) => Promise<unknown>]>([
      ['invalidate global', (cache) => cache.invalidate('global')],
      ['close', (cache) => cache.close()],
    ])('on %s', async (_, remove) => {
      const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
      await filled(cache);
      const forget = vi.spyOn(AutoKeys.prototype, 'forget');
      await remove(cache);
      expect(new Set(forget.mock.contexts)).toHaveProperty('size', 2);
      await cache.close();
    });

    it("on another instance's invalidation event", async () => {
      const { cache, deliver } = cacheWithChannel();
      const { g } = await filled(cache);
      deliver(createInvalidationEvent('namespace', 'another-instance', { namespace: 'a' }));
      expect(await encodesDuring(() => g(1))).toBe(1);
      await cache.close();
    });

    describe('and drops its references to the memos of functions nobody holds', () => {
      /** A cache with `dropped` wrapped functions nobody holds, collected, and one held. */
      async function withCollected(dropped: number) {
        setFlagsFromString('--expose-gc');
        const gc: unknown = runInNewContext('gc');
        if (typeof gc !== 'function') throw new Error('gc is not exposed');
        const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
        const registry: unknown = Reflect.get(cache, 'keyMemos');
        if (!(registry instanceof Set)) throw new Error('CacheImpl keeps no keyMemos set');
        const held = cache.wrap(async (id: number) => ({ id }), { namespace: 'held', ttl: 60 });
        for (let i = 0; i < dropped; i++) {
          cache.wrap(async (id: number) => ({ id }), { namespace: 'dropped', ttl: 60 });
        }
        expect(registry.size).toBe(dropped + 1);
        // WeakRef targets live until the current job ends.
        await new Promise((resolve) => setTimeout(resolve, 0));
        gc();
        return { cache, registry, held };
      }

      it('when wrap() finds the set grown', async () => {
        const { cache, registry, held } = await withCollected(200);
        for (let i = 0; i < 60; i++) {
          cache.wrap(async (id: number) => ({ id }), { namespace: 'dropped', ttl: 60 });
        }
        expect(registry.size).toBeLessThan(100);
        await held(1);
        await cache.close();
      });

      it('when it forgets', async () => {
        const { cache, registry, held } = await withCollected(20);
        await cache.invalidate('global');
        expect(registry.size).toBe(1);
        await held(1);
        await cache.close();
      });
    });
  });
});

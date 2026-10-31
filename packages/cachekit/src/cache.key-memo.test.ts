/**
 * wrap() remembers the key of each call whose arguments are all primitives
 * (see AutoKeys), so a repeat L1 hit skips key generation. Through the public
 * API: the keys that reach L1 and the backend stay the keys generateKey gives;
 * a cache that encrypts, a cache without L1 and a call that skips L1 keep no
 * memo; and every removal on request empties every memo of the cache.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import timers from 'node:timers';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Encoder } from '@msgpack/msgpack';
import { createCache } from './cache.js';
import { CacheImpl, type CacheRuntime, type InvalidationChannelLike } from './cache-core.js';
import { L1Cache, type L1Entry } from './l1/lru-cache.js';
import { AutoKeys, type UnrefTimeout } from './serialization/auto-keys.js';
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
let held: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  encodes = vi.spyOn(Encoder.prototype, 'encodeSharedRef');
  lookups = vi.spyOn(L1Cache.prototype, 'getWithSwr');
  held = vi.spyOn(L1Cache.prototype, 'hit');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** MessagePack encodes during `call`: a key generation, or a value written. */
const encodesDuring = async (call: () => Promise<unknown>): Promise<number> => {
  const before = encodes.mock.calls.length;
  await call();
  return encodes.mock.calls.length - before;
};

/**
 * The key of the last L1 read: a lookup by key, or a memoised call serving the
 * entry it holds (L1Cache.hit), whichever came last.
 */
const lastL1Key = (): unknown => {
  const byKey = lookups.mock.invocationCallOrder.at(-1) ?? -1;
  const byEntry = held.mock.invocationCallOrder.at(-1) ?? -1;
  return byEntry > byKey
    ? (held.mock.calls.at(-1)?.[0] as L1Entry<unknown>).key
    : lookups.mock.calls.at(-1)?.[0];
};

/** V8's gc(), for the tests of what can be collected. */
function exposeGc(): () => void {
  setFlagsFromString('--expose-gc');
  const gc: unknown = runInNewContext('gc');
  if (typeof gc !== 'function') throw new Error('gc is not exposed');
  return () => gc();
}

/**
 * Collects garbage every 20 ms until `done`, for two seconds at most: a memo
 * window, which may hold what a test waits on, runs one at most. A WeakRef
 * target lives until the current job ends, and one collection is not bound to
 * clear every WeakRef.
 */
async function collectUntil(gc: () => void, done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !done(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    gc();
  }
}

/** A Node.js Timeout, which setTimeout returns there. */
const isTimeout = (value: unknown): value is NodeJS.Timeout =>
  typeof value === 'object' && value !== null && 'hasRef' in value;

/** The timers a setTimeout spy saw set for `ms`. */
const timersOf = (timeouts: ReturnType<typeof vi.spyOn>, ms: number): NodeJS.Timeout[] =>
  timeouts.mock.calls.flatMap(([, delay]: unknown[], i: number) =>
    delay === ms ? [timeouts.mock.results[i]?.value].filter(isTimeout) : []
  );

/** A memo timer unref'd as the Node runtime's is, so a pending one never holds the process open. */
const unrefTimeout: UnrefTimeout = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/** A runtime with no invalidation channel and, unless given one, no memo timer. */
const bareRuntime = (setUnrefTimeout?: UnrefTimeout): CacheRuntime => ({
  resolveBackend: () => new InMemoryBackend(),
  createByteStorage: () => new ByteStorage(),
  createEncryption: (config) => new EncryptionManager(config.masterKey, config.tenantId),
  setUnrefTimeout,
});

/** A cache whose invalidation channel the test drives by hand, and which stops as `stop` does. */
function cacheWithChannel(
  options: Omit<CacheOptions, 'backend'> = {},
  stop: () => Promise<void> = async () => {}
) {
  let deliver: (event: InvalidationEvent) => void = () => {
    throw new Error('the cache never subscribed');
  };
  const channel: InvalidationChannelLike = {
    publish: () => {},
    subscribe: (callback) => {
      deliver = callback;
    },
    start: async () => {},
    stop,
  };
  const runtime: CacheRuntime = {
    ...bareRuntime(unrefTimeout),
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

  describe('a repeat L1 hit holds its entry', () => {
    const OPTIONS = { namespace: 'svc:getThing', ttl: 60 };
    const KEY = generateKey(OPTIONS.namespace, [7]);
    type Wrapped = (id: number) => Promise<{ id: number }>;

    /** Call 7 twice: a miss that fills L1, then an L1 hit by key, whose entry the memo then holds. */
    async function holding(cache: {
      wrap: CacheImpl['wrap'];
    }): Promise<{ fn: Wrapped; stored: unknown }> {
      const fn: Wrapped = cache.wrap(async (id: number) => ({ id }), OPTIONS);
      await fn(7);
      const stored = await fn(7);
      return { fn, stored };
    }

    it('serves it on one check: no lookup by key, no key generation, one hit counted', async () => {
      const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
      const { fn, stored } = await holding(cache);
      const counted = vi.spyOn(
        CacheImpl.prototype as unknown as { recordHit(layer: string): void },
        'recordHit'
      );
      const byKey = vi.spyOn(L1Cache.prototype, 'entry');
      lookups.mockClear();
      held.mockClear();
      expect(await encodesDuring(async () => expect(await fn(7)).toBe(stored))).toBe(0);
      expect(lookups).not.toHaveBeenCalled();
      expect(byKey).not.toHaveBeenCalled();
      expect(held).toHaveBeenCalledTimes(1);
      expect(held).toHaveLastReturnedWith(true);
      expect(counted.mock.calls).toEqual([['l1']]);
      await cache.close();
    });

    it('leaves a stale entry to the lookup by key, which takes the refresh decision', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
        const { fn, stored } = await holding(cache);
        // Past the stale point (half the ttl, plus at most 10% jitter), not yet past the ttl.
        vi.setSystemTime(Date.now() + 40_000);
        lookups.mockClear();
        expect(await fn(7)).toBe(stored);
        expect(held).toHaveLastReturnedWith(false);
        expect(lookups).toHaveBeenCalledTimes(1);
        expect(lookups).toHaveLastReturnedWith(expect.objectContaining({ shouldRefresh: true }));
        await cache.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it.each<[string, (cache: CacheImpl, deliver: (e: InvalidationEvent) => void) => unknown]>([
      ['delete()', (cache) => cache.delete(KEY)],
      ['invalidate("params")', (cache) => cache.invalidate('params', { key: KEY })],
      [
        'invalidate("namespace")',
        (cache) => cache.invalidate('namespace', { namespace: OPTIONS.namespace }),
      ],
      ['invalidate("global")', (cache) => cache.invalidate('global')],
      [
        'an invalidation event from another instance',
        (_, deliver) => deliver(createInvalidationEvent('global', 'another-instance')),
      ],
      [
        'eviction',
        (cache) =>
          cache.wrap(async (id: number) => ({ id }), { ...OPTIONS, namespace: 'other' })(8),
      ],
    ])('never serves it once %s has removed it', async (_, remove) => {
      const { cache, deliver } = cacheWithChannel({ metrics: false, l1: { maxEntries: 1 } });
      const { fn, stored } = await holding(cache);
      expect(await fn(7)).toBe(stored);
      await remove(cache, deliver);
      const served = await fn(7);
      expect(served).not.toBe(stored);
      expect(served).toEqual({ id: 7 });
      await cache.close();
    });

    it('never serves it once close() has begun', async () => {
      const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
      const { fn } = await holding(cache);
      const closing = cache.close();
      held.mockClear();
      await expect(fn(7)).rejects.toThrow('Cache has been closed');
      expect(held).not.toHaveBeenCalled();
      await closing;
    });
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
    [
      // Workers, which can cancel a timer when the request that set it ends
      'wrap on a runtime without an unref timer',
      () => new CacheImpl({ backend: new InMemoryBackend(), metrics: false }, bareRuntime()),
      (cache) => cache.wrap(async (id: number) => ({ id }), OPTIONS),
    ],
  ])('keeps no memo: %s', async (_, build, wrapped) => {
    const cache = build();
    const memos = vi.spyOn(AutoKeys.prototype, 'slot');
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
      const keyed = vi.spyOn(AutoKeys.prototype, 'slot');
      await expect(fn('after-close')).rejects.toThrow('Cache has been closed');
      expect(keyed).not.toHaveBeenCalled();
    });

    it('rejects a call made while close() runs, as get() does, although L1 still holds it', async () => {
      const { cache } = cacheWithChannel();
      const fn = cache.wrap(async (id: string) => ({ id }), OPTIONS);
      await fn('held');
      const keyed = vi.spyOn(AutoKeys.prototype, 'slot');
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

  it('keeps no entry for a wrap whose ttl is 0, which never expires', async () => {
    const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
    const fn = cache.wrap(async (id: number) => ({ id }), { namespace: 'svc:getThing', ttl: 0 });
    await fn(7);
    // An L1 hit, still keyed in full.
    expect(await encodesDuring(() => fn(7))).toBe(1);
    await cache.close();
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

  it("empties on a call one ttl after its first entry, the wrap's ttl or else the cache's default", async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const cache = createCache({ backend: new InMemoryBackend(), metrics: false, defaultTtl: 30 });
    // As a JavaScript caller can, leave ttl out of b's options.
    const untimed = { namespace: 'b', ttl: 30 };
    Reflect.deleteProperty(untimed, 'ttl');
    // A call, not the timer, empties the memo here: the test ends long before it runs.
    const fns: [number, string, (id: number) => Promise<{ id: number }>][] = [
      [10, 'a', cache.wrap(async (id: number) => ({ id }), { namespace: 'a', ttl: 10 })],
      [30, 'b', cache.wrap(async (id: number) => ({ id }), untimed)],
    ];
    for (const [ttl, namespace, fn] of fns) {
      const end = clock + ttl * 1000;
      await fn(1);
      clock = end - 2;
      await fn(2); // L1 holds it for one more ttl
      clock = end - 1;
      expect(await encodesDuring(() => fn(2))).toBe(0);
      clock = end;
      // The memo has emptied while L1 still serves fn(2), so only its key is generated.
      expect(await encodesDuring(() => fn(2))).toBe(1);
      expect(lastL1Key()).toBe(generateKey(namespace, [2]));
    }
    await cache.close();
  });

  it('empties the memo of a function that is not called again, one ttl or one second after its first entry', async () => {
    // The memo's timer comes from node:timers, which vi.useFakeTimers() does not
    // replace: capture it and fire it by hand, so no clock is involved.
    const armed: { fire: () => void; ms: number | undefined }[] = [];
    const realSetTimeout = timers.setTimeout;
    vi.spyOn(timers, 'setTimeout').mockImplementation((callback, ms) => {
      armed.push({ fire: () => callback(), ms });
      return realSetTimeout(() => {}, 0).unref();
    });
    const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
    const short = cache.wrap(async (id: number) => ({ id }), { namespace: 'a', ttl: 0.25 });
    const long = cache.wrap(async (id: number) => ({ id }), { namespace: 'b', ttl: 10 });
    await short(1);
    await long(1);
    await long(2);
    expect(armed.map((timer) => timer.ms)).toEqual([250, 1_000]);
    // Until the timer fires, the memo serves; after it, the call keys in full,
    // though L1 still holds its value.
    expect(await encodesDuring(() => long(1))).toBe(0);
    armed[1]?.fire();
    expect(await encodesDuring(() => long(1))).toBe(1);
    await cache.close();
  });

  it('sets its timer through node:timers, so a global setTimeout returning a number breaks nothing', async () => {
    vi.stubGlobal('setTimeout', () => 0); // what Jest's jsdom environment hands out
    const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
    const fn = cache.wrap(async (id: number) => ({ id }), { namespace: 'a', ttl: 60 });
    await fn(1);
    expect(await encodesDuring(() => fn(1))).toBe(0);
    await cache.close();
  });

  it('does not hold the process open with that timer', async () => {
    const timeouts = vi.spyOn(timers, 'setTimeout');
    const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
    const fn = cache.wrap(async (id: number) => ({ id }), { namespace: 'a', ttl: 10 });
    await fn(1);
    const memoTimers = timersOf(timeouts, 1_000);
    expect(memoTimers).toHaveLength(1);
    expect(memoTimers[0]?.hasRef()).toBe(false);
    await cache.close();
  });

  describe("holds the caller's AsyncLocalStorage context only until the window ends", () => {
    // The call that opens a window sets its timer, and Node.js keeps a timer's
    // context until it fires: under a ttl of a minute, a window of one second.

    it('so a request is kept no longer than that', async () => {
      const gc = exposeGc();
      const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
      const fn = cache.wrap(async (id: number) => ({ id }), { namespace: 'a', ttl: 60 });
      const als = new AsyncLocalStorage<{ body: Uint8Array }>();
      // A request whose store the wrapped function never sees.
      const request = await (async () => {
        const store = { body: new Uint8Array(1 << 20) };
        await als.run(store, () => fn(1));
        return new WeakRef(store);
      })();
      await collectUntil(gc, () => request.deref() === undefined);
      expect(request.deref()).toBeUndefined();
      expect(await encodesDuring(() => fn(1))).toBe(1); // the window ended with it
      await cache.close();
    });

    it('so a function wrapped and dropped inside a request is collected with it', async () => {
      const gc = exposeGc();
      const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
      const als = new AsyncLocalStorage<{ fn?: (id: number) => Promise<{ id: number }> }>();
      const request = await (async () => {
        const store: { fn?: (id: number) => Promise<{ id: number }> } = {};
        await als.run(store, async () => {
          store.fn = cache.wrap(async (id: number) => ({ id }), { namespace: 'held', ttl: 60 });
          await store.fn(1);
        });
        return new WeakRef(store);
      })();
      await collectUntil(gc, () => request.deref() === undefined);
      expect(request.deref()).toBeUndefined();
      await cache.close();
    });
  });

  it('empties when the ttl its options hold changes', async () => {
    const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
    const options = { namespace: 'a', ttl: 60 };
    const fn = cache.wrap(async (id: number) => ({ id }), options);
    await fn(1);
    expect(await encodesDuring(() => fn(1))).toBe(0);
    options.ttl = 30;
    // Still an L1 hit, keyed in full because the memo emptied with the change.
    expect(await encodesDuring(() => fn(1))).toBe(1);
    expect(await encodesDuring(() => fn(1))).toBe(0);
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

    it('on close, before it waits for the invalidation channel to stop', async () => {
      let stopped: () => void = () => {};
      const { cache } = cacheWithChannel(
        {},
        () => new Promise<void>((resolve) => (stopped = resolve))
      );
      await filled(cache);
      const forget = vi.spyOn(AutoKeys.prototype, 'forget');
      const closing = cache.close();
      expect(new Set(forget.mock.contexts)).toHaveProperty('size', 2);
      stopped();
      await closing;
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
        const gc = exposeGc();
        const timeouts = vi.spyOn(timers, 'setTimeout');
        const cache = createCache({ backend: new InMemoryBackend(), metrics: false });
        const registry: unknown = Reflect.get(cache, 'keyMemos');
        if (!(registry instanceof Set)) throw new Error('CacheImpl keeps no keyMemos set');
        const held = cache.wrap(async (id: number) => ({ id }), { namespace: 'held', ttl: 60 });
        for (let i = 0; i < dropped; i++) {
          // Called once, so the timer that ends its window, and holds its memo till
          // then, is pending when it is dropped: a short ttl makes that window short.
          await cache.wrap(async (id: number) => ({ id }), { namespace: 'dropped', ttl: 0.05 })(i);
        }
        expect(registry.size).toBe(dropped + 1);
        expect(timersOf(timeouts, 50)).toHaveLength(dropped);
        timeouts.mockRestore(); // the spy's record of each timer holds its callback, and so its memo
        const live = () => [...registry].filter((ref) => ref instanceof WeakRef && ref.deref());
        await collectUntil(gc, () => live().length === 1);
        expect(live()).toHaveLength(1);
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

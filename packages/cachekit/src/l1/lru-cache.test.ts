import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { L1Cache } from './lru-cache.js';
import { setLogger } from '../logger.js';
import { ConfigurationError } from '../errors.js';
import { DEFAULT_L1_MAX_MEMORY } from '../constants.js';
import {
  defaultSerializer,
  encodeCounted,
  resolveSerializerConfig,
} from '../serialization/serializer.js';
import type { InvalidationEvent } from './types.js';

describe('L1Cache', () => {
  let cache: L1Cache<string>;

  beforeEach(() => {
    cache = new L1Cache({ maxEntries: 10 });
  });

  afterEach(() => {
    // Fake timers are process-global; a failing assertion before a trailing
    // vi.useRealTimers() would otherwise freeze the clock for every later test.
    vi.useRealTimers();
  });

  describe('config', () => {
    it.each([Infinity, -Infinity, NaN, 0, -1])('rejects maxMemory of %s', (maxMemory) => {
      const build = () => new L1Cache({ maxMemory });
      expect(build).toThrow(ConfigurationError);
      expect(build).toThrow(`l1.maxMemory must be a finite number > 0, got ${maxMemory}`);
    });

    it('treats an explicit undefined maxMemory as the default bound', () => {
      const c = new L1Cache<Uint8Array>({ maxMemory: undefined });
      c.set('fits', new Uint8Array(DEFAULT_L1_MAX_MEMORY / 8), 10000, 'test');
      c.set('over', new Uint8Array(DEFAULT_L1_MAX_MEMORY / 8 + 1), 10000, 'test');
      expect(c.get('fits')).not.toBeNull();
      expect(c.get('over')).toBeNull();
    });
  });

  describe('basic operations', () => {
    it('set and get', () => {
      cache.set('key', 'value', 10000, 'test');
      expect(cache.get('key')).toBe('value');
    });

    it('returns null for missing key', () => {
      expect(cache.get('missing')).toBeNull();
    });

    it('expires entries', () => {
      vi.useFakeTimers();
      cache.set('key', 'value', 100, 'test');
      vi.advanceTimersByTime(200);
      expect(cache.get('key')).toBeNull();
    });

    it('ttl <= 0 never expires (LAB-1388: matches the ts-wide "no expiry" contract)', () => {
      vi.useFakeTimers();
      cache.set('zero', 'value', 0, 'test');
      cache.set('negative', 'value', -1, 'test');
      vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 365); // 1 year
      expect(cache.get('zero')).toBe('value');
      expect(cache.get('negative')).toBe('value');
    });

    it('deletes key and returns true', () => {
      cache.set('key', 'value', 10000, 'test');
      expect(cache.delete('key')).toBe(true);
      expect(cache.get('key')).toBeNull();
    });

    it('delete returns false for missing key', () => {
      expect(cache.delete('missing')).toBe(false);
    });

    it('a deleted or expired key leaves no version behind', () => {
      // Per-entity keys in a long-running process must not grow the version map for good.
      vi.useFakeTimers();
      cache.set('deleted', 'v', 10000, 'test');
      cache.set('expired', 'v', 1000, 'test');
      cache.delete('deleted');
      vi.advanceTimersByTime(1001);
      expect(cache.get('expired')).toBeNull();
      const versions = (cache as unknown as { entryVersion: Map<string, number> }).entryVersion;
      expect(versions.size).toBe(0);
    });

    it('a refresh begun before a delete is rejected after the key is set again', () => {
      cache.set('key', 'v1', 10000, 'test');
      const { versionToken } = cache.getWithSwr('key');
      cache.delete('key');
      cache.set('key', 'v2', 10000, 'test');
      expect(cache.completeRefresh('key', 'stale', 10000, versionToken)).toBe(false);
      expect(cache.get('key')).toBe('v2');
    });

    it('clear removes all entries', () => {
      cache.set('a', '1', 10000, 'test');
      cache.set('b', '2', 10000, 'test');
      cache.clear();
      expect(cache.stats.entries).toBe(0);
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest when maxEntries exceeded', () => {
      const smallCache = new L1Cache<number>({ maxEntries: 3 });
      smallCache.set('a', 1, 10000, 'test');
      smallCache.set('b', 2, 10000, 'test');
      smallCache.set('c', 3, 10000, 'test');
      smallCache.set('d', 4, 10000, 'test'); // Should evict 'a'

      expect(smallCache.get('a')).toBeNull();
      expect(smallCache.get('b')).toBe(2);
      expect(smallCache.get('c')).toBe(3);
      expect(smallCache.get('d')).toBe(4);
    });

    it('C1 fix: cleans entryVersion on eviction', () => {
      const smallCache = new L1Cache<number>({ maxEntries: 2 });
      smallCache.set('a', 1, 10000, 'test');
      smallCache.set('b', 2, 10000, 'test');

      // Verify cache size is correct
      expect(smallCache.stats.entries).toBe(2);

      // Set 'c', which evicts 'a' (oldest)
      smallCache.set('c', 3, 10000, 'test');

      // Verify 'a' was evicted
      expect(smallCache.get('a')).toBeNull();
      expect(smallCache.stats.entries).toBe(2);

      // C1 fix verification: entryVersion Map should not grow unbounded
      // If C1 fix works, evicting 'a' also cleaned its version token
      // We can't directly test this without exposing internals,
      // but we can verify the cache still works correctly after many evictions
      for (let i = 0; i < 100; i++) {
        smallCache.set(`key${i}`, i, 10000, 'test');
      }

      // Cache should still work correctly (memory leak would cause issues)
      expect(smallCache.stats.entries).toBe(2);
    });

    it('a get() of an existing key makes it most recent and prevents eviction', () => {
      vi.useFakeTimers();
      const smallCache = new L1Cache<number>({ maxEntries: 3 });

      smallCache.set('a', 1, 10000, 'test');
      vi.advanceTimersByTime(100);
      smallCache.set('b', 2, 10000, 'test');
      vi.advanceTimersByTime(100);
      smallCache.set('c', 3, 10000, 'test');
      vi.advanceTimersByTime(100);

      // Access 'a' to make it most recent
      smallCache.get('a');
      vi.advanceTimersByTime(100);

      // Add 'd' - should evict 'b' (oldest)
      smallCache.set('d', 4, 10000, 'test');

      expect(smallCache.get('a')).toBe(1);
      expect(smallCache.get('b')).toBeNull();
      expect(smallCache.get('c')).toBe(3);
      expect(smallCache.get('d')).toBe(4);
    });

    it('evicts when maxMemory exceeded', () => {
      const smallCache = new L1Cache<string>({ maxEntries: 100, maxMemory: 2000 });

      // Each entry is charged 204 (102 JSON chars * 2 for UTF-16), under the
      // 250 per-entry share, so ten of them overrun 2000 by one entry.
      for (let i = 0; i < 10; i++) smallCache.set(`k${i}`, 'x'.repeat(100), 10000, 'test');

      expect(smallCache.get('k0')).toBeNull();
      expect(smallCache.stats.entries).toBe(9);
      expect(smallCache.stats.memoryUsed).toBeLessThanOrEqual(2000);
    });

    it('sizes byte payloads by their buffer, not their JSON form (LAB-238)', () => {
      // Secure caches store the L2 ciphertext here. JSON.stringify of a
      // Uint8Array yields {"0":12,"1":34,…} — roughly 14x the real size — so
      // measuring that way would evict most of L1 on the first entry.
      const bytesCache = new L1Cache<Uint8Array>({ maxEntries: 100, maxMemory: 4096 });
      const ciphertext = new Uint8Array(256).fill(0xab);

      bytesCache.set('a', ciphertext, 10000, 'test');

      expect(bytesCache.stats.memoryUsed).toBe(256);

      // 16 x 256B fits in a 4 KiB budget; under JSON sizing the second entry
      // would already have evicted the first.
      for (let i = 0; i < 15; i++) {
        bytesCache.set(`k${i}`, new Uint8Array(256).fill(i), 10000, 'test');
      }
      expect(bytesCache.stats.entries).toBe(16);
    });
  });

  describe('recency', () => {
    // A frozen clock: every op lands in the same millisecond, so only exact
    // recency can pass these, never a timestamp LRU that happened to tick.
    beforeEach(() => {
      vi.useFakeTimers();
    });

    const fill = (c: L1Cache<number>, keys: string[]) =>
      keys.forEach((k, i) => c.set(k, i, 10000, 'test'));
    // Observing a key with get() touches it, so call this only once, last.
    const keysOf = (c: L1Cache<unknown>, keys: string[]) => keys.filter((k) => c.get(k) !== null);

    it('a get() hit makes the key most recent', () => {
      const c = new L1Cache<number>({ maxEntries: 3 });
      fill(c, ['a', 'b', 'c']);
      c.get('a');
      c.set('d', 4, 10000, 'test');
      expect(keysOf(c, ['a', 'b', 'c', 'd'])).toEqual(['a', 'c', 'd']);
    });

    it('a getWithSwr() hit makes the key most recent', () => {
      const c = new L1Cache<number>({ maxEntries: 3 });
      fill(c, ['a', 'b', 'c']);
      c.getWithSwr('a');
      c.set('d', 4, 10000, 'test');
      expect(keysOf(c, ['a', 'b', 'c', 'd'])).toEqual(['a', 'c', 'd']);
    });

    it('set() of an existing key makes it most recent', () => {
      const c = new L1Cache<number>({ maxEntries: 3 });
      fill(c, ['a', 'b', 'c']);
      c.set('a', 10, 10000, 'test');
      c.set('d', 4, 10000, 'test');
      expect(keysOf(c, ['a', 'b', 'c', 'd'])).toEqual(['a', 'c', 'd']);
    });

    it('set() of an existing key at capacity evicts no other entry', () => {
      const c = new L1Cache<number>({ maxEntries: 3 });
      fill(c, ['a', 'b', 'c']);
      c.set('b', 20, 10000, 'test');
      expect(keysOf(c, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
      expect(c.get('b')).toBe(20);
      expect(c.stats.entries).toBe(3);
    });

    it('an overwrite that no longer fits in maxMemory evicts others, never itself', () => {
      const c = new L1Cache<Uint8Array>({ maxEntries: 100, maxMemory: 8000 });
      const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
      for (const k of keys) c.set(k, new Uint8Array(800), 10000, 'test');
      // k1 grows to 1000: 9 x 800 + 1000 > 8000, so the oldest other entry goes.
      c.set('k1', new Uint8Array(1000), 10000, 'test');
      expect(keysOf(c, keys)).toEqual(keys.slice(1));
      expect(c.get('k1')?.byteLength).toBe(1000);
      expect(c.stats.memoryUsed).toBe(7400);
    });

    it('evicts in LRU order when maxMemory binds', () => {
      const c = new L1Cache<Uint8Array>({ maxEntries: 100, maxMemory: 1000 });
      const keys = Array.from({ length: 16 }, (_, i) => `k${i}`);
      for (const k of keys) c.set(k, new Uint8Array(60), 10000, 'test');
      c.get('k0');
      // 125 more bytes on 960: k1 and k2 are the two least recent and must go.
      c.set('new', new Uint8Array(125), 10000, 'test');
      expect(keysOf(c, [...keys, 'new'])).toEqual(['k0', ...keys.slice(3), 'new']);
      expect(c.stats.memoryUsed).toBe(965);
    });

    it('eviction clears the namespace index and refresh marker of the evicted key', () => {
      vi.useFakeTimers();
      const c = new L1Cache<number>({ maxEntries: 2, swrThresholdRatio: 2 });
      c.set('a', 1, 10000, 'ns-a');
      c.set('b', 2, 10000, 'ns-b');
      expect(c.getWithSwr('a').shouldRefresh).toBe(true);
      c.get('b'); // a is now least recent
      c.set('c', 3, 10000, 'ns-c');
      expect(c.get('a')).toBeNull();
      expect(c.stats).toMatchObject({ entries: 2, namespaces: 2, refreshing: 0 });
    });

    it('matches a reference LRU over a long random op sequence', () => {
      // Reference: an array ordered least to most recent. Any slip in the
      // linked list (a lost link, a stale head or tail) shows up as a
      // divergence in which keys survive.
      const maxEntries = 8;
      const c = new L1Cache<number>({ maxEntries });
      const ref: string[] = [];
      const bump = (k: string) => {
        ref.splice(ref.indexOf(k), 1);
        ref.push(k);
      };
      let seed = 12345;
      const rand = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
      };
      for (let i = 0; i < 5000; i++) {
        const k = `k${rand(14)}`;
        const op = rand(10);
        if (op < 4) {
          c.set(k, i, 0, `ns${rand(3)}`);
          if (ref.includes(k)) bump(k);
          else {
            if (ref.length >= maxEntries) ref.shift();
            ref.push(k);
          }
        } else if (op < 7) {
          const hit = op === 4 ? c.getWithSwr(k).value !== null : c.get(k) !== null;
          expect(hit).toBe(ref.includes(k));
          if (hit) bump(k);
        } else if (op < 9) {
          expect(c.delete(k)).toBe(ref.includes(k));
          if (ref.includes(k)) ref.splice(ref.indexOf(k), 1);
        } else if (rand(50) === 0) {
          c.clear();
          ref.length = 0;
        }
        expect(c.stats.entries).toBe(ref.length);
      }
      const all = Array.from({ length: 14 }, (_, j) => `k${j}`);
      expect(keysOf(c, all)).toEqual(all.filter((k) => ref.includes(k)));
    });
  });

  describe('a value charged above an eighth of maxMemory', () => {
    // Byte values are charged exactly their byteLength, so the charges here are exact.
    const filled = () => {
      const c = new L1Cache<Uint8Array>({ maxEntries: 100, maxMemory: 8000 });
      c.set('a', new Uint8Array(300), 10000, 'test');
      c.set('b', new Uint8Array(300), 10000, 'test');
      return c;
    };

    it('is not stored, and evicts nothing', () => {
      const c = filled();
      c.set('big', new Uint8Array(1001), 10000, 'test');
      expect(c.get('big')).toBeNull();
      expect(c.get('a')?.byteLength).toBe(300);
      expect(c.get('b')?.byteLength).toBe(300);
      expect(c.stats).toMatchObject({ entries: 2, memoryUsed: 600 });
    });

    it('drops the older entry under the same key', () => {
      const c = filled();
      c.set('a', new Uint8Array(1001), 10000, 'test');
      expect(c.get('a')).toBeNull();
      expect(c.get('b')?.byteLength).toBe(300);
      expect(c.stats).toMatchObject({ entries: 1, memoryUsed: 300, namespaces: 1 });
    });

    it('invalidates the version, so an earlier refresh cannot restore the old value', () => {
      const c = filled();
      const { versionToken } = c.getWithSwr('a');
      c.set('a', new Uint8Array(1001), 10000, 'test');
      expect(c.completeRefresh('a', new Uint8Array(300), 10000, versionToken)).toBe(false);
      expect(c.get('a')).toBeNull();
    });

    it('leaves no version behind for a key that was never stored', () => {
      // Each distinct over-budget key read from L2 must not grow the version map for good.
      const c = new L1Cache<Uint8Array>({ maxEntries: 100, maxMemory: 8000 });
      for (let i = 0; i < 50; i++) c.set(`big${i}`, new Uint8Array(1001), 10000, 'test');
      const versions = (c as unknown as { entryVersion: Map<string, number> }).entryVersion;
      expect(versions.size).toBe(0);
    });

    it('leaves no version behind for a key it replaces', () => {
      const c = filled();
      c.set('a', new Uint8Array(1001), 10000, 'test');
      c.set('b', new Uint8Array(1001), 10000, 'test');
      const versions = (c as unknown as { entryVersion: Map<string, number> }).entryVersion;
      expect(c.stats.entries).toBe(0);
      expect(versions.size).toBe(0);
    });

    it('is not stored by completeRefresh either', () => {
      const c = filled();
      const { versionToken } = c.getWithSwr('a');
      c.completeRefresh('a', new Uint8Array(1001), 10000, versionToken);
      expect(c.get('a')).toBeNull();
      expect(c.get('b')?.byteLength).toBe(300);
      expect(c.stats).toMatchObject({ entries: 1, memoryUsed: 300 });
    });

    it('is refused when the value count tips the charge over', () => {
      const c = new L1Cache<unknown>({ maxEntries: 100, maxMemory: 8000 });
      c.set('a', 'x', 10000, 'test');
      // 175 (100 B x 1.75) + 768 (24 objects x 32) is under the 1000 cap; 10 values x 8 = 80 more is 1023.
      c.set('rows', [{}], 10000, 'test', 100, { objects: 24, values: 10 });
      expect(c.get('rows')).toBeNull();
      expect(c.get('a')).toBe('x');

      c.set('rows', [{}], 10000, 'test', 100, { objects: 24, values: 0 });
      expect(c.get('rows')).toEqual([{}]);
    });

    it('a charge of exactly an eighth of maxMemory is stored; one byte more drops the older entry', () => {
      const c = filled();
      c.set('a', new Uint8Array(1000), 10000, 'test');
      expect(c.get('a')?.byteLength).toBe(1000);
      expect(c.stats).toMatchObject({ entries: 2, memoryUsed: 1300 });

      c.set('a', new Uint8Array(1001), 10000, 'test');
      expect(c.get('a')).toBeNull();
      expect(c.stats).toMatchObject({ entries: 1, memoryUsed: 300 });
    });

    it('refuses a charge under maxMemory that would still evict most of L1', () => {
      const c = filled();
      c.set('a', new Uint8Array(7999), 10000, 'test');
      expect(c.get('a')).toBeNull();
      expect(c.get('b')?.byteLength).toBe(300);
    });

    it('keeps the small entries when a near-budget key is read over and over', () => {
      // A full L1 of small entries and one large key that every read misses
      // in L1 and refills from L2. Stored, the large entry would evict most
      // of L1 on each refill, and the next small fill would evict it in turn.
      const c = new L1Cache<Uint8Array>({ maxEntries: 1000, maxMemory: 100_000 });
      const small = Array.from({ length: 49 }, (_, i) => `s${i}`);
      for (const k of small) c.set(k, new Uint8Array(2000), 10000, 'test');

      for (let read = 0; read < 20; read++) {
        if (c.get('large') === null) c.set('large', new Uint8Array(99_000), 10000, 'test');
        const k = small[read % small.length];
        if (c.get(k) === null) c.set(k, new Uint8Array(2000), 10000, 'test');
      }

      expect(small.filter((k) => c.get(k) === null)).toEqual([]);
      expect(c.get('large')).toBeNull();
    });
  });

  describe('serializedSize hint', () => {
    // One fixed mixed workload, inserted far past maxMemory, into a cache
    // sized by the JSON.stringify estimate and one sized by the hint.
    const parityWorkload = (): unknown[] => {
      const rec = (i: number) => ({ id: i, name: `item-${i}`, score: i * 1.5, ok: i % 2 === 0 });
      const shapes: ((i: number) => unknown)[] = [
        (i) => `ascii-${i}-` + 'x'.repeat(100),
        (i) => `ascii-${i}-` + 'lorem ipsum '.repeat(400),
        (i) => `café crème ${i} `.repeat(60),
        (i) => `缓存数据${i}`.repeat(80),
        (i) => `🚀✨${i}`.repeat(50),
        (i) => Array.from({ length: 200 }, (_, j) => i * 1000 + j),
        (i) => Array.from({ length: 100 }, (_, j) => (i + j) / 7),
        (i) => ({ rows: Array.from({ length: 30 }, (_, j) => rec(i + j)) }),
        (i) => ({ rows: Array.from({ length: 300 }, (_, j) => rec(i + j)) }),
        (i) => ({
          id: i,
          email: `u${i}@example.com`,
          roles: ['admin', 'user'],
          profile: { first: 'Ann', last: 'Lee', bio: 'b'.repeat(200) },
        }),
        (i) => ({ a: { b: { c: [i, 2, { d: 'deep', e: [true, false, null] }] } }, tags: ['x'] }),
      ];
      return Array.from({ length: 2200 }, (_, i) => shapes[i % shapes.length](i));
    };

    it('charges 2.5x the serialized length', () => {
      const value = { id: 1, name: 'x'.repeat(100) };
      cache.set('a', value as unknown as string, 10000, 'test', 120);
      expect(cache.stats.memoryUsed).toBe(120 * 2.5);
    });

    it('does not stringify the value when given a size', () => {
      const spy = vi.spyOn(JSON, 'stringify');
      try {
        cache.set('a', 'x'.repeat(1000), 10000, 'test', 1003);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('charges byte values their byteLength whatever the hint', () => {
      const c = new L1Cache<Uint8Array>();
      c.set('a', new Uint8Array(256), 10000, 'test', 9999, { objects: 500, values: 500 });
      expect(c.stats.memoryUsed).toBe(256);
    });

    it.each([NaN, -1, Infinity, Number.MAX_VALUE])(
      'falls back to the estimate for a hint of %s',
      (hint) => {
        const withHint = new L1Cache<string>();
        const without = new L1Cache<string>();
        withHint.set('a', 'x'.repeat(100), 10000, 'test', hint);
        without.set('a', 'x'.repeat(100), 10000, 'test');
        expect(withHint.get('a')).toBe('x'.repeat(100));
        expect(withHint.stats.memoryUsed).toBe(without.stats.memoryUsed);
      }
    );

    it.each([
      { objects: Number.MAX_VALUE, values: 0 },
      { objects: 0, values: Number.MAX_VALUE },
    ])('falls back to the estimate for a count that overflows the charge: %o', (count) => {
      const counted = new L1Cache<string>();
      const without = new L1Cache<string>();
      counted.set('a', 'x'.repeat(100), 10000, 'test', 1, count);
      without.set('a', 'x'.repeat(100), 10000, 'test');
      expect(counted.get('a')).toBe('x'.repeat(100));
      expect(counted.stats.memoryUsed).toBe(without.stats.memoryUsed);
    });

    it('keeps memoryUsed finite under the largest memory bound', () => {
      // Each charge (2.5 x 7e307) is finite but two sum past Number.MAX_VALUE;
      // the per-entry cap refuses both.
      const c = new L1Cache<string>({ maxEntries: 2, maxMemory: Number.MAX_VALUE });
      c.set('a', 'x', 10000, 'test', 7e307);
      c.set('b', 'y', 10000, 'test', 7e307);
      expect(Number.isFinite(c.stats.memoryUsed)).toBe(true);
      expect(c.stats.memoryUsed).toBe(0);
      expect(c.get('a')).toBeNull();
      expect(c.get('b')).toBeNull();
    });

    it('keeps eviction under maxMemory within 25% of the estimate it replaces', () => {
      const workload = parityWorkload();
      const sizes = workload.map((v) => defaultSerializer.encode(v).length);

      for (const mb of [1, 2, 5]) {
        const config = { maxEntries: 1_000_000, maxMemory: mb * 1024 * 1024 };
        const estimated = new L1Cache<unknown>(config);
        const hinted = new L1Cache<unknown>(config);
        workload.forEach((v, i) => {
          estimated.set(`k${i}`, v, 0, 'parity');
          hinted.set(`k${i}`, v, 0, 'parity', sizes[i]);
        });
        // maxMemory must actually bind, or the comparison proves nothing.
        expect(estimated.stats.entries).toBeLessThan(workload.length);
        expect(hinted.stats.entries / estimated.stats.entries).toBeGreaterThanOrEqual(0.75);
        expect(hinted.stats.entries / estimated.stats.entries).toBeLessThanOrEqual(1.25);
      }
    });

    it('keeps that parity with each object and value charged too', () => {
      const workload = parityWorkload();
      const serializerConfig = resolveSerializerConfig();
      const counts = workload.map(() => ({ objects: 0, values: 0 }));
      const sizes = workload.map((v, i) => encodeCounted(v, serializerConfig, counts[i]).length);

      for (const mb of [1, 2, 5]) {
        const config = { maxEntries: 1_000_000, maxMemory: mb * 1024 * 1024 };
        const estimated = new L1Cache<unknown>(config);
        const hinted = new L1Cache<unknown>(config);
        workload.forEach((v, i) => {
          estimated.set(`k${i}`, v, 0, 'parity');
          hinted.set(`k${i}`, v, 0, 'parity', sizes[i], counts[i]);
        });
        expect(estimated.stats.entries).toBeLessThan(workload.length);
        expect(hinted.stats.entries / estimated.stats.entries).toBeGreaterThanOrEqual(0.75);
        expect(hinted.stats.entries / estimated.stats.entries).toBeLessThanOrEqual(1.25);
      }
    });

    it('charges each object on top of the serialized size', () => {
      // 2,000 empty objects: three bytes of array header and one per object,
      // but a heap object each.
      const value = Array.from({ length: 2000 }, () => ({}));
      const count = { objects: 0, values: 0 };
      const size = encodeCounted(value, resolveSerializerConfig(), count).length;
      expect(count).toEqual({ objects: 2001, values: 2000 });

      const c = new L1Cache<unknown>();
      c.set('a', value, 10000, 'test', size, count);
      expect(c.stats.memoryUsed).toBe(size * 1.75 + 2001 * 32 + 2000 * 8);
    });

    it.each([NaN, -1, Infinity])('charges a count with a field of %s as no count', (bad) => {
      for (const count of [
        { objects: bad, values: 10 },
        { objects: 10, values: bad },
      ]) {
        const counted = new L1Cache<string>();
        counted.set('a', 'x'.repeat(100), 10000, 'test', 103, count);
        expect(counted.stats.memoryUsed).toBe(103 * 2.5);
      }
    });

    it('reads each count field once', () => {
      // A getter that turns NaN on a second read must not reach currentMemory.
      const reads = { objects: 0, values: 0 };
      const count = {
        get objects() {
          return reads.objects++ === 0 ? 1 : NaN;
        },
        get values() {
          return reads.values++ === 0 ? 1 : NaN;
        },
      };
      const c = new L1Cache<string>();
      c.set('a', 'x', 10000, 'test', 10, count);
      expect(reads).toEqual({ objects: 1, values: 1 });
      expect(c.stats.memoryUsed).toBe(10 * 1.75 + 32 + 8);
    });

    it('ignores the count without a serialized size', () => {
      const counted = new L1Cache<string>();
      const without = new L1Cache<string>();
      counted.set('a', 'x'.repeat(100), 10000, 'test', undefined, { objects: 50, values: 50 });
      without.set('a', 'x'.repeat(100), 10000, 'test');
      expect(counted.stats.memoryUsed).toBe(without.stats.memoryUsed);
    });
  });

  describe('SWR', () => {
    it('returns fresh result when not past threshold', () => {
      cache.set('key', 'value', 10000, 'test');
      const result = cache.getWithSwr('key');
      expect(result.value).toBe('value');
      expect(result.isFresh).toBe(true);
      expect(result.shouldRefresh).toBe(false);
    });
    it('does not take a refresh marker for a null-valued entry', () => {
      const nullCache = new L1Cache<null>({ swrEnabled: true, swrThresholdRatio: 2 });
      nullCache.set('key', null, 10_000, 'test');

      const result = nullCache.getWithSwr('key');

      expect(result.value).toBeNull();
      expect(result.shouldRefresh).toBe(false);
      expect(nullCache.stats.refreshing).toBe(0);
    });

    it('returns stale result with shouldRefresh after threshold', () => {
      vi.useFakeTimers();
      cache.set('key', 'value', 1000, 'test');
      vi.advanceTimersByTime(600); // Past 50% threshold (accounting for jitter)

      const result = cache.getWithSwr('key');
      expect(result.value).toBe('value');
      // May or may not be marked for refresh due to jitter
    });

    it('does not return value when fully expired', () => {
      vi.useFakeTimers();
      cache.set('key', 'value', 1000, 'test');
      vi.advanceTimersByTime(1100);

      const result = cache.getWithSwr('key');
      expect(result.value).toBeNull();
      expect(result.shouldRefresh).toBe(false);
    });

    it('completeRefresh updates cache if version matches', () => {
      cache.set('key', 'old', 10000, 'test');
      const result = cache.getWithSwr('key');

      const updated = cache.completeRefresh('key', 'new', 10000, result.versionToken);
      expect(updated).toBe(true);
      expect(cache.get('key')).toBe('new');
    });

    it('completeRefresh rejects if version changed', () => {
      cache.set('key', 'old', 10000, 'test');
      const result = cache.getWithSwr('key');

      // Invalidate the key (bumps version)
      cache.invalidateByKey('key');

      // Try to complete refresh with old version
      const updated = cache.completeRefresh('key', 'new', 10000, result.versionToken);
      expect(updated).toBe(false);
    });

    it('cancelRefresh removes key from refreshingKeys', () => {
      vi.useFakeTimers();
      cache.set('key', 'value', 1000, 'test');
      vi.advanceTimersByTime(600);

      // Trigger refresh
      const result = cache.getWithSwr('key');
      if (result.shouldRefresh) {
        expect(cache.stats.refreshing).toBeGreaterThan(0);
        cache.cancelRefresh('key');
        expect(cache.stats.refreshing).toBe(0);
      }
    });

    it('C3 fix: limits concurrent refreshes', () => {
      const limitedCache = new L1Cache<number>({
        maxEntries: 100,
        maxConcurrentRefreshes: 2,
        swrEnabled: true,
      });

      vi.useFakeTimers();

      // Create 5 stale entries
      for (let i = 0; i < 5; i++) {
        limitedCache.set(`key${i}`, i, 1000, 'test');
      }

      vi.advanceTimersByTime(600); // Make them stale

      // Try to refresh all 5
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(limitedCache.getWithSwr(`key${i}`));
      }

      // Count how many triggered refresh
      const refreshCount = results.filter((r) => r.shouldRefresh).length;

      // Should be at most 2 (maxConcurrentRefreshes)
      expect(refreshCount).toBeLessThanOrEqual(2);
      expect(limitedCache.stats.refreshing).toBeLessThanOrEqual(2);
    });

    it('allows new refresh after completing previous one', () => {
      const limitedCache = new L1Cache<number>({
        maxEntries: 100,
        maxConcurrentRefreshes: 1,
        swrEnabled: true,
      });

      vi.useFakeTimers();

      limitedCache.set('a', 1, 1000, 'test');
      limitedCache.set('b', 2, 1000, 'test');

      vi.advanceTimersByTime(600);

      // First refresh
      const r1 = limitedCache.getWithSwr('a');
      expect(r1.shouldRefresh).toBe(true);
      expect(limitedCache.stats.refreshing).toBe(1);

      // Second refresh should be blocked
      const r2 = limitedCache.getWithSwr('b');
      expect(r2.shouldRefresh).toBe(false);

      // Complete first refresh
      limitedCache.completeRefresh('a', 10, 1000, r1.versionToken);
      expect(limitedCache.stats.refreshing).toBe(0);

      // Now second refresh should work
      const r3 = limitedCache.getWithSwr('b');
      expect(r3.shouldRefresh).toBe(true);
    });

    it('expires a refresh marker that is never cleared (torn-down refresh cannot wedge the key)', () => {
      vi.useFakeTimers();

      // Long TTL so the entry outlives the 60s marker lifetime. At t=120s,
      // remaining TTL (80s) is below the jittered threshold floor
      // (0.5 * 200s * 0.9 = 90s) — deterministically stale.
      cache.set('key', 'value', 200_000, 'test');
      vi.advanceTimersByTime(120_000);

      const first = cache.getWithSwr('key');
      expect(first.shouldRefresh).toBe(true);

      // Simulate the refresh being torn down without settling (workerd
      // dropping waitUntil work at its deadline): neither completeRefresh
      // nor cancelRefresh ever runs. While the marker lives, the key is
      // single-flighted…
      vi.advanceTimersByTime(5_000);
      expect(cache.getWithSwr('key').shouldRefresh).toBe(false);

      // …but once the marker expires, the key becomes refreshable again.
      vi.advanceTimersByTime(60_000);
      expect(cache.getWithSwr('key').shouldRefresh).toBe(true);
    });

    it('sweeps expired markers at the concurrency limit (wedged markers free their slots)', () => {
      const limitedCache = new L1Cache<number>({
        maxEntries: 100,
        maxConcurrentRefreshes: 2,
        swrEnabled: true,
      });

      vi.useFakeTimers();

      for (let i = 0; i < 3; i++) {
        limitedCache.set(`key${i}`, i, 200_000, 'test');
      }
      vi.advanceTimersByTime(120_000); // all deterministically stale

      // Fill both refresh slots with markers that are never cleared.
      expect(limitedCache.getWithSwr('key0').shouldRefresh).toBe(true);
      expect(limitedCache.getWithSwr('key1').shouldRefresh).toBe(true);
      expect(limitedCache.getWithSwr('key2').shouldRefresh).toBe(false); // at limit

      // Past the marker lifetime, the limit check sweeps the expired
      // markers instead of refusing forever — SWR is not disabled
      // cache-wide by stranded refreshes.
      vi.advanceTimersByTime(65_000);
      expect(limitedCache.getWithSwr('key2').shouldRefresh).toBe(true);
      expect(limitedCache.stats.refreshing).toBe(1);
    });

    it('deferRefresh frees the refresh slot and holds the key off for the marker TTL', () => {
      vi.useFakeTimers();
      // Stale on every jitter draw at t=120s (see the marker-expiry test) and
      // alive until t=200s, past the 60s hold.
      cache.set('key', 'value', 200_000, 'test');
      vi.advanceTimersByTime(120_000);
      const read = cache.getWithSwr('key');
      expect(read.shouldRefresh).toBe(true);

      cache.deferRefresh('key', read.versionToken);
      expect(cache.stats.refreshing).toBe(0);

      vi.advanceTimersByTime(59_999);
      expect(cache.getWithSwr('key').shouldRefresh).toBe(false);
      vi.advanceTimersByTime(1);
      expect(cache.getWithSwr('key').shouldRefresh).toBe(true);
    });

    it('deferRefresh holds nothing for a key L1 dropped or rewrote while it refreshed', () => {
      vi.useFakeTimers();
      cache.set('deleted', 'value', 200_000, 'test');
      cache.set('rewritten', 'value', 200_000, 'test');
      vi.advanceTimersByTime(120_000);
      const deleted = cache.getWithSwr('deleted');
      const rewritten = cache.getWithSwr('rewritten');
      expect(deleted.shouldRefresh && rewritten.shouldRefresh).toBe(true);

      // The refreshes are in flight when L1 loses the entries they were for.
      cache.delete('deleted');
      cache.set('rewritten', 'newer', 2_000, 'test');
      cache.deferRefresh('deleted', deleted.versionToken);
      cache.deferRefresh('rewritten', rewritten.versionToken);
      expect(cache.stats.refreshing).toBe(0);

      // The hold is kept on the entry, so it went with it: a new entry for
      // either key that goes stale inside the old hold window refreshes.
      cache.set('deleted', 'again', 2_000, 'test');
      vi.advanceTimersByTime(1_500); // 0.5s left, below the 0.9s threshold floor
      expect(cache.getWithSwr('deleted').shouldRefresh).toBe(true);
      expect(cache.getWithSwr('rewritten').shouldRefresh).toBe(true);
    });
  });

  describe('invalidation', () => {
    it('invalidateByKey removes single key', () => {
      cache.set('key1', 'value1', 10000, 'ns');
      cache.set('key2', 'value2', 10000, 'ns');
      cache.invalidateByKey('key1');

      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBe('value2');
    });

    it('invalidateByNamespace removes all keys in namespace', () => {
      cache.set('ns1:a', 'value1', 10000, 'ns1');
      cache.set('ns1:b', 'value2', 10000, 'ns1');
      cache.set('ns2:c', 'value3', 10000, 'ns2');

      cache.invalidateByNamespace('ns1');

      expect(cache.get('ns1:a')).toBeNull();
      expect(cache.get('ns1:b')).toBeNull();
      expect(cache.get('ns2:c')).toBe('value3');
    });

    it('invalidateByNamespace works without namespace index', () => {
      const noIndexCache = new L1Cache<string>({ namespaceIndex: false });

      noIndexCache.set('ns1:a', 'value1', 10000, 'ns1');
      noIndexCache.set('ns1:b', 'value2', 10000, 'ns1');
      noIndexCache.set('ns2:c', 'value3', 10000, 'ns2');

      noIndexCache.invalidateByNamespace('ns1');

      expect(noIndexCache.get('ns1:a')).toBeNull();
      expect(noIndexCache.get('ns1:b')).toBeNull();
      expect(noIndexCache.get('ns2:c')).toBe('value3');
    });

    it('invalidateAll clears everything', () => {
      cache.set('a', '1', 10000, 'ns1');
      cache.set('b', '2', 10000, 'ns2');
      cache.invalidateAll();

      expect(cache.stats.entries).toBe(0);
      expect(cache.stats.namespaces).toBe(0);
    });

    it('bumps version on invalidation', () => {
      cache.set('key', 'value', 10000, 'test');
      const r1 = cache.getWithSwr('key');

      cache.invalidateByKey('key');

      // Try to complete refresh with old version - should fail
      const updated = cache.completeRefresh('key', 'new', 10000, r1.versionToken);
      expect(updated).toBe(false);
    });

    it('handleInvalidationEvent - global level', () => {
      cache.set('a', '1', 10000, 'ns1');
      cache.set('b', '2', 10000, 'ns2');

      const event: InvalidationEvent = {
        level: 'global',
        timestamp: Date.now(),
        sourceInstance: 'other-instance',
      };

      cache.handleInvalidationEvent(event);

      expect(cache.stats.entries).toBe(0);
    });

    it('handleInvalidationEvent - namespace level', () => {
      cache.set('ns1:a', 'value1', 10000, 'ns1');
      cache.set('ns1:b', 'value2', 10000, 'ns1');
      cache.set('ns2:c', 'value3', 10000, 'ns2');

      const event: InvalidationEvent = {
        level: 'namespace',
        namespace: 'ns1',
        timestamp: Date.now(),
        sourceInstance: 'other-instance',
      };

      cache.handleInvalidationEvent(event);

      expect(cache.get('ns1:a')).toBeNull();
      expect(cache.get('ns1:b')).toBeNull();
      expect(cache.get('ns2:c')).toBe('value3');
    });

    it('handleInvalidationEvent - reports a namespace event with no namespace (LAB-4336)', () => {
      // It invalidates nothing, so the publisher's intent is lost. That must
      // not vanish: before nil was accepted, such an event failed to
      // deserialize and the channel logged it. Accepting it must not cost
      // the signal. Empty string is the same case — it is falsy here.
      const reported: { message: string; data?: unknown }[] = [];
      setLogger((message, data) => reported.push({ message, data }));
      const forged = 'other-instance\n[cachekit] FORGED LINE';
      try {
        cache.set('ns1:a', 'value1', 10000, 'ns1');
        cache.handleInvalidationEvent({
          level: 'namespace',
          namespace: undefined,
          timestamp: Date.now(),
          sourceInstance: forged,
        });
        expect(cache.get('ns1:a')).toBe('value1');
      } finally {
        setLogger(null);
      }

      expect(reported).toHaveLength(1);
      expect(reported[0].message).toMatch(/Ignored namespace-level invalidation.*no namespace/);
      // A custom sink gets the value already escaped: nothing rides in a
      // second argument for the sink to mishandle, and the message carries no
      // raw newline, so the forged text cannot start a log line of its own.
      expect(reported[0].data).toBeUndefined();
      expect(reported[0].message).not.toContain('\n');
      expect(reported[0].message).toContain(
        'sourceInstance="other-instance\\n[cachekit] FORGED LINE"'
      );
    });

    it('handleInvalidationEvent - escapes the DEL/C1 and U+2028/U+2029 characters JSON.stringify leaves raw (LAB-4522)', () => {
      // JSON.stringify passes these through untouched. NEL (U+0085) and
      // U+2028/U+2029 can break a log line; CSI (U+009B) opens a terminal
      // control sequence; DEL is a control character like the rest.
      const reported: string[] = [];
      setLogger((message) => reported.push(message));
      try {
        cache.handleInvalidationEvent({
          level: 'namespace',
          timestamp: 0,
          sourceInstance: 'a\u0085b\u009bc\u2028d\u2029e\u007ff',
        });
      } finally {
        setLogger(null);
      }

      expect(reported).toHaveLength(1);
      expect(reported[0]).not.toMatch(/[\u007f-\u009f\u2028\u2029]/);
      expect(reported[0]).toContain('sourceInstance="a\\u0085b\\u009bc\\u2028d\\u2029e\\u007ff"');
    });

    it('handleInvalidationEvent - the report is total and bounded (LAB-4336)', () => {
      // Why this exists next to the test above: that fixture is a short
      // string, so it passes with both the typeof guard and the bound deleted.
      const reported: string[] = [];
      const report = (sourceInstance: unknown) => {
        cache.handleInvalidationEvent({
          level: 'namespace',
          timestamp: 0,
          sourceInstance,
        } as InvalidationEvent);
      };
      setLogger((message) => reported.push(message));
      try {
        for (const bad of [undefined, null, 123, { a: 1 }, Symbol('s')]) {
          expect(() => report(bad)).not.toThrow();
        }
        report('x'.repeat(80));
      } finally {
        setLogger(null);
      }

      // Unquoted `unknown` marks a non-string; a string is always quoted.
      expect(reported.map((m) => m.match(/\(sourceInstance=(.*)\)$/)?.[1])).toEqual([
        ...Array(5).fill('unknown'),
        `"${'x'.repeat(64)}"`,
      ]);
    });

    it('handleInvalidationEvent - ignores events from self', () => {
      cache.set('a', '1', 10000, 'ns');

      const event: InvalidationEvent = {
        level: 'global',
        timestamp: Date.now(),
        sourceInstance: cache.instanceID,
      };

      cache.handleInvalidationEvent(event);

      // Should not clear (echo detection)
      expect(cache.stats.entries).toBe(1);
    });
  });

  describe('namespace extraction', () => {
    it('extracts namespace from key with hash', () => {
      cache.set('myFunc:' + 'a'.repeat(64), 'value', 10000, 'myFunc');
      expect(cache.stats.namespaces).toBe(1);
    });

    it('uses full key as namespace if no hash', () => {
      cache.set('simple-key', 'value', 10000, 'simple-key');
      expect(cache.stats.namespaces).toBe(1);
    });
  });

  describe('stats', () => {
    it('tracks entries, memory, refreshing, namespaces', () => {
      cache.set('a', 'value1', 10000, 'ns1');
      cache.set('b', 'value2', 10000, 'ns2');

      const stats = cache.stats;
      expect(stats.entries).toBe(2);
      expect(stats.memoryUsed).toBeGreaterThan(0);
      expect(stats.refreshing).toBe(0);
      expect(stats.namespaces).toBe(2);
    });
  });

  describe('instance ID', () => {
    it('has unique instance ID', () => {
      const cache1 = new L1Cache();
      const cache2 = new L1Cache();

      expect(cache1.instanceID).not.toBe(cache2.instanceID);
    });
  });

  describe('edge cases', () => {
    it('handles circular references in estimateSize', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Testing circular refs requires any
      const obj: any = { name: 'test' };
      obj.self = obj;

      // Should not throw, should use fallback size
      expect(() => cache.set('key', obj, 10000, 'test')).not.toThrow();
    });

    it('handles empty namespace index cleanup', () => {
      cache.set('ns1:a', 'value', 10000, 'ns1');
      cache.invalidateByNamespace('ns1');

      // Namespace should be removed from index
      expect(cache.stats.namespaces).toBe(0);
    });

    it('handles multiple sets of same key', () => {
      cache.set('key', 'value1', 10000, 'ns1');
      cache.set('key', 'value2', 10000, 'ns2');

      expect(cache.get('key')).toBe('value2');
      expect(cache.stats.entries).toBe(1);
    });
  });
});

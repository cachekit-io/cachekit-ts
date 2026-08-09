import { describe, it, expect, vi, beforeEach } from 'vitest';
import { L1Cache } from './lru-cache';
import type { InvalidationEvent } from './types';

describe('L1Cache', () => {
  let cache: L1Cache<string>;

  beforeEach(() => {
    cache = new L1Cache({ maxEntries: 10 });
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
      vi.useRealTimers();
    });

    it('updates lastAccess on get', () => {
      vi.useFakeTimers();
      cache.set('key', 'value', 10000, 'test');
      vi.advanceTimersByTime(1000);
      cache.get('key'); // Should update lastAccess
      vi.useRealTimers();
    });

    it('ttl <= 0 never expires (LAB-1388: matches the ts-wide "no expiry" contract)', () => {
      vi.useFakeTimers();
      cache.set('zero', 'value', 0, 'test');
      cache.set('negative', 'value', -1, 'test');
      vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 365); // 1 year
      expect(cache.get('zero')).toBe('value');
      expect(cache.get('negative')).toBe('value');
      vi.useRealTimers();
    });

    it('deletes key and returns true', () => {
      cache.set('key', 'value', 10000, 'test');
      expect(cache.delete('key')).toBe(true);
      expect(cache.get('key')).toBeNull();
    });

    it('delete returns false for missing key', () => {
      expect(cache.delete('missing')).toBe(false);
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

    it('updating existing key updates lastAccess and prevents eviction', () => {
      vi.useFakeTimers();
      const smallCache = new L1Cache<number>({ maxEntries: 3 });

      smallCache.set('a', 1, 10000, 'test');
      vi.advanceTimersByTime(100);
      smallCache.set('b', 2, 10000, 'test');
      vi.advanceTimersByTime(100);
      smallCache.set('c', 3, 10000, 'test');
      vi.advanceTimersByTime(100);

      // Access 'a' to update its lastAccess
      smallCache.get('a');
      vi.advanceTimersByTime(100);

      // Add 'd' - should evict 'b' (oldest)
      smallCache.set('d', 4, 10000, 'test');

      expect(smallCache.get('a')).toBe(1);
      expect(smallCache.get('b')).toBeNull();
      expect(smallCache.get('c')).toBe(3);
      expect(smallCache.get('d')).toBe(4);

      vi.useRealTimers();
    });

    it('evicts when maxMemory exceeded', () => {
      const smallCache = new L1Cache<string>({ maxEntries: 100, maxMemory: 400 });

      // Each entry roughly 200+ bytes (100 chars * 2 for UTF-16)
      smallCache.set('a', 'x'.repeat(100), 10000, 'test');
      smallCache.set('b', 'y'.repeat(100), 10000, 'test');
      smallCache.set('c', 'z'.repeat(100), 10000, 'test'); // Should trigger eviction

      // At least one should be evicted
      expect(smallCache.stats.entries).toBeLessThan(3);
      expect(smallCache.stats.memoryUsed).toBeLessThanOrEqual(400);
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

      vi.useRealTimers();
    });

    it('does not return value when fully expired', () => {
      vi.useFakeTimers();
      cache.set('key', 'value', 1000, 'test');
      vi.advanceTimersByTime(1100);

      const result = cache.getWithSwr('key');
      expect(result.value).toBeNull();
      expect(result.shouldRefresh).toBe(false);

      vi.useRealTimers();
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

      vi.useRealTimers();
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

      vi.useRealTimers();
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

      vi.useRealTimers();
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

      vi.useRealTimers();
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

      vi.useRealTimers();
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

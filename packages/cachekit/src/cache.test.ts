import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCache } from './cache.js';
import { generateKey } from './serialization/key-generator.js';
import type { SecureCache } from './types/cache.js';
import type { Backend } from './backends/types.js';

/**
 * Simple in-memory backend for testing cache integration.
 *
 * NOTE: All tests that don't explicitly set `compression: false` exercise ByteStorage
 * compression by default (CacheOptions.compression defaults to true). This is intentional —
 * it ensures the compression pipeline is continuously validated across all cache operations.
 */
class InMemoryBackend implements Backend {
  private store = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: Uint8Array, _ttl: number): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

describe('Cache Integration', () => {
  let cache: SecureCache;
  let backend: InMemoryBackend;

  beforeEach(() => {
    backend = new InMemoryBackend();
    cache = createCache({
      backend,
      defaultTtl: 3600,
      l1: { enabled: true, maxEntries: 100 },
    });
  });

  afterEach(async () => {
    await cache.close();
  });

  describe('Basic Operations', () => {
    it('should set and get values', async () => {
      await cache.set('test:key', { data: 'value' });
      const result = await cache.get<{ data: string }>('test:key');

      expect(result).toEqual({ data: 'value' });
    });

    it('should return null for missing keys', async () => {
      const result = await cache.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should delete keys', async () => {
      await cache.set('test:delete', 'value');
      const deleted = await cache.delete('test:delete');
      const result = await cache.get('test:delete');

      expect(deleted).toBe(true);
      expect(result).toBeNull();
    });

    it('should check key existence', async () => {
      await cache.set('test:exists', 'value');

      expect(await cache.exists('test:exists')).toBe(true);
      expect(await cache.exists('test:nonexistent')).toBe(false);
    });
  });

  describe('Function Wrapping', () => {
    it('should cache function results', async () => {
      let callCount = 0;
      const expensiveFn = async (id: number) => {
        callCount++;
        return { id, data: `result-${id}` };
      };

      const cached = cache.wrap(expensiveFn, {
        namespace: 'test:fn',
        ttl: 3600,
      });

      // First call - should execute
      const result1 = await cached(123);
      expect(result1).toEqual({ id: 123, data: 'result-123' });
      expect(callCount).toBe(1);

      // Second call - should use cache
      const result2 = await cached(123);
      expect(result2).toEqual({ id: 123, data: 'result-123' });
      expect(callCount).toBe(1); // No additional call

      // Different args - should execute again
      const result3 = await cached(456);
      expect(result3).toEqual({ id: 456, data: 'result-456' });
      expect(callCount).toBe(2);
    });

    it('should support with() for partial application', async () => {
      const dbFetch = async (id: number) => ({ id, name: `user-${id}` });

      const cachedUser = cache.with({ namespace: 'users', ttl: 3600 });
      const getUser = cachedUser(dbFetch);

      const result = await getUser(789);
      expect(result).toEqual({ id: 789, name: 'user-789' });
    });
  });

  describe('L1 Cache Integration', () => {
    it('should populate L1 on get', async () => {
      await cache.set('test:l1', 'value');

      // First get populates L1
      await cache.get('test:l1');

      // Clear backend, verify L1 still has it
      await backend.delete('test:l1');
      const result = await cache.get('test:l1');

      expect(result).toBe('value'); // From L1
    });
  });

  describe('Invalidation', () => {
    it('should invalidate by key', async () => {
      await cache.set('test:invalidate', 'value');

      // First get populates L1
      await cache.get('test:invalidate');

      // Invalidate L1
      await cache.invalidate('params', { key: 'test:invalidate' });

      // Delete from backend too, then verify not in L1
      await backend.delete('test:invalidate');
      const result = await cache.get('test:invalidate');
      expect(result).toBeNull();
    });

    it('should invalidate by namespace', async () => {
      await cache.set('ns:key1', 'value1', { namespace: 'ns' });
      await cache.set('ns:key2', 'value2', { namespace: 'ns' });

      await cache.invalidate('namespace', { namespace: 'ns' });

      // L1 should be cleared for namespace entries
      // Note: Backend still has data, but L1 is invalidated
    });

    it('should invalidate all', async () => {
      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');

      await cache.invalidate('global');

      // L1 should be completely cleared
    });
  });

  describe('Encryption Integration', () => {
    it('should encrypt and decrypt values when encryption enabled', async () => {
      const encryptedCache = createCache({
        backend: new InMemoryBackend(),
        encryption: {
          masterKey: '0'.repeat(64), // 32 bytes hex
          tenantId: 'test-tenant',
        },
      });

      await encryptedCache.set('secure:key', { sensitive: 'data' });
      const result = await encryptedCache.get<{ sensitive: string }>('secure:key');

      expect(result).toEqual({ sensitive: 'data' });

      await encryptedCache.close();
    });
  });

  describe('Reliability Integration', () => {
    it('should apply retry on backend failures', async () => {
      let attempts = 0;
      const testBackend = new InMemoryBackend();

      const flakeyBackend: Backend = {
        async get(key: string) {
          attempts++;
          if (attempts < 2) {
            throw new Error('Transient failure');
          }
          return testBackend.get(key);
        },
        async set(key: string, value: Uint8Array, ttl: number) {
          return testBackend.set(key, value, ttl);
        },
        async delete(key: string) {
          return testBackend.delete(key);
        },
        async exists(key: string) {
          return testBackend.exists(key);
        },
        async close() {
          return testBackend.close();
        },
      };

      const retryCache = createCache({
        backend: flakeyBackend,
        reliability: {
          retry: { maxAttempts: 3, baseDelayMs: 10 },
        },
        l1: { enabled: false }, // Disable L1 to force backend access
      });

      await retryCache.set('test:retry', 'value');
      const result = await retryCache.get('test:retry');

      expect(result).toBe('value');
      expect(attempts).toBe(2); // First failed, second succeeded

      await retryCache.close();
    });
  });

  describe('Compression (ByteStorage)', () => {
    it('should round-trip with compression enabled (default)', async () => {
      const compressedCache = createCache({
        backend: new InMemoryBackend(),
        l1: { enabled: false },
      });

      const payload = { data: 'a'.repeat(1000) }; // Compressible
      await compressedCache.set('test:compressed', payload);
      const result = await compressedCache.get<typeof payload>('test:compressed');

      expect(result).toEqual(payload);
      await compressedCache.close();
    });

    it('should round-trip with compression disabled', async () => {
      const uncompressedCache = createCache({
        backend: new InMemoryBackend(),
        compression: false,
        l1: { enabled: false },
      });

      await uncompressedCache.set('test:uncompressed', { data: 'value' });
      const result = await uncompressedCache.get<{ data: string }>('test:uncompressed');

      expect(result).toEqual({ data: 'value' });
      await uncompressedCache.close();
    });

    it('should produce smaller output for compressible data', async () => {
      const compressedBackend = new InMemoryBackend();
      const uncompressedBackend = new InMemoryBackend();

      const compressedCache = createCache({
        backend: compressedBackend,
        compression: true,
        l1: { enabled: false },
      });
      const uncompressedCache = createCache({
        backend: uncompressedBackend,
        compression: false,
        l1: { enabled: false },
      });

      // Highly compressible: repeated data
      const payload = { data: 'hello world '.repeat(500) };
      await compressedCache.set('test:key', payload);
      await uncompressedCache.set('test:key', payload);

      const compressedBytes = await compressedBackend.get('test:key');
      const uncompressedBytes = await uncompressedBackend.get('test:key');

      expect(compressedBytes).not.toBeNull();
      expect(uncompressedBytes).not.toBeNull();
      expect(compressedBytes!.length).toBeLessThan(uncompressedBytes!.length);

      await compressedCache.close();
      await uncompressedCache.close();
    });

    it('should round-trip with compression + encryption', async () => {
      const cache = createCache({
        backend: new InMemoryBackend(),
        compression: true,
        encryption: {
          masterKey: '0'.repeat(64),
          tenantId: 'test-tenant',
        },
        l1: { enabled: false },
      });

      const payload = { sensitive: 'data', repeated: 'x'.repeat(500) };
      await cache.set('secure:key', payload);
      const result = await cache.get<typeof payload>('secure:key');

      expect(result).toEqual(payload);
      await cache.close();
    });

    it('should round-trip with encryption only (no compression)', async () => {
      const cache = createCache({
        backend: new InMemoryBackend(),
        compression: false,
        encryption: {
          masterKey: '0'.repeat(64),
          tenantId: 'test-tenant',
        },
        l1: { enabled: false },
      });

      await cache.set('secure:key', { data: 'value' });
      const result = await cache.get<{ data: string }>('secure:key');

      expect(result).toEqual({ data: 'value' });
      await cache.close();
    });
  });

  describe('Compression Error Handling', () => {
    it('should return null when backend returns corrupted compressed data (graceful degradation)', async () => {
      const corruptBackend = new InMemoryBackend();
      const cache = createCache({
        backend: corruptBackend,
        compression: true,
        l1: { enabled: false },
      });

      // Write valid data
      await cache.set('test:key', { data: 'value' });

      // Corrupt the stored bytes
      const stored = await corruptBackend.get('test:key');
      expect(stored).not.toBeNull();
      const corrupted = new Uint8Array(stored!);
      corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
      await corruptBackend.set('test:key', corrupted, 3600);

      // ReliabilityExecutor catches the unpack error and degrades to null (cache miss)
      const result = await cache.get('test:key');
      expect(result).toBeNull();
      await cache.close();
    });

    it('should return null when reading compressed data with compression disabled (mismatch)', async () => {
      const sharedBackend = new InMemoryBackend();

      // Write with compression enabled
      const writer = createCache({
        backend: sharedBackend,
        compression: true,
        l1: { enabled: false },
      });
      await writer.set('test:mismatch', { data: 'compressed' });
      await writer.close();

      // Read with compression disabled — ByteStorage envelope hits serializer.decode()
      // which fails (envelope structure doesn't match expected types), caught by
      // ReliabilityExecutor → degrades to null (cache miss).
      // KNOWN LIMITATION: compression config must be consistent within a deployment.
      const reader = createCache({
        backend: sharedBackend,
        compression: false,
        l1: { enabled: false },
      });
      const result = await reader.get('test:mismatch');
      expect(result).toBeNull();
      await reader.close();
    });
  });

  describe('Error Handling', () => {
    it('should throw when using closed cache', async () => {
      await cache.close();

      await expect(cache.get('test')).rejects.toThrow('Cache has been closed');
      await expect(cache.set('test', 'value')).rejects.toThrow('Cache has been closed');
      await expect(cache.delete('test')).rejects.toThrow('Cache has been closed');
    });
  });

  describe('SWR refresh persistence (L2-only setEntry + version-guarded L1)', () => {
    // The SWR refresh persists through setEntry with updateL1=false: the
    // ONLY L1 writer on the refresh path is completeRefresh, whose version
    // token discards the refresh when an explicit write landed meanwhile.
    // swrThresholdRatio: 2 makes every live L1 entry deterministically
    // stale (threshold ≥ 1.8×ttl > remaining TTL) — no clock control.

    /** Backend whose Nth set() call blocks on a gate (1-indexed). */
    class GatedBackend extends InMemoryBackend {
      setCount = 0;
      constructor(
        private readonly gatedCall: number,
        private readonly gate: Promise<void>
      ) {
        super();
      }
      override async set(key: string, value: Uint8Array, ttl: number): Promise<void> {
        this.setCount++;
        if (this.setCount === this.gatedCall) await this.gate;
        return super.set(key, value, ttl);
      }
    }

    it('completes a refresh via completeRefresh: L1 and L2 both end up with the new value', async () => {
      const swrBackend = new InMemoryBackend();
      const swrCache = createCache({
        backend: swrBackend,
        defaultTtl: 60,
        l1: { swrEnabled: true, swrThresholdRatio: 2 },
      });

      let calls = 0;
      const fn = swrCache.wrap(
        async () => {
          calls++;
          return { gen: calls };
        },
        { namespace: 'swr:persist', ttl: 60 }
      );

      expect(await fn()).toEqual({ gen: 1 }); // cold miss
      expect(await fn()).toEqual({ gen: 1 }); // stale hit, schedules refresh

      // completeRefresh is what lands gen 2 in L1 (plain get() does no SWR
      // read, so this observes L1 without scheduling more refreshes).
      const cacheKey = generateKey('swr:persist', []);
      await vi.waitFor(async () => {
        expect(await swrCache.get(cacheKey)).toEqual({ gen: 2 });
      });

      // And the refresh persisted to L2: a second cache on the same
      // backend with L1 disabled decodes the L2 bytes directly.
      const l2View = createCache({ backend: swrBackend, defaultTtl: 60, l1: { enabled: false } });
      expect(await l2View.get(cacheKey)).toEqual({ gen: 2 });
      await l2View.close();
      await swrCache.close();
    });

    it('an explicit set() during an in-flight refresh wins in L1 (refresh L1 write discarded)', async () => {
      // Gate the refresh's L2 persist (2nd backend set: 1st = cold miss,
      // 2nd = refresh, 3rd = the explicit set) so the explicit write can
      // interleave between the refresh's L2 write and its L1 completion.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gatedBackend = new GatedBackend(2, gate);
      const swrCache = createCache({
        backend: gatedBackend,
        defaultTtl: 60,
        l1: { swrEnabled: true, swrThresholdRatio: 2 },
      });

      let calls = 0;
      const fn = swrCache.wrap(
        async () => {
          calls++;
          return { gen: calls };
        },
        { namespace: 'swr:race', ttl: 60 }
      );
      const cacheKey = generateKey('swr:race', []);

      expect(await fn()).toEqual({ gen: 1 }); // cold miss (set #1)
      expect(await fn()).toEqual({ gen: 1 }); // stale hit → refresh blocks in set #2

      await vi.waitFor(() => {
        expect(gatedBackend.setCount).toBe(2); // refresh is parked in its L2 write
      });

      // Explicit write lands while the refresh is in flight — bumps the L1
      // version token. Pre-#84, setEntry's unconditional L1 write on the
      // refresh path would clobber this with the stale-computed value.
      await swrCache.set(cacheKey, { gen: 999 }, { ttl: 60, namespace: 'swr:race' });

      release();

      // The refresh finishes: its completeRefresh sees the bumped version
      // and discards — the explicit write stays authoritative in L1.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await swrCache.get(cacheKey)).toEqual({ gen: 999 });

      await swrCache.close();
    });
  });
});

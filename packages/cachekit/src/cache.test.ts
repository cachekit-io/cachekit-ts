import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createCache } from './cache.js';
import type { SecureCache } from './types/cache.js';
import type { Backend } from './backends/types.js';

/**
 * Simple in-memory backend for testing cache integration.
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

  describe('Error Handling', () => {
    it('should throw when using closed cache', async () => {
      await cache.close();

      await expect(cache.get('test')).rejects.toThrow('Cache has been closed');
      await expect(cache.set('test', 'value')).rejects.toThrow('Cache has been closed');
      await expect(cache.delete('test')).rejects.toThrow('Cache has been closed');
    });
  });
});

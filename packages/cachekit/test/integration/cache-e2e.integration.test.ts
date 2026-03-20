import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createCache } from '../../src/cache';
import type { SecureCache } from '../../src/types/cache';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

describe.skipIf(!process.env.REDIS_URL)('Cache E2E Integration', () => {
  let cache: SecureCache;

  beforeAll(() => {
    cache = createCache({
      backend: { url: REDIS_URL, keyPrefix: `e2e:${Date.now()}:` },
      defaultTtl: 60,
      l1: { enabled: true, maxEntries: 100 },
    });
  });

  afterAll(async () => {
    await cache.close();
  });

  it('basic set/get/delete flow', async () => {
    await cache.set('user:123', { name: 'Alice', age: 30 });

    const user = await cache.get<{ name: string; age: number }>('user:123');
    expect(user).toEqual({ name: 'Alice', age: 30 });

    await cache.delete('user:123');
    expect(await cache.get('user:123')).toBeNull();
  });

  it('wrap caches function results', async () => {
    let callCount = 0;
    const expensive = async (id: number) => {
      callCount++;
      return { id, data: 'computed' };
    };

    const cached = cache.wrap(expensive, {
      namespace: 'test:expensive',
      ttl: 60,
    });

    // First call - computes
    const result1 = await cached(42);
    expect(result1).toEqual({ id: 42, data: 'computed' });
    expect(callCount).toBe(1);

    // Second call - from cache
    const result2 = await cached(42);
    expect(result2).toEqual({ id: 42, data: 'computed' });
    expect(callCount).toBe(1); // No additional call
  });
});

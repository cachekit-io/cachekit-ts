import { describe, it, expect, afterEach } from 'vitest';
import { createCache } from './cache.js';
import { ConfigurationError } from './errors.js';
import type { SecureCache } from './types/cache.js';
import type { Backend, LockableBackend } from './backends/types.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In-memory backend with operation counters. `gets` on a cold key is the
 * billed-miss count under metered-misses — the number these tests exist to
 * pin down (LAB-519).
 */
class CountingBackend implements Backend {
  store = new Map<string, Uint8Array>();
  gets = 0;
  sets = 0;

  async get(key: string): Promise<Uint8Array | null> {
    this.gets++;
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: Uint8Array, _ttl?: number): Promise<void> {
    this.sets++;
    this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async close(): Promise<void> {
    // Shared between cache instances in cross-process tests — keep the store.
  }
}

/** Lockable variant: single-holder lock table, compare-and-delete release. */
class CountingLockableBackend extends CountingBackend implements LockableBackend {
  acquires = 0;
  releases = 0;
  private readonly locks = new Map<string, string>();

  async acquireLock(key: string, _timeoutMs?: number): Promise<string | null> {
    this.acquires++;
    if (this.locks.has(key)) return null;
    const lockId = `lock-${this.acquires}`;
    this.locks.set(key, lockId);
    return lockId;
  }

  async releaseLock(key: string, lockId: string): Promise<boolean> {
    this.releases++;
    if (this.locks.get(key) !== lockId) return false;
    this.locks.delete(key);
    return true;
  }

  heldLocks(): number {
    return this.locks.size;
  }
}

describe('Cold-miss single-flight (LAB-519)', () => {
  const caches: SecureCache[] = [];

  const make = (options: Parameters<typeof createCache>[0]): SecureCache => {
    const cache = createCache(options);
    caches.push(cache);
    return cache;
  };

  afterEach(async () => {
    await Promise.all(caches.splice(0).map((c) => c.close()));
  });

  describe('in-process', () => {
    it('shares one L2 read, one compute, and one write across a concurrent cold herd', async () => {
      const backend = new CountingBackend();
      const cache = make({ backend, l1: { enabled: true } });

      let calls = 0;
      const wrapped = cache.wrap(
        async (id: number) => {
          calls++;
          await sleep(20);
          return `value-${id}`;
        },
        { namespace: 'sf:herd', ttl: 60 }
      );

      const results = await Promise.all(Array.from({ length: 10 }, () => wrapped(1)));

      expect(results).toEqual(Array.from({ length: 10 }, () => 'value-1'));
      expect(calls).toBe(1);
      expect(backend.gets).toBe(1); // 1 billed miss, not 10
      expect(backend.sets).toBe(1);
    });

    it('does not share flights across distinct keys', async () => {
      const backend = new CountingBackend();
      const cache = make({ backend, l1: { enabled: true } });

      let calls = 0;
      const wrapped = cache.wrap(
        async (id: number) => {
          calls++;
          await sleep(10);
          return id;
        },
        { namespace: 'sf:keys', ttl: 60 }
      );

      const [a, b] = await Promise.all([wrapped(1), wrapped(2)]);

      expect(a).toBe(1);
      expect(b).toBe(2);
      expect(calls).toBe(2);
    });

    it('evicts the flight after it settles so later calls read the cache', async () => {
      const backend = new CountingBackend();
      const cache = make({ backend, l1: { enabled: false } });

      let calls = 0;
      const wrapped = cache.wrap(
        async () => {
          calls++;
          return 'once';
        },
        { namespace: 'sf:settle', ttl: 60 }
      );

      await wrapped();
      const second = await wrapped();

      expect(second).toBe('once');
      expect(calls).toBe(1);
      expect(backend.gets).toBe(2); // second call is its own flight: L2 hit
    });

    it('rejects every herd member on failure, then retries fresh on the next call', async () => {
      const backend = new CountingBackend();
      const cache = make({ backend, l1: { enabled: true } });

      let calls = 0;
      const wrapped = cache.wrap(
        async () => {
          calls++;
          await sleep(10);
          if (calls === 1) throw new Error('upstream down');
          return 'recovered';
        },
        { namespace: 'sf:err', ttl: 60 }
      );

      const herd = await Promise.allSettled(Array.from({ length: 5 }, () => wrapped()));

      expect(herd.every((r) => r.status === 'rejected')).toBe(true);
      expect(calls).toBe(1); // one shared failure, not five

      // Rejected flight must not be cached: next call recomputes.
      await expect(wrapped()).resolves.toBe('recovered');
      expect(calls).toBe(2);
    });
  });

  describe('cross-process distributed lock (opt-in)', () => {
    const lockOptions = { distributedLock: true, lockWaitMs: 2000, lockPollMs: 10 };

    it('contested process waits on the lock and picks up the winner’s write instead of recomputing', async () => {
      // Two cache instances sharing one backend = two processes sharing L2.
      const backend = new CountingLockableBackend();
      const cache1 = make({ backend, l1: { enabled: false }, stampede: lockOptions });
      const cache2 = make({ backend, l1: { enabled: false }, stampede: lockOptions });

      let calls = 0;
      const slow = async (id: number): Promise<string> => {
        calls++;
        await sleep(100);
        return `result-${id}`;
      };
      const w1 = cache1.wrap(slow, { namespace: 'sf:fleet', ttl: 60 });
      const w2 = cache2.wrap(slow, { namespace: 'sf:fleet', ttl: 60 });

      const [a, b] = await Promise.all([w1(7), w2(7)]);

      expect(a).toBe('result-7');
      expect(b).toBe('result-7');
      expect(calls).toBe(1); // loser's post-grant double-check hit the winner's write
      expect(backend.sets).toBe(1);
      expect(backend.heldLocks()).toBe(0); // both sides released
      expect(backend.releases).toBeGreaterThanOrEqual(1);
    });

    it('computes anyway when the holder never fills the cache (stampede fallthrough)', async () => {
      class NeverGrantsBackend extends CountingBackend implements LockableBackend {
        async acquireLock(): Promise<string | null> {
          return null; // permanently contested (e.g. holder crashed, lease outlives our wait)
        }
        async releaseLock(): Promise<boolean> {
          return false;
        }
      }

      const backend = new NeverGrantsBackend();
      const cache = make({
        backend,
        l1: { enabled: false },
        stampede: { distributedLock: true, lockWaitMs: 100, lockPollMs: 20 },
      });

      let calls = 0;
      const wrapped = cache.wrap(
        async () => {
          calls++;
          return 'computed-anyway';
        },
        { namespace: 'sf:fallthrough', ttl: 60 }
      );

      await expect(wrapped()).resolves.toBe('computed-anyway');
      expect(calls).toBe(1);
    });

    it('degrades to computing without the lock when acquireLock throws', async () => {
      class BrokenLockBackend extends CountingBackend implements LockableBackend {
        async acquireLock(): Promise<string | null> {
          throw new Error('lock endpoint unreachable');
        }
        async releaseLock(): Promise<boolean> {
          return false;
        }
      }

      const backend = new BrokenLockBackend();
      const cache = make({ backend, l1: { enabled: false }, stampede: lockOptions });

      let calls = 0;
      const wrapped = cache.wrap(
        async () => {
          calls++;
          return 'still-works';
        },
        { namespace: 'sf:broken-lock', ttl: 60 }
      );

      await expect(wrapped()).resolves.toBe('still-works');
      expect(calls).toBe(1);
      expect(backend.sets).toBe(1);
    });

    it('releases the lock even when the compute throws', async () => {
      const backend = new CountingLockableBackend();
      const cache = make({ backend, l1: { enabled: false }, stampede: lockOptions });

      const wrapped = cache.wrap(
        async () => {
          throw new Error('compute failed');
        },
        { namespace: 'sf:release-on-error', ttl: 60 }
      );

      await expect(wrapped()).rejects.toThrow('compute failed');
      expect(backend.heldLocks()).toBe(0);
    });

    it('rejects distributedLock on a backend without lock capability', () => {
      expect(() =>
        createCache({
          backend: new CountingBackend(),
          stampede: { distributedLock: true },
        })
      ).toThrow(ConfigurationError);
    });

    it('rejects invalid stampede timing config', () => {
      expect(() =>
        createCache({ backend: new CountingBackend(), stampede: { lockPollMs: 0 } })
      ).toThrow(ConfigurationError);
      expect(() =>
        createCache({ backend: new CountingBackend(), stampede: { lockTimeoutMs: -1 } })
      ).toThrow(ConfigurationError);
      expect(() =>
        createCache({ backend: new CountingBackend(), stampede: { lockWaitMs: Infinity } })
      ).toThrow(ConfigurationError);
    });
  });
});

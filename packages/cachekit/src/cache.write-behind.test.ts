/**
 * Write-behind (`writeBehind: true`, opt-in): a wrap() cold miss returns once
 * its value is in L1, and its L2 write finishes in the background. These pin
 * the call shape both ways, the per-key ordering of later writes and deletes
 * behind a pending write, the close() drain, the lock path and the queue
 * bound, and that a failed background write is logged and counted.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCache } from './cache.js';
import { CacheImpl } from './cache-core.js';
import { ConfigurationError } from './errors.js';
import { setLogger } from './logger.js';
import type { Backend, LockableBackend } from './backends/types.js';
import type { CacheOptions, SecureCache } from './types/cache.js';
import type { MetricsCollector } from './metrics/prometheus.js';

const MASTER_KEY = createHash('sha256').update('cachekit write-behind test fixture').digest('hex');

/**
 * In-memory backend that logs each operation when it completes, so the log
 * at the moment wrap() returns is the set of requests the caller waited for.
 * While `hold` is set, every set() waits for it.
 */
class GatedBackend implements Backend {
  store = new Map<string, Uint8Array>();
  log: string[] = [];
  setKeys: string[] = [];
  gets = 0;
  hold: Promise<void> | null = null;
  private release: (() => void) | null = null;

  gate(): void {
    this.hold = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  open(): void {
    this.release?.();
    this.hold = null;
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.gets++;
    const value = this.store.get(key) ?? null;
    this.log.push('get');
    return value;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.setKeys.push(key);
    if (this.hold) await this.hold;
    this.store.set(key, value);
    this.log.push('set');
  }

  async delete(key: string): Promise<boolean> {
    const had = this.store.delete(key);
    this.log.push('delete');
    return had;
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async close(): Promise<void> {
    this.log.push('close');
  }
}

class GatedLockableBackend extends GatedBackend implements LockableBackend {
  async acquireLock(): Promise<string | null> {
    this.log.push('acquire');
    return 'lock-1';
  }

  async releaseLock(): Promise<boolean> {
    this.log.push('release');
    return true;
  }
}

/** Let every queued promise reaction run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Swap the cache's metrics collector for one whose recordOperation is a spy. */
function spyRecordOperation(cache: SecureCache) {
  const recordOperation = vi.fn(async () => {});
  const holder = cache as unknown as { metrics: MetricsCollector };
  holder.metrics = { ...holder.metrics, recordOperation };
  return recordOperation;
}

const outcomes = (cache: SecureCache): { l1Hits: number; l2Hits: number; misses: number } =>
  (cache as unknown as { telemetry: { l1Hits: number; l2Hits: number; misses: number } }).telemetry;

describe('write-behind', () => {
  const caches: SecureCache[] = [];
  const make = (options: CacheOptions): SecureCache => {
    const cache = createCache(options);
    caches.push(cache);
    return cache;
  };

  afterEach(async () => {
    setLogger(null);
    vi.restoreAllMocks();
    await Promise.all(caches.splice(0).map((c) => c.close()));
  });

  const counted = (cache: SecureCache, writeBehind: boolean, namespace = 'wb:fn') => {
    const counter = { calls: 0 };
    const wrapped = cache.wrap(
      async (id: number) => {
        counter.calls++;
        return { id, call: counter.calls };
      },
      { namespace, ttl: 60, writeBehind }
    );
    return { wrapped, counter };
  };

  describe('call shape', () => {
    it.each([undefined, false])(
      'off (writeBehind: %s): a cold miss waits for the GET and the PUT',
      async (writeBehind) => {
        const backend = new GatedBackend();
        const cache = make({ backend });
        const fn = cache.wrap(async (id: number) => id, {
          namespace: 'wb:default',
          ttl: 60,
          writeBehind,
        });

        await fn(1);
        expect(backend.log).toEqual(['get', 'set']);
      }
    );

    it('on: a cold miss returns after the GET, and the PUT lands afterwards', async () => {
      const backend = new GatedBackend();
      backend.gate();
      const cache = make({ backend });
      const { wrapped, counter } = counted(cache, true);

      await expect(wrapped(1)).resolves.toEqual({ id: 1, call: 1 });
      expect(backend.log).toEqual(['get']); // the PUT is started, not awaited
      expect(backend.setKeys).toHaveLength(1);

      // Served from L1 while the PUT is pending: no recompute, no second GET.
      await expect(wrapped(1)).resolves.toEqual({ id: 1, call: 1 });
      expect(counter.calls).toBe(1);
      expect(backend.gets).toBe(1);

      backend.open();
      await settle();
      expect(backend.log).toEqual(['get', 'set']);
      expect(backend.store.size).toBe(1);
      expect(outcomes(cache)).toEqual({ l1Hits: 1, l2Hits: 0, misses: 1 });
    });

    it('on, secure.wrap: L1 holds the ciphertext the background PUT sends', async () => {
      const backend = new GatedBackend();
      backend.gate();
      const cache = make({ backend, encryption: { masterKey: MASTER_KEY } });
      const fn = cache.secure.wrap(async (id: number) => ({ id, payload: 'canary' }), {
        namespace: 'wb:secure',
        ttl: 60,
        writeBehind: true,
      });

      await expect(fn(2)).resolves.toEqual({ id: 2, payload: 'canary' });
      expect(backend.log).toEqual(['get']);
      await expect(fn(2)).resolves.toEqual({ id: 2, payload: 'canary' }); // L1 decrypt

      backend.open();
      await cache.close();
      const [stored] = [...backend.store.values()];
      expect(Buffer.from(stored).includes('canary')).toBe(false);
    });

    it('is refused at wrap time with degradation off', () => {
      const cache = make({ backend: new GatedBackend(), reliability: { degradation: false } });
      expect(() => counted(cache, true)).toThrow(ConfigurationError);
      expect(() => counted(cache, false)).not.toThrow();
    });
  });

  describe('ordering in this process', () => {
    it.each([
      ['delete', (cache: SecureCache, key: string) => cache.delete(key)],
      [
        'invalidate("params")',
        (cache: SecureCache, key: string) => cache.invalidate('params', { key }),
      ],
    ])('a %s issued after wrap() returns waits for the pending PUT', async (_name, remove) => {
      const backend = new GatedBackend();
      backend.gate();
      const cache = make({ backend });
      const { wrapped } = counted(cache, true);

      await wrapped(3);
      const [key] = backend.setKeys;
      const removed = remove(cache, key);
      await settle();
      expect(backend.log).toEqual(['get']); // the delete has not overtaken the PUT

      backend.open();
      await removed;
      expect(backend.log).toEqual(['get', 'set', 'delete']);
      expect(backend.store.has(key)).toBe(false); // not resurrected
    });

    it('a set() issued after wrap() returns lands last', async () => {
      const backend = new GatedBackend();
      backend.gate();
      const cache = make({ backend });
      const { wrapped } = counted(cache, true);

      await wrapped(4);
      const [key] = backend.setKeys;
      const explicit = cache.set(key, 'explicit', { ttl: 60 });
      await settle();
      expect(backend.setKeys).toHaveLength(1); // queued behind the pending PUT

      backend.open();
      await explicit;
      await expect(cache.get(key)).resolves.toBe('explicit');
      await cache.invalidate('global');
      await expect(cache.get(key)).resolves.toBe('explicit'); // from L2
    });
  });

  it('close() drains pending PUTs before the backend closes', async () => {
    const backend = new GatedBackend();
    backend.gate();
    const cache = make({ backend });
    const { wrapped } = counted(cache, true);

    await Promise.all([wrapped(1), wrapped(2), wrapped(3)]);
    const closing = cache.close();
    await settle();
    expect(backend.log).not.toContain('close');

    backend.open();
    await closing;
    expect(backend.log.filter((op) => op === 'set')).toHaveLength(3);
    expect(backend.log.at(-1)).toBe('close');
    expect(backend.store.size).toBe(3);
  });

  it('a second close() waits for the first one’s drain', async () => {
    const backend = new GatedBackend();
    backend.gate();
    const cache = make({ backend });
    const { wrapped } = counted(cache, true);

    await wrapped(1);
    let secondDone = false;
    const first = cache.close();
    const second = cache.close().then(() => {
      secondDone = true;
    });
    await settle();
    expect(secondDone).toBe(false);

    backend.open();
    await Promise.all([first, second]);
    expect(backend.log.slice(-2)).toEqual(['set', 'close']);
  });

  it('invalidate("params") evicts an L1 copy refilled while its delete waited', async () => {
    const backend = new GatedBackend();
    backend.gate();
    const cache = make({ backend });
    const { wrapped } = counted(cache, true);

    await wrapped(9);
    const [key] = backend.setKeys;
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const realDelete = backend.delete.bind(backend);
    backend.delete = async (k) => {
      await deleteGate;
      return realDelete(k);
    };

    const invalidated = cache.invalidate('params', { key });
    backend.open(); // the PUT lands; the delete is sent and held
    await settle();
    // A read in this window misses L1 and refills it from L2.
    await expect(cache.get(key)).resolves.toEqual({ id: 9, call: 1 });
    releaseDelete();
    await invalidated;
    expect(backend.store.has(key)).toBe(false);
    await expect(cache.get(key)).resolves.toBeNull();
  });

  it('on Workers, a wait behind a pending write that never settles is capped', async () => {
    vi.useFakeTimers();
    try {
      const backend = new GatedBackend();
      backend.gate(); // never opened: a write workerd cancelled
      const cache = make({ backend });
      (cache as unknown as { swrRequiresWaitUntil: boolean }).swrRequiresWaitUntil = true;
      const view = (cache as CacheImpl).withExecutionContext({ waitUntil: () => {} });
      const fn = view.wrap(async (id: number) => id, {
        namespace: 'wb:cap',
        ttl: 60,
        writeBehind: true,
      });

      await fn(1);
      const [key] = backend.setKeys;
      let deleted = false;
      const removed = cache.delete(key).then(() => {
        deleted = true;
      });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(deleted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await removed;
      expect(backend.log).toContain('delete');

      const closing = cache.close();
      await vi.advanceTimersByTimeAsync(30_000);
      await closing;
      expect(backend.log.at(-1)).toBe('close');
    } finally {
      vi.useRealTimers();
    }
  });

  it('with L1 off, a caller during the pending PUT misses L2, and that miss is counted', async () => {
    const backend = new GatedBackend();
    backend.gate();
    const cache = make({ backend, l1: { enabled: false } });
    const { wrapped, counter } = counted(cache, true);

    await wrapped(5);
    await wrapped(5); // the first PUT has not landed: a billed GET miss, a second compute
    expect(backend.gets).toBe(2);
    expect(counter.calls).toBe(2);
    expect(outcomes(cache)).toEqual({ l1Hits: 0, l2Hits: 0, misses: 2 });

    backend.open();
    await cache.close();
    expect(backend.log.filter((op) => op === 'set')).toHaveLength(2);
  });

  it('with stampede.distributedLock on, the PUT completes before the lock is released', async () => {
    const backend = new GatedLockableBackend();
    const cache = make({ backend, l1: { enabled: false }, stampede: { distributedLock: true } });
    const { wrapped } = counted(cache, true);
    backend.gate();

    let returned = false;
    const call = wrapped(6).then(() => {
      returned = true;
    });
    await settle();
    expect(backend.setKeys).toHaveLength(1);
    expect(backend.log).toEqual(['get', 'acquire']); // the lease outlives the pending PUT
    expect(returned).toBe(false);

    backend.open();
    await call;
    expect(backend.log).toEqual(['get', 'acquire', 'set', 'release']);
  });

  describe('queue bound', () => {
    it('the 65th pending write runs on the caller and the 64 before it do not', async () => {
      const backend = new GatedBackend();
      backend.gate();
      const cache = make({ backend });
      const { wrapped } = counted(cache, true);

      await Promise.all(Array.from({ length: 64 }, (_, i) => wrapped(i)));
      expect(backend.setKeys).toHaveLength(64);

      let returned = false;
      const overflow = wrapped(64).then(() => {
        returned = true;
      });
      await settle();
      expect(backend.setKeys).toHaveLength(65); // started, and the caller waits on it
      expect(returned).toBe(false);

      backend.open();
      await overflow;
      await cache.close();
      expect(backend.store.size).toBe(65);
    });

    it('a value over the byte bound writes on the caller', async () => {
      const backend = new GatedBackend();
      backend.gate();
      const cache = make({
        backend,
        compression: false,
        serializer: { maxEncodedSize: 32 * 1024 * 1024, maxDecodedSize: 32 * 1024 * 1024 },
      });
      const big = 'x'.repeat(16 * 1024 * 1024 + 1);
      const fn = cache.wrap(async () => big, { namespace: 'wb:big', ttl: 60, writeBehind: true });

      let returned = false;
      const call = fn().then(() => {
        returned = true;
      });
      await settle();
      expect(backend.setKeys).toHaveLength(1);
      expect(returned).toBe(false);

      backend.open();
      await call;
    });

    it('a write sent back to the caller still waits behind its key’s pending write', async () => {
      const backend = new GatedBackend();
      backend.gate();
      const cache = make({ backend, l1: { enabled: false } });
      const { wrapped, counter } = counted(cache, true);

      await wrapped(0); // key 0's PUT is pending
      const key0 = backend.setKeys[0];
      await Promise.all(Array.from({ length: 63 }, (_, i) => wrapped(i + 1)));

      // Key 0 again (L1 is off, so it misses and recomputes): the queue is
      // full, so this write is the caller's, and it waits behind key 0's PUT.
      const second = wrapped(0);
      await settle();
      expect(backend.setKeys.filter((k) => k === key0)).toHaveLength(1);

      backend.open();
      await expect(second).resolves.toEqual({ id: 0, call: counter.calls });
      await expect(cache.get(key0)).resolves.toEqual({ id: 0, call: counter.calls });
    });
  });

  describe('a failed background write', () => {
    it('is logged and counted, and the caller still gets its value', async () => {
      const logError = vi.fn();
      setLogger(logError);
      const backend = new GatedBackend();
      backend.set = async () => {
        throw new Error('PUT refused');
      };
      const cache = make({ backend });
      const recordOperation = spyRecordOperation(cache);
      const { wrapped } = counted(cache, true);

      await expect(wrapped(7)).resolves.toEqual({ id: 7, call: 1 });
      await settle();

      expect(recordOperation).toHaveBeenCalledWith('write_behind', 'error');
      const lines = logError.mock.calls.map((args) => args.join(' '));
      expect(lines.some((line) => line.includes('write-behind L2 write failed'))).toBe(true);
      expect(lines.join('\n')).not.toContain('PUT refused');
      // L1 keeps the value, as it keeps a degraded foreground write's.
      await expect(wrapped(7)).resolves.toEqual({ id: 7, call: 1 });
    });

    it('a landed write is counted as a success', async () => {
      const backend = new GatedBackend();
      const cache = make({ backend });
      const recordOperation = spyRecordOperation(cache);
      const { wrapped } = counted(cache, true);

      await wrapped(8);
      await settle();
      expect(recordOperation).toHaveBeenCalledWith('write_behind', 'success');
    });
  });

  describe('withExecutionContext', () => {
    it('registers the pending PUT with waitUntil', async () => {
      const backend = new GatedBackend();
      backend.gate();
      const cache = make({ backend });
      const registered: Promise<unknown>[] = [];
      const view = (cache as CacheImpl).withExecutionContext({
        waitUntil: (p) => registered.push(p),
      });
      const fn = view.wrap(async (id: number) => id, {
        namespace: 'wb:ctx',
        ttl: 60,
        writeBehind: true,
      });

      await fn(1);
      expect(registered).toHaveLength(1);
      let done = false;
      void registered[0].then(() => (done = true));
      await settle();
      expect(done).toBe(false);

      backend.open();
      await registered[0];
      expect(backend.log).toEqual(['get', 'set']);
    });

    it('writes on the caller when waitUntil throws (a stale ExecutionContext)', async () => {
      setLogger(() => {});
      const backend = new GatedBackend();
      const cache = make({ backend });
      const view = (cache as CacheImpl).withExecutionContext({
        waitUntil: () => {
          throw new Error('stale ctx');
        },
      });
      const fn = view.wrap(async (id: number) => id, {
        namespace: 'wb:stale',
        ttl: 60,
        writeBehind: true,
      });

      await fn(1);
      expect(backend.log).toEqual(['get', 'set']);
    });
  });
});

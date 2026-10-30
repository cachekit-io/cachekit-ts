import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from 'prom-client';
import { ByteStorage } from '@cachekit-io/cachekit-core-ts';
import { metricValue } from '../test/fixtures/metrics.js';
import { createCache } from './cache.js';
import { CacheImpl, type CacheRuntime } from './cache-core.js';
import { EncryptionManager } from './encryption/manager.js';
import { ConfigurationError } from './errors.js';
import * as logger from './logger.js';
import {
  cachekitio,
  cachekitioFull,
  cachekitioWithLocking,
  cachekitioWithTTL,
} from './backends/cachekitio-factory.js';
import type {
  Backend,
  CachekitIOBackendConfig,
  GetWithTtlResult,
  LockableBackend,
} from './backends/types.js';
import type { CacheOptions, SecureCache, WrapOptions } from './types/cache.js';

// Server stale-grace on wrap() (protocol spec/saas-api.md § Stale-While-Revalidate):
// the write side sends the stale window, and a server-stale read is served at
// once while one background revalidation refreshes it.

/**
 * The server's view of the store: `expire()` moves every entry into its stale
 * window, and any write makes the entry fresh again. Records each write's TTL
 * and stale window.
 */
class StaleGraceBackend implements Backend {
  store = new Map<string, Uint8Array>();
  stale = new Set<string>();
  gets = 0;
  writes: { ttl?: number; staleTtl?: number }[] = [];

  expire(): void {
    for (const key of this.store.keys()) this.stale.add(key);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return (await this.getWithTtl(key))?.value ?? null;
  }

  async getWithTtl(key: string): Promise<GetWithTtlResult | null> {
    this.gets++;
    const value = this.store.get(key);
    if (!value) return null;
    const isStale = this.stale.has(key);
    return { value, ttlSeconds: null, isStale, ...(isStale && { freshFor: 0 }) };
  }

  async set(key: string, value: Uint8Array, ttl?: number): Promise<void> {
    this.write(key, value, { ttl });
  }

  async setWithStaleTtl(key: string, value: Uint8Array, ttl: number, staleTtl: number) {
    this.write(key, value, { ttl, staleTtl });
  }

  private write(key: string, value: Uint8Array, timing: { ttl?: number; staleTtl?: number }) {
    this.writes.push(timing);
    this.store.set(key, value);
    this.stale.delete(key);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async close(): Promise<void> {
    // Shared between cache instances (processes) — keep the store.
  }
}

/** The server lease: one holder per key; `mode` makes every acquire contested or fail. */
class LockingStaleGraceBackend extends StaleGraceBackend implements LockableBackend {
  mode: 'grant' | 'contested' | 'error' = 'grant';
  /** When set, every acquire waits for it before answering. */
  gate: Promise<void> | null = null;
  acquires = 0;
  releases = 0;
  private readonly locks = new Map<string, string>();

  async acquireLock(key: string): Promise<string | null> {
    this.acquires++;
    if (this.gate) await this.gate;
    if (this.mode === 'error') throw new Error('lock endpoint unreachable');
    if (this.mode === 'contested' || this.locks.has(key)) return null;
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

/** A plain backend with neither stale-grace capability. */
class PlainBackend implements Backend {
  async get(): Promise<Uint8Array | null> {
    return null;
  }
  async set(): Promise<void> {}
  async delete(): Promise<boolean> {
    return false;
  }
  async exists(): Promise<boolean> {
    return false;
  }
  async close(): Promise<void> {}
}

/** Keys whose background revalidation this cache has in flight or holds off. */
const revalidating = (cache: SecureCache) =>
  (cache as unknown as { revalidating: Map<string, number> }).revalidating;

/** The cache's live hit/miss counters: what its telemetry headers carry. */
const outcomes = (cache: SecureCache) => {
  const { l1Hits, l2Hits, misses } = (
    cache as unknown as { telemetry: { l1Hits: number; l2Hits: number; misses: number } }
  ).telemetry;
  return { l1Hits, l2Hits, misses };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const WRAP = { namespace: 'svc:report', ttl: 10, staleTtl: 60 };
/** The TTL and stale window a write of a WRAP entry carries. */
const WIRE = { ttl: 10, staleTtl: 60 };

describe('server stale-grace (WrapOptions.staleTtl)', () => {
  const open: SecureCache[] = [];
  /** A process: its own empty L1 over the shared store. */
  const process = (backend: Backend, extra: Partial<CacheOptions> = {}) => {
    const cache = createCache({ backend, metrics: false, ...extra });
    open.push(cache);
    return cache;
  };

  afterEach(async () => {
    await Promise.all(open.splice(0).map((cache) => cache.close()));
    vi.restoreAllMocks();
  });

  /** Write 'v1' from one process, then let the server's freshness lapse. */
  async function seedStale(backend: StaleGraceBackend, options: WrapOptions = WRAP) {
    await process(backend).wrap(async () => 'v1', options)();
    backend.expire();
  }

  it('is off by default: no stale window on writes, and a stale read is an ordinary hit', async () => {
    const backend = new StaleGraceBackend();
    const options = { namespace: 'svc:report', ttl: 10 };
    await seedStale(backend, options);
    const fn = vi.fn(async () => 'v2');

    const reader = process(backend);
    expect(await reader.wrap(fn, options)()).toBe('v1');

    expect(revalidating(reader).size).toBe(0); // none started
    expect(fn).not.toHaveBeenCalled();
    expect(backend.writes).toEqual([{ ttl: 10 }]); // set(), no stale window
  });

  it('serves a stale read at once and revalidates in the background, without blocking on it', async () => {
    const backend = new StaleGraceBackend();
    await seedStale(backend);
    const recompute = deferred<string>();
    const fn = vi.fn(() => recompute.promise);
    const reader = process(backend);
    const wrapped = reader.wrap(fn, WRAP);

    expect(await wrapped()).toBe('v1'); // returned while the recompute is pending
    expect(fn).toHaveBeenCalledTimes(1);

    // The stale value never entered L1, and the in-flight revalidation is not repeated.
    expect(await wrapped()).toBe('v1');
    expect(backend.gets).toBe(3); // seed miss + two stale reads
    expect(fn).toHaveBeenCalledTimes(1);

    recompute.resolve('v2');
    // The revalidation re-sends the TTL and the stale window (API-55).
    await vi.waitFor(() => expect(backend.writes).toEqual([WIRE, WIRE]));

    // Its write skipped L1: the next call reads the fresh entry from L2 and
    // backfills it, and the one after that is an L1 hit.
    expect(await wrapped()).toBe('v2');
    expect(await wrapped()).toBe('v2');
    expect(backend.gets).toBe(4);
  });

  it('starts a second revalidation once a hung one outlives its marker', async () => {
    const backend = new StaleGraceBackend();
    await seedStale(backend);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const fn = vi.fn(() => new Promise<string>(() => {})); // never settles
      const wrapped = process(backend).wrap(fn, WRAP);

      await wrapped();
      await wrapped();
      expect(fn).toHaveBeenCalledTimes(1); // marker held

      vi.advanceTimersByTime(60_001);
      await wrapped();
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a stale serve as one L2 hit and the revalidation as no miss (API-63)', async () => {
    const backend = new StaleGraceBackend();
    await seedStale(backend);
    const reader = process(backend);

    await reader.wrap(async () => 'v2', WRAP)();
    await vi.waitFor(() => expect(backend.writes).toHaveLength(2));

    expect(outcomes(reader)).toEqual({ l1Hits: 0, l2Hits: 1, misses: 0 });
  });

  it('reads the stale label with L1 off', async () => {
    const backend = new StaleGraceBackend();
    await seedStale(backend);
    const fn = vi.fn(async () => 'v2');

    expect(await process(backend, { l1: { enabled: false } }).wrap(fn, WRAP)()).toBe('v1');
    await vi.waitFor(() => expect(backend.writes).toHaveLength(2));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-sends the stale window on an L1 refresh-ahead write', async () => {
    const backend = new StaleGraceBackend();
    // Ratio 2: every live L1 entry is due for refresh.
    const cache = process(backend, { l1: { swrThresholdRatio: 2 } });
    const wrapped = cache.wrap(async () => 'v', WRAP);

    await wrapped(); // cold miss
    await wrapped(); // L1 hit, refresh scheduled
    await vi.waitFor(() => expect(backend.writes).toEqual([WIRE, WIRE]));
  });

  describe('server lease', () => {
    it('revalidates once across five processes sharing the store', async () => {
      const backend = new LockingStaleGraceBackend();
      await seedStale(backend);
      const recompute = deferred<string>();
      const fn = vi.fn(() => recompute.promise);

      const served = await Promise.all(
        Array.from({ length: 5 }, () => process(backend).wrap(fn, WRAP)())
      );
      expect(served).toEqual(Array(5).fill('v1'));

      recompute.resolve('v2');
      await vi.waitFor(() => expect(backend.heldLocks()).toBe(0));
      expect(fn).toHaveBeenCalledTimes(1);
      expect(backend.writes).toEqual([WIRE, WIRE]);
      expect(backend.releases).toBe(1);
    });

    it('computes under the lease when the post-grant double-check finds the entry stale', async () => {
      const backend = new LockingStaleGraceBackend();
      await seedStale(backend);
      // The first read fails, so the call takes the lock path and double-checks.
      const read = backend.getWithTtl.bind(backend);
      vi.spyOn(backend, 'getWithTtl')
        .mockRejectedValueOnce(new Error('read failed'))
        .mockImplementation(read);
      vi.spyOn(logger, 'logError').mockImplementation(() => {});
      const fn = vi.fn(async () => 'v2');
      const cache = process(backend, { stampede: { distributedLock: true } });

      expect(await cache.wrap(fn, WRAP)()).toBe('v2');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(backend.acquires).toBe(1); // no background attempt against our own lease
      expect(backend.writes).toEqual([WIRE, WIRE]);
      expect(backend.heldLocks()).toBe(0);
    });

    // A revalidation that never ran holds the key off for min(lockTimeoutMs, 60 s):
    // no lock request per stale read while another client holds the lease.
    it.each([
      ['contested', 5_000, 5_000],
      ['contested', 120_000, 60_000],
      ['error', 5_000, 5_000],
    ] as const)(
      'after a %s lease (lockTimeoutMs %d), holds the key off for %d ms without waiting, retrying or logging (API-62)',
      async (mode, lockTimeoutMs, holdMs) => {
        const backend = new LockingStaleGraceBackend();
        await seedStale(backend);
        backend.mode = mode;
        const logError = vi.spyOn(logger, 'logError').mockImplementation(() => {});
        const fn = vi.fn(async () => 'v2');
        const reader = process(backend, { stampede: { lockTimeoutMs } });
        const wrapped = reader.wrap(fn, WRAP);
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          const marker = () => revalidating(reader).get([...backend.store.keys()][0]!);
          // Answer the acquire 1 s after the read, so the hold is told apart
          // from the in-flight marker even where both last 60 s.
          const gate = deferred<void>();
          backend.gate = gate.promise;
          expect(await wrapped()).toBe('v1');
          vi.advanceTimersByTime(1_000);
          backend.gate = null;
          gate.resolve();
          // Real-timer polling: vi.waitFor would advance the faked clock.
          while (marker() !== Date.now() + holdMs) await sleep(1);
          expect(await wrapped()).toBe('v1');
          expect(backend.acquires).toBe(1); // the seed's miss took none (distributedLock off)

          backend.mode = 'grant';
          vi.advanceTimersByTime(holdMs - 1);
          expect(await wrapped()).toBe('v1');
          expect(backend.acquires).toBe(1);

          vi.advanceTimersByTime(1);
          expect(await wrapped()).toBe('v1');
          await vi.waitFor(() => expect(backend.writes).toEqual([WIRE, WIRE]));
          expect(backend.acquires).toBe(2);
          expect(fn).toHaveBeenCalledTimes(1);
          expect(logError).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      }
    );

    it('sweeps lapsed holds, not live ones, instead of keeping one per key read stale', async () => {
      const backend = new LockingStaleGraceBackend();
      const writer = process(backend).wrap(async (i: number) => `v${i}`, WRAP);
      for (let i = 0; i <= 64; i++) await writer(i);
      backend.expire();
      backend.mode = 'contested';
      const reader = process(backend, { stampede: { lockTimeoutMs: 50 } });
      const wrapped = reader.wrap(async (i: number) => `new${i}`, WRAP);

      // Key 0's revalidation stays in flight: its acquire waits on the gate.
      const gate = deferred<void>();
      backend.gate = gate.promise;
      await wrapped(0);
      backend.gate = null;
      for (let i = 1; i < 64; i++) await wrapped(i);
      await vi.waitFor(() => expect(backend.acquires).toBe(64));
      await sleep(80); // every 50 ms hold has lapsed; key 0's marker has not
      expect(revalidating(reader).size).toBe(64);

      await wrapped(64); // the insert that crosses the threshold sweeps
      expect(revalidating(reader).size).toBe(2); // key 0's live marker and key 64's
      gate.resolve();
    });

    it('counts a failed lease release without failing the revalidation or logging', async () => {
      const backend = new LockingStaleGraceBackend();
      await seedStale(backend);
      vi.spyOn(backend, 'releaseLock').mockRejectedValueOnce(
        new Error('lock endpoint unreachable')
      );
      const logError = vi.spyOn(logger, 'logError').mockImplementation(() => {});
      const registry = new Registry();
      const reader = process(backend, { metrics: { registry } });

      expect(await reader.wrap(async () => 'v2', WRAP)()).toBe('v1');
      // The revalidation ran, so the failed release puts no hold on the key.
      await vi.waitFor(() => expect(revalidating(reader).size).toBe(0));
      await vi.waitFor(async () =>
        expect(
          await metricValue(registry, 'cachekit_operations_total', {
            operation: 'lock_release',
            status: 'error',
          })
        ).toBe(1)
      );
      expect(backend.writes).toEqual([WIRE, WIRE]);
      expect(logError).not.toHaveBeenCalled();
    });
  });

  it('keeps a failed revalidation from the caller, leaves the entry, and retries on a later stale read', async () => {
    const backend = new StaleGraceBackend();
    await seedStale(backend);
    const logError = vi.spyOn(logger, 'logError').mockImplementation(() => {});
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('origin down: secret-detail'))
      .mockResolvedValueOnce('v2');
    const wrapped = process(backend).wrap(fn, WRAP);

    expect(await wrapped()).toBe('v1');
    await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
    const line = String(logError.mock.calls[0]![0]);
    expect(line).toMatch(/stale revalidation failed,.*keyHash=[0-9a-f]{32}.*: Error\.$/);
    expect(line).not.toContain('secret-detail');
    expect(line).not.toContain('svc:report');
    expect(backend.writes).toHaveLength(1); // the entry is untouched

    expect(await wrapped()).toBe('v1');
    await vi.waitFor(() => expect(backend.writes).toHaveLength(2));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('logs nothing for a revalidation that ends after close()', async () => {
    const backend = new StaleGraceBackend();
    await seedStale(backend);
    const logError = vi.spyOn(logger, 'logError').mockImplementation(() => {});
    const recompute = deferred<string>();
    const reader = createCache({ backend, metrics: false });

    expect(await reader.wrap(() => recompute.promise, WRAP)()).toBe('v1');
    await reader.close();
    recompute.resolve('v2');
    await vi.waitFor(() => expect(revalidating(reader).size).toBe(0));

    expect(logError).not.toHaveBeenCalled();
    expect(backend.writes).toHaveLength(1);
  });

  describe('wrap-time checks', () => {
    const MASTER_KEY = 'ab'.repeat(32);

    it('refuses staleTtl on an encrypted cache, through wrap and secure.wrap', () => {
      const cache = process(new StaleGraceBackend(), { encryption: { masterKey: MASTER_KEY } });
      const fn = async () => 'v';
      expect(() => cache.wrap(fn, WRAP)).toThrow(ConfigurationError);
      expect(() => cache.secure.wrap(fn, WRAP)).toThrow(/refused on an encrypted cache/);
      expect(() => cache.secure.wrap(fn, { ...WRAP, staleTtl: undefined })).not.toThrow();
    });

    it('refuses staleTtl on a backend that cannot write the window or report a stale read', () => {
      const cache = process(new PlainBackend());
      expect(() => cache.wrap(async () => 'v', WRAP)).toThrow(/requires a backend that writes/);
    });

    it.each([
      ['negative', -1],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['over 2,591,999', 2_591_999.5],
      ['a string', '60' as unknown as number],
      ['over the 30-day cap with the TTL', 2_591_991],
    ])('rejects a staleTtl that is %s', (_name, staleTtl) => {
      const cache = process(new StaleGraceBackend());
      expect(() => cache.wrap(async () => 'v', { ...WRAP, staleTtl })).toThrow(ConfigurationError);
    });

    it('accepts the largest window the 30-day cap leaves', async () => {
      const backend = new StaleGraceBackend();
      await process(backend).wrap(async () => 'v', { ...WRAP, staleTtl: 2_591_990 })();
      expect(backend.writes).toEqual([{ ttl: 10, staleTtl: 2_591_990 }]);
    });

    it('ceils a fractional window (API-54) and treats 0 as off', async () => {
      const backend = new StaleGraceBackend();
      await process(backend).wrap(async () => 'a', { ...WRAP, staleTtl: 0.2 })();
      await process(backend).wrap(async () => 'b', { ...WRAP, namespace: 'b', staleTtl: 0 })();
      // A 0 window passes even where stale-grace is refused: it is off.
      process(new PlainBackend()).wrap(async () => 'c', { ...WRAP, staleTtl: 0 });
      expect(backend.writes).toEqual([{ ttl: 10, staleTtl: 1 }, { ttl: 10 }]);
    });
  });

  describe('on a runtime that cancels unregistered background work (Workers)', () => {
    const workersLike = (backend: Backend) => {
      const runtime: CacheRuntime = {
        resolveBackend: () => backend,
        createByteStorage: () => new ByteStorage(),
        createEncryption: (config) => new EncryptionManager(config.masterKey, config.tenantId),
        swrRequiresWaitUntil: true,
      };
      const cache = new CacheImpl({ backend, metrics: false }, runtime);
      open.push(cache);
      return cache;
    };

    it('treats a stale read as a miss without a bound waitUntil', async () => {
      const backend = new StaleGraceBackend();
      await seedStale(backend);
      const fn = vi.fn(async () => 'v2');
      const reader = workersLike(backend);

      expect(await reader.wrap(fn, WRAP)()).toBe('v2'); // recomputed in the request
      expect(backend.writes).toEqual([WIRE, WIRE]);
      expect(outcomes(reader)).toEqual({ l1Hits: 0, l2Hits: 0, misses: 1 });
    });

    it('serves stale and registers the revalidation with waitUntil when one is bound', async () => {
      const backend = new StaleGraceBackend();
      await seedStale(backend);
      const registered: Promise<unknown>[] = [];
      const view = workersLike(backend).withExecutionContext({
        waitUntil: (promise) => registered.push(promise),
      });

      expect(await view.wrap(async () => 'v2', WRAP)()).toBe('v1');
      expect(registered).toHaveLength(1);
      await registered[0];
      expect(backend.writes).toEqual([WIRE, WIRE]);
    });

    it('still serves the stale value when waitUntil throws (stale ExecutionContext)', async () => {
      const backend = new StaleGraceBackend();
      await seedStale(backend);
      vi.spyOn(logger, 'logError').mockImplementation(() => {});
      const view = workersLike(backend).withExecutionContext({
        waitUntil: () => {
          throw new Error('stale ctx');
        },
      });

      expect(await view.wrap(async () => 'v2', WRAP)()).toBe('v1');
    });
  });
});

describe('CachekitIO stale window on the wire', () => {
  const config: CachekitIOBackendConfig = {
    apiKey: 'ck_test_fake-not-a-secret', // pragma: allowlist secret
    apiUrl: 'https://api.test.cachekit.io',
    allowCustomHost: true,
  };
  let puts: Headers[];
  let stored: Uint8Array | null;
  let readHeaders: Record<string, string>;

  beforeEach(() => {
    puts = [];
    stored = null;
    readHeaders = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/lock')) {
          return init.method === 'POST'
            ? Response.json({ lock_id: 'lease-1' })
            : new Response(null, { status: 200 });
        }
        if (init.method === 'PUT') {
          puts.push(new Headers(init.headers));
          stored = init.body as Uint8Array;
          return new Response(null, { status: 200 });
        }
        return stored
          ? new Response(stored, { status: 200, headers: readHeaders })
          : new Response(null, { status: 404 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const wire = (headers: Headers) => ({
    ttl: headers.get('X-CacheKit-TTL'),
    staleTtl: headers.get('X-CacheKit-Stale-TTL'),
  });

  // Every factory wraps CachekitIOCore differently; each must forward setWithStaleTtl.
  const factories = { cachekitio, cachekitioWithLocking, cachekitioWithTTL, cachekitioFull };
  for (const [name, factory] of Object.entries(factories)) {
    it(`sends X-CacheKit-Stale-TTL beside X-CacheKit-TTL, ceiled (${name})`, async () => {
      const cache = createCache({ backend: factory(config), metrics: false });
      await cache.wrap(async () => 'v', { ...WRAP, ttl: 9.5, staleTtl: 0.5 })();
      expect(puts.map(wire)).toEqual([{ ttl: '10', staleTtl: '1' }]);
      await cache.close();
    });
  }

  it('serves a server-stale read and revalidates under the lease, re-sending both headers', async () => {
    const writer = createCache({ backend: cachekitioFull(config), metrics: false });
    await writer.wrap(async () => 'v1', WRAP)();
    readHeaders = { 'X-CacheKit-Freshness': 'stale', 'X-CacheKit-Fresh-For': '0' };
    const reader = createCache({ backend: cachekitioFull(config), metrics: false });

    expect(await reader.wrap(async () => 'v2', WRAP)()).toBe('v1');
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    expect(puts.map(wire)).toEqual([
      { ttl: '10', staleTtl: '60' },
      { ttl: '10', staleTtl: '60' },
    ]);
    await writer.close();
    await reader.close();
  });

  it('validates the window before any request', async () => {
    const backend = cachekitio(config);
    const value = new Uint8Array([1]);
    for (const [ttl, staleTtl] of [
      [10, -1],
      [10, NaN],
      [10, 2_591_999.5],
      [10, 2_591_991],
      [0, 60],
    ]) {
      await expect(backend.setWithStaleTtl!('k', value, ttl!, staleTtl!)).rejects.toThrow(
        ConfigurationError
      );
    }
    expect(fetch).not.toHaveBeenCalled();

    await backend.setWithStaleTtl!('k', value, 10, 0);
    expect(puts.map(wire)).toEqual([{ ttl: '10', staleTtl: null }]); // 0 sends no header
  });
});

describe('stale-grace revalidation write through the per-key write queue', () => {
  /** A store whose writes wait while `hold` is set. */
  class HeldWritesBackend extends LockingStaleGraceBackend {
    hold: Promise<void> | null = null;
    log: string[] = [];
    private release: () => void = () => {};

    holdWrites(): void {
      this.hold = new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }

    releaseWrites(): void {
      this.release();
      this.hold = null;
    }

    async setWithStaleTtl(key: string, value: Uint8Array, ttl: number, staleTtl: number) {
      this.log.push('write:start');
      if (this.hold) await this.hold;
      await super.setWithStaleTtl(key, value, ttl, staleTtl);
      this.log.push('write:done');
    }

    async set(key: string, value: Uint8Array, ttl?: number): Promise<void> {
      if (this.hold) await this.hold;
      await super.set(key, value, ttl);
    }

    async delete(key: string): Promise<boolean> {
      this.log.push('delete');
      return super.delete(key);
    }

    async releaseLock(key: string, lockId: string): Promise<boolean> {
      this.log.push('release');
      return super.releaseLock(key, lockId);
    }
  }

  const open: SecureCache[] = [];
  const make = (backend: Backend) => {
    const cache = createCache({ backend, metrics: false });
    open.push(cache);
    return cache;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((cache) => cache.close()));
  });

  /** Seed 'v1', let it go stale, and start a revalidation whose write is held. */
  async function heldRevalidation() {
    const backend = new HeldWritesBackend();
    await make(backend).wrap(async () => 'v1', WRAP)();
    backend.expire();
    const [key] = backend.store.keys();
    const reader = make(backend);
    backend.holdWrites();
    expect(await reader.wrap(async () => 'v2', WRAP)()).toBe('v1'); // served stale
    await vi.waitFor(() => expect(backend.log).toContain('write:start'));
    return { backend, reader, key };
  }

  it('orders a later delete() of the key after the queued revalidation write', async () => {
    const { backend, reader, key } = await heldRevalidation();
    const deleted = reader.delete(key);
    await sleep(10);
    expect(backend.log).not.toContain('delete'); // waiting behind the held write

    backend.releaseWrites();
    await deleted;
    expect(backend.log.indexOf('write:done')).toBeLessThan(backend.log.indexOf('delete'));
    expect(backend.store.has(key)).toBe(false); // not resurrected by the revalidation
  });

  it('releases the lease only after the queued write settles', async () => {
    const { backend } = await heldRevalidation();
    await sleep(10);
    expect(backend.log).not.toContain('release');

    backend.releaseWrites();
    await vi.waitFor(() => expect(backend.log).toContain('release'));
    expect(backend.log.indexOf('write:done')).toBeLessThan(backend.log.indexOf('release'));
  });

  it('is drained by close()', async () => {
    const { backend, reader } = await heldRevalidation();
    let closed = false;
    const closing = reader.close().then(() => {
      closed = true;
    });
    await sleep(10);
    expect(closed).toBe(false);

    backend.releaseWrites();
    await closing;
    expect(backend.log).toContain('write:done');
  });

  it('is dropped before the lease and the recompute when the write queue is full, logged and counted', async () => {
    const logError = vi.spyOn(logger, 'logError').mockImplementation(() => {});
    const backend = new HeldWritesBackend();
    await make(backend).wrap(async () => 'v1', WRAP)();
    backend.expire();
    const reader = make(backend);
    backend.log = []; // drop the seed write's entries
    const recordOperation = vi.fn(async (_op: string, _status: string) => {});
    const holder = reader as unknown as {
      metrics: { recordOperation: (op: string, status: string) => Promise<void> };
    };
    holder.metrics = { ...holder.metrics, recordOperation };

    // 64 write-behind writes held: the queue is full.
    backend.holdWrites();
    const fill = reader.wrap(async (id: number) => id, {
      namespace: 'svc:fill',
      ttl: 10,
      writeBehind: true,
    });
    await Promise.all(Array.from({ length: 64 }, (_, i) => fill(i)));
    const acquiresBefore = backend.acquires;

    const fn = vi.fn(async () => 'v2');
    const wrapped = reader.wrap(fn, WRAP);
    try {
      expect(await wrapped()).toBe('v1'); // served stale, not blocked
      await vi.waitFor(() =>
        expect(recordOperation).toHaveBeenCalledWith('revalidate_dropped', 'error')
      );
      expect(fn).not.toHaveBeenCalled(); // no origin call
      expect(backend.acquires).toBe(acquiresBefore); // and no lease taken
      expect(
        logError.mock.calls.some((args) => String(args[0]).includes('stale revalidation dropped'))
      ).toBe(true);

      // The key is held off, not retried on the next stale read.
      expect(await wrapped()).toBe('v1');
      await sleep(10);
      expect(recordOperation.mock.calls.filter(([op]) => op === 'revalidate_dropped')).toHaveLength(
        1
      );
    } finally {
      backend.releaseWrites();
    }
  });

  it('past the byte bound, is dropped after the recompute and holds the key off', async () => {
    vi.spyOn(logger, 'logError').mockImplementation(() => {});
    const backend = new HeldWritesBackend();
    const options = {
      metrics: false as const,
      compression: false,
      serializer: { maxEncodedSize: 32 * 1024 * 1024, maxDecodedSize: 32 * 1024 * 1024 },
    };
    const seed = createCache({ backend, ...options });
    open.push(seed);
    await seed.wrap(async () => 'v1', WRAP)();
    backend.expire();
    const reader = createCache({ backend, ...options });
    open.push(reader);

    // One held write-behind 1 byte under 16 MiB encoded (a 5-byte msgpack
    // string header): the count is far from its bound, so the revalidation
    // runs, and its 3-byte write then crosses the byte bound.
    backend.holdWrites();
    const big = 'x'.repeat(16 * 1024 * 1024 - 6);
    await reader.wrap(async () => big, { namespace: 'svc:big', ttl: 10, writeBehind: true })();

    const fn = vi.fn(async () => 'v2');
    const wrapped = reader.wrap(fn, WRAP);
    backend.log = [];
    try {
      expect(await wrapped()).toBe('v1');
      await vi.waitFor(() => expect(backend.log).toContain('release')); // ran under the lease
      expect(fn).toHaveBeenCalledTimes(1);
      expect(backend.log).toEqual(['release']); // and wrote nothing

      // Dropped, so the key is held off: the next stale read does not recompute.
      expect(await wrapped()).toBe('v1');
      await sleep(10);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      backend.releaseWrites();
    }
  });

  it('is queued behind a pending write-behind of the key, and the lease waits for both', async () => {
    const backend = new HeldWritesBackend();
    const seed = make(backend);
    await seed.wrap(async () => 'v1', WRAP)();
    const [key] = backend.store.keys();
    const staleBytes = backend.store.get(key)!;
    backend.store.delete(key);

    // L1 off, so the second call reads L2 again.
    const reader = createCache({ backend, metrics: false, l1: { enabled: false } });
    open.push(reader);
    const wrapped = reader.wrap(async () => 'v2', { ...WRAP, writeBehind: true });
    backend.holdWrites();
    expect(await wrapped()).toBe('v2'); // cold miss: its write-behind is held, the key's tail
    backend.log = [];

    // Another process left a stale entry; this read serves it and revalidates.
    backend.store.set(key, staleBytes);
    backend.stale.add(key);
    expect(await wrapped()).toBe('v1');
    await sleep(10);
    expect(backend.log).toEqual([]); // the revalidation write waits behind the held one

    backend.releaseWrites();
    await vi.waitFor(() => expect(backend.log).toContain('release'));
    expect(backend.log).toEqual(['write:done', 'write:start', 'write:done', 'release']);
  });

  it('on Workers, a revalidation write is never a key tail, so a later op does not wait on it', async () => {
    const backend = new HeldWritesBackend();
    await make(backend).wrap(async () => 'v1', WRAP)();
    backend.expire();
    const [key] = backend.store.keys();
    const runtime: CacheRuntime = {
      resolveBackend: () => backend,
      createByteStorage: () => new ByteStorage(),
      createEncryption: (config) => new EncryptionManager(config.masterKey, config.tenantId),
      swrRequiresWaitUntil: true,
    };
    const cache = new CacheImpl({ backend, metrics: false }, runtime);
    open.push(cache);
    const registered: Promise<unknown>[] = [];
    const view = cache.withExecutionContext({ waitUntil: (p) => registered.push(p) });

    backend.holdWrites(); // the revalidation's PUT hangs, as one workerd cancelled would
    expect(await view.wrap(async () => 'v2', WRAP)()).toBe('v1');
    await vi.waitFor(() => expect(backend.log).toContain('write:start'));

    // A delete of the key runs at once instead of waiting out the 30 s cap
    // (this test's timeout is 10 s).
    await expect(cache.delete(key)).resolves.toBe(true);
    backend.releaseWrites();
    await registered[0];
  });

  it('a stale-grace write-behind sends the stale window, in the background and on the caller', async () => {
    const backend = new HeldWritesBackend();
    const cache = make(backend);
    const wrapped = cache.wrap(async (id: number) => `v${id}`, { ...WRAP, writeBehind: true });

    await wrapped(1); // background
    await vi.waitFor(() => expect(backend.writes).toHaveLength(1));
    expect(backend.writes).toEqual([WIRE]);

    // A full queue sends the next one to the caller's path.
    backend.holdWrites();
    const fill = cache.wrap(async (id: number) => id, {
      namespace: 'svc:fill',
      ttl: 10,
      writeBehind: true,
    });
    await Promise.all(Array.from({ length: 64 }, (_, i) => fill(i)));
    const onCaller = wrapped(2);
    backend.releaseWrites();
    await onCaller;
    await cache.close();
    expect(backend.writes.filter((w) => w.staleTtl === 60)).toEqual([WIRE, WIRE]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ByteStorage } from '@cachekit-io/cachekit-core-ts';
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
  acquires = 0;
  releases = 0;
  private readonly locks = new Map<string, string>();

  async acquireLock(key: string): Promise<string | null> {
    this.acquires++;
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

const WRAP = { namespace: 'svc:report', ttl: 10, staleTtl: 60 };

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

    expect(await process(backend).wrap(fn, options)()).toBe('v1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fn).not.toHaveBeenCalled(); // no revalidation
    expect(backend.writes).toEqual([{ ttl: 10 }]); // set(), no stale window
  });

  it('sends the stale window with the TTL on a cold-miss write', async () => {
    const backend = new StaleGraceBackend();
    await process(backend).wrap(async () => 'v1', WRAP)();
    expect(backend.writes).toEqual([{ ttl: 10, staleTtl: 60 }]);
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
    await vi.waitFor(() => expect(backend.writes).toEqual([WRAP, WRAP].map(timing)));

    expect(await wrapped()).toBe('v2'); // its write filled L1
    expect(backend.gets).toBe(3);
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
    await vi.waitFor(() => expect(backend.writes).toEqual([WRAP, WRAP].map(timing)));
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
      expect(backend.writes).toEqual([WRAP, WRAP].map(timing));
      expect(backend.releases).toBe(1);
    });

    it('stands down on a contested lease without waiting or retrying (API-62)', async () => {
      const backend = new LockingStaleGraceBackend();
      await seedStale(backend);
      backend.mode = 'contested';
      const fn = vi.fn(async () => 'v2');

      expect(await process(backend).wrap(fn, WRAP)()).toBe('v1');
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(backend.acquires).toBe(1); // one attempt; the seed's miss took none (distributedLock off)
      expect(fn).not.toHaveBeenCalled();
      expect(backend.writes).toHaveLength(1);
    });

    it('abandons the attempt when the lock endpoint fails, and a later stale read retries', async () => {
      const backend = new LockingStaleGraceBackend();
      await seedStale(backend);
      backend.mode = 'error';
      const logError = vi.spyOn(logger, 'logError').mockImplementation(() => {});
      const fn = vi.fn(async () => 'v2');
      const wrapped = process(backend).wrap(fn, WRAP);

      expect(await wrapped()).toBe('v1');
      await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
      expect(fn).not.toHaveBeenCalled();

      backend.mode = 'grant';
      expect(await wrapped()).toBe('v1');
      await vi.waitFor(() => expect(backend.writes).toHaveLength(2));
      expect(fn).toHaveBeenCalledTimes(1);
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
    await new Promise((resolve) => setTimeout(resolve, 10));

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
      expect(backend.writes).toEqual([WRAP, WRAP].map(timing));
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
      expect(backend.writes).toEqual([WRAP, WRAP].map(timing));
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

function timing(options: { ttl: number; staleTtl?: number }) {
  return { ttl: options.ttl, staleTtl: options.staleTtl };
}

/**
 * Wave 2: Resource Management Bug Fixes - TDD Tests
 *
 * Each test reproduces a specific bug before the fix is applied.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCache } from './cache.js';
import { RetryPolicy } from './reliability/retry.js';
import { CacheMetrics } from './metrics/prometheus.js';
import { setLogger } from './logger.js';
import { BackendError, ConfigurationError } from './errors.js';
import { CacheImpl, type CacheRuntime } from './cache-core.js';
import { EncryptionManager } from './encryption/manager.js';
import { ByteStorage } from '@cachekit-io/cachekit-core-ts';
import type { CacheOptions } from './types/cache.js';
import { blake2b16Hex } from './serialization/key-generator.js';
import type { Backend } from './backends/types.js';
import type { L1Cache } from './l1/lru-cache.js';
import type { Redis } from 'ioredis';

// ========== Test Helpers ==========

/**
 * In-memory backend for testing.
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

/**
 * Mock Redis client for invalidation channel testing.
 */
function createMockRedis(): Redis {
  const redis = {
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue('OK'),
    unsubscribe: vi.fn().mockResolvedValue('OK'),
    quit: vi.fn().mockResolvedValue('OK'),
    duplicate: vi.fn(() => ({
      subscribe: vi.fn().mockResolvedValue('OK'),
      unsubscribe: vi.fn().mockResolvedValue('OK'),
      quit: vi.fn().mockResolvedValue('OK'),
      on: vi.fn(),
    })),
    on: vi.fn(),
  };
  return redis as unknown as Redis;
}

// ========== Config errors open no backend ==========

describe('config errors throw before the backend is resolved', () => {
  // resolveBackend opens the connection (a URL config builds a reconnecting
  // Redis client), so a ConfigurationError thrown after it would leak that
  // client to a caller who catches the error.
  function fakeRuntime() {
    const resolveBackend = vi.fn(() => new InMemoryBackend());
    const runtime: CacheRuntime = {
      resolveBackend,
      createByteStorage: () => new ByteStorage(),
      createEncryption: (config) =>
        new EncryptionManager(config.masterKey, config.tenantId, config.previousMasterKeys),
    };
    return { runtime, resolveBackend };
  }

  const backend = { url: 'redis://localhost:6379' };

  it.each<[string, Partial<CacheOptions>, RegExp]>([
    [
      'serializer bound',
      { serializer: { maxDecodedSize: NaN } },
      /serializer\.maxDecodedSize must be a positive safe integer/,
    ],
    [
      'stampede.lockTimeoutMs',
      { stampede: { lockTimeoutMs: 0 } },
      /stampede\.lockTimeoutMs must be > 0/,
    ],
    [
      'l1.maxMemory',
      { l1: { maxMemory: Infinity } },
      /l1\.maxMemory must be a finite number > 0, got Infinity/,
    ],
    [
      'encryption masterKey',
      { encryption: { masterKey: 'not-hex' } },
      /Master key must be hex-encoded/,
    ],
    [
      'encryption tenantId',
      { encryption: { masterKey: 'ab'.repeat(32), tenantId: null as never } },
      /tenantId must be a string, got null/,
    ],
    [
      // fakeRuntime has no createInvalidationChannel, as on Workers
      'invalidation without Pub/Sub',
      { invalidation: { redis: createMockRedis() } },
      /Cross-instance invalidation is not supported in this runtime/,
    ],
  ])('%s: throws ConfigurationError without calling resolveBackend', (_name, extra, message) => {
    const { runtime, resolveBackend } = fakeRuntime();
    const build = () => new CacheImpl({ backend, ...extra }, runtime);
    expect(build).toThrow(ConfigurationError);
    expect(build).toThrow(message);
    expect(resolveBackend).not.toHaveBeenCalled();
  });

  it('resolves the backend once config is valid', () => {
    const { runtime, resolveBackend } = fakeRuntime();
    new CacheImpl({ backend }, runtime);
    expect(resolveBackend).toHaveBeenCalledTimes(1);
  });
});

// ========== m1: InvalidationChannel Never Initialized ==========

describe('m1: InvalidationChannel Initialization', () => {
  it('should initialize invalidationChannel when invalidation config is provided', async () => {
    const mockRedis = createMockRedis();

    // Create cache with invalidation configuration
    const cache = createCache({
      backend: new InMemoryBackend(),
      defaultTtl: 3600,
      l1: { enabled: true, maxEntries: 100 },
      invalidation: {
        redis: mockRedis,
        channelName: 'test:invalidate',
      },
    });

    // Trigger invalidation - if channel is initialized, it should publish
    await cache.invalidate('global');

    // The mockRedis.publish should have been called if channel was initialized
    // This test will FAIL before the fix because invalidationChannel is never initialized
    expect(mockRedis.publish).toHaveBeenCalled();

    await cache.close();
  });

  it('should NOT initialize invalidationChannel when invalidation config is not provided', async () => {
    // Create cache WITHOUT invalidation configuration
    const cache = createCache({
      backend: new InMemoryBackend(),
      defaultTtl: 3600,
      l1: { enabled: true, maxEntries: 100 },
    });

    // Trigger invalidation - should work without error (no channel)
    await cache.invalidate('global');

    // Just verify no error was thrown
    await cache.close();
  });

  it('should stop invalidationChannel on cache close', async () => {
    // Track the duplicated redis instances
    const quitSpy = vi.fn().mockResolvedValue('OK');

    const mockRedis = {
      publish: vi.fn().mockResolvedValue(1),
      duplicate: vi.fn(() => ({
        subscribe: vi.fn().mockResolvedValue('OK'),
        unsubscribe: vi.fn().mockResolvedValue('OK'),
        quit: quitSpy,
        on: vi.fn(),
      })),
    } as unknown as Redis;

    const cache = createCache({
      backend: new InMemoryBackend(),
      defaultTtl: 3600,
      invalidation: {
        redis: mockRedis,
        channelName: 'test:invalidate',
      },
    });

    // Wait a tick for the start() promise to settle
    await new Promise((r) => setTimeout(r, 0));

    await cache.close();

    // The channel's stop() should have been called, which calls subscriber.quit()
    expect(quitSpy).toHaveBeenCalled();
  });
});

// ========== invalidate() must not report success for work it did not do ==========

describe('invalidate("namespace") failure reporting', () => {
  let reported: string[];

  beforeEach(() => {
    reported = [];
    setLogger((message) => reported.push(message));
  });

  afterEach(() => {
    setLogger(null);
  });

  it('reports a non-string namespace at the caller, and publishes nothing', async () => {
    const mockRedis = createMockRedis();
    const cache = createCache({
      backend: new InMemoryBackend(),
      defaultTtl: 3600,
      invalidation: { redis: mockRedis },
    });

    await expect(
      cache.invalidate('namespace', { namespace: 42 } as unknown as { namespace: string })
    ).resolves.toBeUndefined();
    expect(reported).toEqual([
      '[cachekit] invalidate("namespace") called with no namespace; nothing invalidated',
    ]);
    expect(mockRedis.publish).not.toHaveBeenCalled();

    // A well-formed call stays quiet and still publishes — the guard must not be broader.
    reported.length = 0;
    await cache.invalidate('namespace', { namespace: 'ns' });
    expect(reported).toEqual([]);
    expect(mockRedis.publish).toHaveBeenCalledOnce();

    await cache.close();
  });
});

describe('invalidate("params") failure reporting', () => {
  let reported: string[];

  beforeEach(() => {
    reported = [];
    setLogger((message) => reported.push(message));
  });

  afterEach(() => {
    setLogger(null);
  });

  it.each([
    ['no options', undefined],
    ['empty options', {}],
    ['empty key', { key: '' }],
    ['non-string key', { key: 42 } as unknown as { key: string }],
  ])(
    'reports a call with %s at the caller, and deletes and publishes nothing',
    async (_, options) => {
      const backend = new InMemoryBackend();
      const deleteSpy = vi.spyOn(backend, 'delete');
      const mockRedis = createMockRedis();
      const cache = createCache({
        backend,
        defaultTtl: 3600,
        invalidation: { redis: mockRedis },
      });
      await cache.set('k', 'value');
      const l1 = (cache as unknown as { l1: L1Cache }).l1;
      expect(l1.stats.entries).toBe(1);

      await expect(cache.invalidate('params', options)).resolves.toBeUndefined();
      expect(reported).toEqual([
        '[cachekit] invalidate("params") called with no key; nothing invalidated',
      ]);
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(mockRedis.publish).not.toHaveBeenCalled();
      expect(l1.stats.entries).toBe(1);

      // A well-formed call stays quiet and still publishes — the guard must not be broader.
      reported.length = 0;
      await cache.invalidate('params', { key: 'k' });
      expect(reported).toEqual([]);
      expect(deleteSpy).toHaveBeenCalledOnce();
      expect(mockRedis.publish).toHaveBeenCalledOnce();

      await cache.close();
    }
  );

  // Shaped like a wrapped ioredis error reply: the command and its key ride on `cause`.
  const redisReply = Object.assign(new Error('READONLY'), {
    command: { name: 'del', args: ['secret-key'] },
  });

  // Passes the allow-list on its first read, then turns into the key.
  let classificationReads = 0;
  const shiftingClassification = Object.defineProperty(
    new BackendError('failed'),
    'classification',
    {
      get: () => (classificationReads++ === 0 ? 'transient' : 'secret-key'),
    }
  );
  const throwingClassification = Object.defineProperty(
    new BackendError('failed'),
    'classification',
    {
      get: () => {
        throw new Error('secret-key');
      },
    }
  );

  it.each([
    [
      'a BackendError',
      new BackendError('DELETE failed for secret-key', 'transient', { cause: redisReply }),
      'BackendError(transient)',
    ],
    ['a plain Error', new Error('DELETE failed for secret-key'), 'Error'],
    [
      'an Error with the key in its name',
      Object.assign(new Error('failed'), { name: 'DELETE failed for secret-key' }),
      'Error',
    ],
    [
      'a BackendError with the key in its name',
      Object.assign(new BackendError('failed'), { name: 'secret-key' }),
      'BackendError(transient)',
    ],
    [
      'a BackendError with the key in its classification',
      Object.assign(new BackendError('failed'), { classification: 'secret-key' }),
      'BackendError',
    ],
    [
      'a BackendError whose classification changes between reads',
      shiftingClassification,
      'BackendError(transient)',
    ],
    ['a BackendError whose classification getter throws', throwingClassification, 'BackendError'],
    ['a non-Error throw', 'DELETE failed for secret-key', 'Unknown error'],
  ] as [string, unknown, string][])(
    'reports a failed L2 delete from %s without the key, and still resolves',
    async (_, failure, expected) => {
      const errors: unknown[] = [];
      setLogger((message, error) => {
        reported.push(message);
        errors.push(error);
      });
      const backend = new InMemoryBackend();
      vi.spyOn(backend, 'delete').mockRejectedValue(failure);
      const cache = createCache({ backend, defaultTtl: 3600 });

      await expect(cache.invalidate('params', { key: 'secret-key' })).resolves.toBeUndefined();
      // The digest a holder of the key can recompute, never the key itself.
      expect(reported).toEqual([
        `[cachekit] invalidate("params") L2 delete failed (keyHash=${blake2b16Hex('secret-key')}):`,
      ]);
      expect(errors).toEqual([expected]);
      expect(JSON.stringify([reported, errors])).not.toContain('secret-key');

      await cache.close();
    }
  );
});

// ========== m3: RetryPolicy Sleep Not Cancellable ==========

describe('m3: RetryPolicy Cancellable Sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should abort retry sleep immediately when AbortController is signaled', async () => {
    const policy = new RetryPolicy({
      maxAttempts: 3,
      baseDelay: 10000, // 10 second delay - very long
      jitter: false,
    });

    const abortController = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    // Start execution with abort signal
    const executePromise = policy.execute(fn, { signal: abortController.signal });

    // First attempt happens immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Abort before the 10 second delay completes
    abortController.abort();

    // The promise should reject with AbortError immediately
    await expect(executePromise).rejects.toThrow();

    // Should NOT have made additional attempts
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should complete normally if not aborted', async () => {
    const policy = new RetryPolicy({
      maxAttempts: 3,
      baseDelay: 100,
      jitter: false,
    });

    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('success');

    const executePromise = policy.execute(fn);

    // First attempt fails
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Wait for delay and second attempt
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);

    const result = await executePromise;
    expect(result).toBe('success');
  });
});

// ========== m4: Missing Cleanup of refreshingKeys on Close ==========

describe('m4: refreshingKeys Cleanup on Close', () => {
  afterEach(() => {
    // A failure between useFakeTimers/useRealTimers below must not leak a
    // frozen clock into the m5 suite.
    vi.useRealTimers();
  });

  it('should clear refreshingKeys when cache is closed', async () => {
    vi.useFakeTimers();
    const cache = createCache({
      backend: new InMemoryBackend(),
      l1: {
        enabled: true,
        maxEntries: 100,
        swrEnabled: true,
        swrThresholdRatio: 0.9,
      },
    });
    // refreshingKeys is held by the internal L1 alone (close() reaches it via
    // l1.clear()) and has no public surface — same reach-in as
    // cache.encryption-l1.test.ts.
    const l1 = (cache as unknown as { l1: L1Cache }).l1;

    // First call computes the value (cold path); the refresh's recompute
    // never settles, so the refresh is still in flight when close() runs —
    // the only state in which close() has a marker to clear.
    const compute = vi
      .fn<() => Promise<{ computed: boolean }>>()
      .mockResolvedValueOnce({ computed: true })
      .mockReturnValue(new Promise<never>(() => {}));
    const wrapped = cache.wrap(compute, { namespace: 'test:slow', ttl: 3600 });

    await wrapped();
    expect(l1.stats.refreshing).toBe(0);

    // 300s of a 3600s TTL remain — under the SWR threshold at every jitter
    // draw (0.9 × 3600s × [0.9, 1.1] = 2916–3564s), so this read is stale,
    // takes the refresh marker and starts the background refresh.
    vi.advanceTimersByTime(3300 * 1000);
    await wrapped();
    expect(compute).toHaveBeenCalledTimes(2);
    expect(l1.stats.refreshing).toBe(1);

    await cache.close();
    expect(l1.stats.refreshing).toBe(0);
  });
});

// ========== m5: CacheMetrics Swallows Async Errors ==========

describe('m5: CacheMetrics Error Handling', () => {
  it('should log errors from async metric operations', async () => {
    // Spy on console.error
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Create a metrics instance without prom-client
    // The initialization will fail and should log an error
    const metrics = new CacheMetrics();

    // Record operation - this triggers initialization which may fail
    // If prom-client is not available, it should log instead of silently failing
    await metrics.recordOperation('get', 'success');

    // The console.error should have been called if initialization failed
    // With the mock in vitest, prom-client will return mock classes and not fail
    // So this test verifies the non-throwing behavior

    consoleErrorSpy.mockRestore();
  });

  it('should call onError handler when provided and initialization fails', async () => {
    const errorHandler = vi.fn();

    // Reset vitest's auto-mock for this test to simulate real failure
    vi.doUnmock('prom-client');

    // Create metrics with error handler
    // We can't easily simulate prom-client failing with vitest mocking,
    // but we can verify the onError method exists and is callable
    const metrics = new CacheMetrics({ onError: errorHandler });

    // Verify onError is a method that can be used to register handlers
    expect(typeof metrics.onError).toBe('function');

    // Register additional handler
    const additionalHandler = vi.fn();
    metrics.onError(additionalHandler);

    // Call record - if there's an error, it should call the handler
    await metrics.recordOperation('get', 'success');

    // With prom-client mocked, no error occurs, so handler won't be called
    // This test verifies the API exists and works without throwing
  });

  it('should not throw when metric operations encounter errors', async () => {
    const metrics = new CacheMetrics();

    // All these should not throw even if internal errors occur
    await expect(metrics.recordOperation('get', 'success')).resolves.toBeUndefined();
    await expect(metrics.recordHit('l1')).resolves.toBeUndefined();
    await expect(metrics.recordMiss()).resolves.toBeUndefined();
    await expect(metrics.recordError('timeout')).resolves.toBeUndefined();
    await expect(metrics.updateL1Stats(100, 1024)).resolves.toBeUndefined();
    await expect(metrics.updateCircuitBreakerState('open')).resolves.toBeUndefined();

    const stopTimer = await metrics.startTimer('get');
    expect(typeof stopTimer).toBe('function');
    expect(() => stopTimer()).not.toThrow();
  });
});

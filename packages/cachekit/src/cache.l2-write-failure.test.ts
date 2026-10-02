/**
 * LAB-7157: a failed L2 write must still fill L1 when degradation absorbs it.
 *
 * Before the fix the L1 write sat inside the reliability executor, after
 * backend.set, so any rejected PUT — a revoked key (401/403), an outage, a
 * timeout — skipped it. Every repeat wrap() then re-ran the origin and
 * re-paid the GET+PUT, and nothing was logged. cachekit-py's sync path keeps
 * the L1 copy after a failed L2 write; these pin the same behaviour here.
 *
 * An encrypted cache needs its ciphertext before the executor runs: an open
 * breaker rejects before the write closure, so ciphertext produced inside it
 * never existed and every wrap() recomputed the origin until the breaker
 * closed. Producing the bytes is not a backend operation either, so a failure
 * there must not be retried or counted by the breaker.
 */
import { createHash } from 'node:crypto';
import { assert, describe, it, expect, afterEach, vi } from 'vitest';
import { createCache } from './cache.js';
import { CacheImpl } from './cache-core.js';
import { BackendError } from './errors.js';
import { setLogger } from './logger.js';
import { generateKey } from './serialization/key-generator.js';
import type { ErrorClassification } from './backends/error-classifier.js';
import type { Backend } from './backends/types.js';
import type { L1Cache } from './l1/lru-cache.js';
import type { ReliabilityExecutor } from './reliability/executor.js';

const MASTER_KEY = createHash('sha256').update('cachekit LAB-7157 test fixture').digest('hex');
const CANARY = 'ssn-000-00-0000-do-not-leak';

/** A backend whose reads miss and whose writes and deletes reject with `classification`. */
function rejectingBackend(classification: ErrorClassification) {
  const calls = { get: 0, set: 0, delete: 0 };
  const backend: Backend = {
    get: async () => {
      calls.get++;
      return null;
    },
    set: async () => {
      calls.set++;
      throw new BackendError(`rejected: body text ${CANARY}`, classification);
    },
    delete: async () => {
      calls.delete++;
      throw new BackendError(`rejected: body text ${CANARY}`, classification);
    },
    exists: async () => false,
    close: async () => {},
  };
  return { backend, calls, total: () => calls.get + calls.set };
}

type AnyCache = ReturnType<typeof createCache>;

function l1Of(cache: AnyCache): L1Cache {
  return (cache as unknown as { l1: L1Cache }).l1;
}

/** The cache's circuit-breaker state, which no public API reports. */
function breakerOf(cache: AnyCache) {
  const { reliabilityExecutor } = cache as unknown as { reliabilityExecutor: ReliabilityExecutor };
  return reliabilityExecutor.getCircuitBreakerState();
}

/** Make the cache's envelope pack or its encrypt step fail with `error` on every call. */
function failStep(cache: AnyCache, step: 'pack' | 'encrypt', error: Error) {
  const internals = cache as unknown as {
    byteStorage: { pack: (data: Uint8Array) => Uint8Array };
    encryption: { encrypt: (data: Uint8Array) => Promise<Uint8Array> };
  };
  return step === 'pack'
    ? vi.spyOn(internals.byteStorage, 'pack').mockImplementation(() => {
        throw error;
      })
    : vi.spyOn(internals.encryption, 'encrypt').mockRejectedValue(error);
}

const caches: AnyCache[] = [];
function makeCache(
  backend: Backend,
  opts: { degradation?: boolean; encrypted?: boolean; failureThreshold?: number } = {}
) {
  const cache = createCache({
    backend,
    defaultTtl: 3600,
    l1: { enabled: true, maxEntries: 100 },
    metrics: false,
    reliability: {
      degradation: opts.degradation ?? true,
      retry: { baseDelay: 1 },
      ...(opts.failureThreshold && { circuitBreaker: { failureThreshold: opts.failureThreshold } }),
    },
    ...(opts.encrypted ? { encryption: { masterKey: MASTER_KEY, tenantId: 'lab-7157' } } : {}),
  });
  caches.push(cache);
  return cache;
}

describe('a failed L2 write still fills L1 (LAB-7157)', () => {
  afterEach(async () => {
    setLogger(null);
    vi.restoreAllMocks();
    await Promise.all(caches.splice(0).map((c) => c.close()));
  });

  it.each<ErrorClassification>(['authentication', 'transient', 'timeout'])(
    'with degradation on, 20 wrap() calls on one key under a %s set() failure run the origin once',
    async (classification) => {
      setLogger(() => {});
      const { backend, total } = rejectingBackend(classification);
      const cache = makeCache(backend);
      const origin = vi.fn(async (id: number) => ({ id }));
      const load = cache.wrap(origin, { namespace: 'users', ttl: 60 });

      await expect(load(1)).resolves.toEqual({ id: 1 });
      const afterFirst = total();
      expect(afterFirst).toBeGreaterThan(0);

      for (let i = 0; i < 19; i++) await expect(load(1)).resolves.toEqual({ id: 1 });

      expect(origin).toHaveBeenCalledTimes(1);
      expect(total()).toBe(afterFirst);
    }
  );

  it('with degradation off, a failed set throws and leaves L1 empty', async () => {
    const { backend } = rejectingBackend('authentication');
    const cache = makeCache(backend, { degradation: false });

    await expect(cache.set('users:1', 'v')).rejects.toBeInstanceOf(BackendError);
    expect(l1Of(cache).get('users:1')).toBeNull();

    const load = cache.wrap(async () => 'v', { namespace: 'users', ttl: 60 });
    await expect(load()).rejects.toBeInstanceOf(BackendError);
    expect(l1Of(cache).stats.entries).toBe(0);
  });

  it('direct set() keeps the L1 copy after a failed L2 write (read-your-writes)', async () => {
    setLogger(() => {});
    const { backend, calls } = rejectingBackend('transient');
    const cache = makeCache(backend);

    await cache.set('users:1', 'v');
    expect(await cache.get('users:1')).toBe('v');
    expect(calls.get).toBe(0);
  });

  it('on an encrypted cache L1 holds ciphertext after a failed L2 write', async () => {
    setLogger(() => {});
    const { backend } = rejectingBackend('authentication');
    const cache = makeCache(backend, { encrypted: true });

    await cache.set('users:1', { ssn: CANARY });

    const stored = l1Of(cache).get('users:1');
    assert(stored instanceof Uint8Array, 'expected L1 to hold ciphertext bytes');
    expect(new TextDecoder().decode(stored)).not.toContain(CANARY);
    expect(await cache.get('users:1')).toEqual({ ssn: CANARY });
  });

  it('on an encrypted cache L1 holds nothing when encryption itself threw', async () => {
    setLogger(() => {});
    const { backend, calls } = rejectingBackend('authentication');
    const cache = makeCache(backend, { encrypted: true });
    const encryption = (cache as unknown as { encryption: { encrypt: () => Promise<never> } })
      .encryption;
    vi.spyOn(encryption, 'encrypt').mockRejectedValue(new Error('encrypt failed'));

    await cache.set('users:1', { ssn: CANARY });

    expect(calls.set).toBe(0);
    expect(l1Of(cache).get('users:1')).toBeNull();
  });

  // The breaker short-circuits before the write closure runs, but the value is
  // encrypted before the executor, so an encrypted cache still has ciphertext
  // to keep. A plaintext cache keeps the value; L1 never holds plaintext for
  // an encrypted one.
  it.each([false, true])(
    'with the breaker open, set() fills L1 (encrypted: %s)',
    async (encrypted) => {
      setLogger(() => {});
      const { backend, calls } = rejectingBackend('transient');
      const cache = makeCache(backend, { encrypted, failureThreshold: 1 });
      await cache.set('users:0', 'v');
      const setsBefore = calls.set;

      await cache.set('users:1', { ssn: CANARY });

      expect(calls.set).toBe(setsBefore);
      const stored = l1Of(cache).get('users:1');
      if (encrypted) {
        assert(stored instanceof Uint8Array, 'expected L1 to hold ciphertext bytes');
        expect(new TextDecoder().decode(stored)).not.toContain(CANARY);
      } else {
        expect(stored).toEqual({ ssn: CANARY });
      }
      expect(await cache.get('users:1')).toEqual({ ssn: CANARY });
    }
  );

  it('with the breaker open, 20 wrap() calls on one key of an encrypted cache run the origin once', async () => {
    setLogger(() => {});
    const { backend, total } = rejectingBackend('transient');
    const cache = makeCache(backend, { encrypted: true, failureThreshold: 1 });
    await cache.set('users:0', 'v');
    const callsWhenOpened = total();
    const origin = vi.fn(async (id: number) => ({ id, ssn: CANARY }));
    const load = cache.wrap(origin, { namespace: 'users', ttl: 60 });

    for (let i = 0; i < 20; i++) await expect(load(1)).resolves.toEqual({ id: 1, ssn: CANARY });

    expect(origin).toHaveBeenCalledTimes(1);
    expect(total()).toBe(callsWhenOpened);
    const key = generateKey('users', [1]);
    const stored = l1Of(cache).get(key);
    assert(stored instanceof Uint8Array, 'expected L1 to hold ciphertext bytes');
    expect(new TextDecoder().decode(stored)).not.toContain(CANARY);
    expect(await cache.get(key)).toEqual({ id: 1, ssn: CANARY });
  });

  // A refresh that got nothing back would leave the stale entry in place and
  // retry once per refresh-marker window for as long as the breaker stays open.
  it('with the breaker open, an SWR refresh on an encrypted cache stores the new ciphertext in L1', async () => {
    setLogger(() => {});
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { backend, total } = rejectingBackend('transient');
    const failingSet = backend.set;
    backend.set = async () => {}; // healthy until the outage below
    const cache = makeCache(backend, { encrypted: true, failureThreshold: 1 });
    let generation = 0;
    const origin = vi.fn(async (_id: number) => ({ ssn: CANARY, generation: ++generation }));
    const load = cache.wrap(origin, { namespace: 'users', ttl: 60 });
    const key = generateKey('users', [1]);
    await load(1);
    const first = l1Of(cache).get(key);
    assert(first instanceof Uint8Array, 'expected L1 to hold ciphertext bytes');

    // 45 s on, the entry is stale (15 s left against a 27-33 s threshold) but
    // not expired. The clock stands still from here, so the breaker that this
    // outage opens stays open.
    now += 45_000;
    backend.set = failingSet;
    await cache.set('users:0', 'v');
    const callsWhenOpened = total();

    // Stale hit: served from L1, refresh scheduled in the background.
    await expect(load(1)).resolves.toEqual({ ssn: CANARY, generation: 1 });
    await vi.waitFor(() => {
      const entry = l1Of(cache).get(key);
      assert(entry instanceof Uint8Array, 'expected L1 to hold ciphertext bytes');
      expect(entry).not.toEqual(first);
      expect(new TextDecoder().decode(entry)).not.toContain(CANARY);
    });

    // The refresh reset the entry's freshness: the next read is a fresh hit on
    // the new value and schedules no further refresh.
    await expect(load(1)).resolves.toEqual({ ssn: CANARY, generation: 2 });
    expect(origin).toHaveBeenCalledTimes(2);
    expect(total()).toBe(callsWhenOpened);
  });

  // Compressing and encrypting the value runs before the executor, like
  // serialization: a failure there is not a backend failure, so it is neither
  // retried nor counted by the breaker. It is recorded as a set failure,
  // stores nothing in L2 or L1, and throws with degradation off.
  it.each([
    { step: 'pack', degradation: true },
    { step: 'pack', degradation: false },
    { step: 'encrypt', degradation: true },
    { step: 'encrypt', degradation: false },
  ] as const)(
    'a $step failure (degradation: $degradation) runs once, leaves the breaker closed and stores nothing',
    async ({ step, degradation }) => {
      const { backend, calls } = rejectingBackend('transient');
      // Pack is the only step a plaintext cache has; encrypt needs an encrypted one.
      const cache = makeCache(backend, {
        degradation,
        encrypted: step === 'encrypt',
        failureThreshold: 2,
      });
      const failure = new Error(`${step} failed`);
      const failing = failStep(cache, step, failure);
      const recordFailure = vi.spyOn(
        CacheImpl.prototype as unknown as { recordFailure: (op: string, e: unknown) => void },
        'recordFailure'
      );

      for (let i = 0; i < 3; i++) {
        const write = cache.set(`users:${i}`, { ssn: CANARY });
        if (degradation) await expect(write).resolves.toBeUndefined();
        else await expect(write).rejects.toBe(failure);
      }

      expect(failing).toHaveBeenCalledTimes(3);
      expect(recordFailure.mock.calls).toEqual([
        ['set', failure],
        ['set', failure],
        ['set', failure],
      ]);
      expect(breakerOf(cache)).toBe('closed');
      expect(calls.set).toBe(0);
      expect(l1Of(cache).stats.entries).toBe(0);
    }
  );

  // A failed L2 write now leaves the value in L1, so a delete() whose L2 leg
  // fails must still evict it, or get() and wrap() serve the deleted value
  // for its full TTL.
  it('delete() clears L1 even when the L2 delete fails', async () => {
    setLogger(() => {});
    const { backend, calls } = rejectingBackend('authentication');
    const cache = makeCache(backend);
    await cache.set('users:1', 'v');

    await expect(cache.delete('users:1')).resolves.toBe(false);

    expect(calls.delete).toBeGreaterThan(0);
    expect(l1Of(cache).get('users:1')).toBeNull();
    expect(await cache.get('users:1')).toBeNull();
  });

  it('delete() clears L1 when the breaker skips the L2 delete', async () => {
    setLogger(() => {});
    const { backend, calls } = rejectingBackend('transient');
    const cache = makeCache(backend, { failureThreshold: 1 });
    await cache.set('users:0', 'v');
    await cache.set('users:1', 'v');

    await expect(cache.delete('users:1')).resolves.toBe(false);

    expect(calls.delete).toBe(0);
    expect(l1Of(cache).get('users:1')).toBeNull();
  });

  it('with degradation off, a failed delete throws and still clears L1', async () => {
    const { backend } = rejectingBackend('authentication');
    backend.set = async () => {};
    const cache = makeCache(backend, { degradation: false });
    await cache.set('users:1', 'v');

    await expect(cache.delete('users:1')).rejects.toBeInstanceOf(BackendError);

    expect(l1Of(cache).get('users:1')).toBeNull();
  });

  it('logs an authentication failure at most once per window, without the key or the error text', async () => {
    const logs: unknown[][] = [];
    setLogger((message, error) => logs.push([message, error]));
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { backend } = rejectingBackend('authentication');
    const cache = makeCache(backend);

    for (let i = 0; i < 5; i++) await cache.set(`user:alice${i}@example.com`, 'v');
    expect(logs).toHaveLength(1);
    const [message, error] = logs[0]!;
    expect(message).toMatch(/authentication failure \(keyHash=[0-9a-f]{32}\)/);
    expect(message).not.toContain('alice');
    expect(message).not.toContain(CANARY);
    expect(error).toBeUndefined();

    now.mockReturnValue(1_000_000 + 60_000);
    await cache.set('user:bob@example.com', 'v');
    expect(logs).toHaveLength(2);
  });

  it('does not log a transient failure as an authentication failure', async () => {
    const logError = vi.fn();
    setLogger(logError);
    const { backend } = rejectingBackend('transient');
    const cache = makeCache(backend);

    await cache.set('users:1', 'v');
    expect(logError).not.toHaveBeenCalled();
  });
});

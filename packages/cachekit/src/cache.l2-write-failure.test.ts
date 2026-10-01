/**
 * LAB-7157: a failed L2 write must still fill L1 when degradation absorbs it.
 *
 * Before the fix the L1 write sat inside the reliability executor, after
 * backend.set, so any rejected PUT — a revoked key (401/403), an outage, a
 * timeout — skipped it. Every repeat wrap() then re-ran the origin and
 * re-paid the GET+PUT, and nothing was logged. cachekit-py's sync path keeps
 * the L1 copy after a failed L2 write; these pin the same behaviour here.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCache } from './cache.js';
import { BackendError } from './errors.js';
import { setLogger } from './logger.js';
import type { ErrorClassification } from './backends/error-classifier.js';
import type { Backend } from './backends/types.js';
import type { L1Cache } from './l1/lru-cache.js';

const MASTER_KEY = createHash('sha256').update('cachekit LAB-7157 test fixture').digest('hex');
const CANARY = 'ssn-000-00-0000-do-not-leak';

/** A backend whose reads miss and whose writes reject with `classification`. */
function rejectingBackend(classification: ErrorClassification) {
  const calls = { get: 0, set: 0 };
  const backend: Backend = {
    get: async () => {
      calls.get++;
      return null;
    },
    set: async () => {
      calls.set++;
      throw new BackendError(`rejected: body text ${CANARY}`, classification);
    },
    delete: async () => false,
    exists: async () => false,
    close: async () => {},
  };
  return { backend, calls, total: () => calls.get + calls.set };
}

type AnyCache = ReturnType<typeof createCache>;

function l1Of(cache: AnyCache): L1Cache {
  return (cache as unknown as { l1: L1Cache }).l1;
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
    expect(stored).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(stored as Uint8Array)).not.toContain(CANARY);
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

  // The breaker short-circuits before the write closure runs, so an encrypted
  // cache never produces ciphertext to keep: L1 stays empty rather than ever
  // holding plaintext. A plaintext cache keeps the value.
  it.each([false, true])(
    'with the breaker open, set() fills L1 only on a plaintext cache (encrypted: %s)',
    async (encrypted) => {
      setLogger(() => {});
      const { backend, calls } = rejectingBackend('transient');
      const cache = makeCache(backend, { encrypted, failureThreshold: 1 });
      await cache.set('users:0', 'v');
      const setsBefore = calls.set;

      await cache.set('users:1', 'v');

      expect(calls.set).toBe(setsBefore);
      expect(l1Of(cache).get('users:1')).toEqual(encrypted ? null : 'v');
    }
  );

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

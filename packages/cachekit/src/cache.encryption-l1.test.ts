/**
 * LAB-238 regression: L1 must never hold plaintext for an encrypted cache.
 *
 * Zero-knowledge is a property of every layer. cachekit-py's L1Cache stores
 * bytes (`get() -> tuple[bool, Optional[bytes]]`) and decrypts at read time;
 * cachekit-rs stores ciphertext across all layers. TypeScript stored the
 * post-decrypt value, so a heap dump, core dump, or Node diagnostic report
 * yielded the whole L1 working set in plaintext for its full TTL — and that
 * plaintext survived the key zeroization in close(), because L1 entries are
 * held independently of tenant keys.
 *
 * These drive the REAL encryption path (AES-256-GCM via the Rust core, AAD
 * bound to the cache key) through createCache end-to-end — no mocks on the
 * crypto path — and cover all three L1 population sites: set, get, and the SWR
 * background refresh.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCache } from './cache.js';
import { generateKey } from './serialization/key-generator.js';
import type { SecureCache } from './types/cache.js';
import type { Backend } from './backends/types.js';
import type { L1Cache } from './l1/lru-cache.js';

// Deterministic (reproducible runs, no random source) yet derived at runtime
// from a public fixture string — not a hardcoded key literal a secret scanner
// should ever match. No assertion depends on the key's value.
const MASTER_KEY = createHash('sha256').update('cachekit LAB-238 test fixture').digest('hex');
const TENANT = 'lab-238';

/** Distinctive enough that a substring search over any dump is conclusive. */
const LEAK_CANARY = 'ssn-000-00-0000-do-not-leak';

class InMemoryBackend implements Backend {
  store = new Map<string, Uint8Array>();
  gets = 0;

  async get(key: string): Promise<Uint8Array | null> {
    this.gets++;
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: Uint8Array): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async close(): Promise<void> {}
}

/**
 * The L1 instance CacheImpl holds. Private on purpose — this suite asserts on
 * exactly the bytes an attacker with a heap dump would find, which is the one
 * thing a public API cannot show us.
 */
function l1Of(cache: SecureCache): L1Cache {
  return (cache as unknown as { l1: L1Cache }).l1;
}

/** What is resident in L1 for this key, as-is. */
function l1Entry(cache: SecureCache, key: string): unknown {
  return l1Of(cache).get(key);
}

function expectCiphertext(stored: unknown, backendBytes: Uint8Array | undefined): void {
  if (!(stored instanceof Uint8Array)) {
    throw new Error(`L1 entry is not ciphertext bytes (got ${typeof stored})`);
  }
  // Byte-identical to what L2 holds: the same envelope, still sealed.
  expect(stored).toEqual(backendBytes);
  // And the canary is nowhere in the resident bytes.
  expect(new TextDecoder().decode(stored)).not.toContain(LEAK_CANARY);
}

describe('L1 zero-knowledge for encrypted caches (LAB-238)', () => {
  const caches: SecureCache[] = [];

  function makeCache(backend: Backend, encrypted = true): SecureCache {
    const cache = createCache({
      backend,
      defaultTtl: 3600,
      l1: { enabled: true, maxEntries: 100 },
      ...(encrypted ? { encryption: { masterKey: MASTER_KEY, tenantId: TENANT } } : {}),
    });
    caches.push(cache);
    return cache;
  }

  afterEach(async () => {
    await Promise.all(caches.splice(0).map((c) => c.close()));
  });

  it('set() populates L1 with ciphertext, and the L1 hit decrypts it', async () => {
    const backend = new InMemoryBackend();
    const cache = makeCache(backend);
    const key = 'users:1';

    await cache.set(key, { ssn: LEAK_CANARY });

    expectCiphertext(l1Entry(cache, key), backend.store.get(key));

    // The hit is served from L1 (no second backend read) and still returns
    // the plaintext value — decrypt happens on read, as in cachekit-py.
    const before = backend.gets;
    expect(await cache.get(key)).toEqual({ ssn: LEAK_CANARY });
    expect(backend.gets).toBe(before);
  });

  it('get() repopulates L1 with the ciphertext it read, not the value it decoded', async () => {
    const backend = new InMemoryBackend();
    const writer = makeCache(backend);
    await writer.set('users:2', { ssn: LEAK_CANARY });

    // A second cache over the same L2: cold L1, warm backend.
    const reader = makeCache(backend);
    expect(l1Entry(reader, 'users:2')).toBeNull();

    expect(await reader.get('users:2')).toEqual({ ssn: LEAK_CANARY });

    expectCiphertext(l1Entry(reader, 'users:2'), backend.store.get('users:2'));
  });

  it('the SWR background refresh writes ciphertext to L1, not the factory result', async () => {
    const backend = new InMemoryBackend();
    const cache = makeCache(backend);

    let generation = 0;
    const load = cache.wrap(
      async (_id: number) => ({ ssn: LEAK_CANARY, generation: ++generation }),
      // 2s TTL, read at 1.4s: 600ms remaining against a 0.5 threshold of
      // 900-1100ms (±10% jitter), so the read is stale for every jitter draw
      // and still has 600ms of headroom before the entry expires outright —
      // a loaded CI box takes the stale path, not the cold path.
      { namespace: 'users', ttl: 2 }
    );

    await load(3);
    const key = generateKey('users', [3]);
    expect(generation).toBe(1);
    const firstCiphertext = l1Entry(cache, key);

    await new Promise((r) => setTimeout(r, 1400));

    // Stale hit: served from L1, refresh scheduled in the background.
    expect(await load(3)).toEqual({ ssn: LEAK_CANARY, generation: 1 });

    // Wait for the refresh to actually land in L1 — the factory running is not
    // enough, completeRefresh only runs once the L2 write has resolved.
    await vi.waitFor(() => {
      // Present AND changed: a bare not.toEqual would also pass on null once
      // the TTL expires, misreporting a slow refresh as a format failure below.
      const entry = l1Entry(cache, key);
      expect(entry).toBeInstanceOf(Uint8Array);
      expect(entry).not.toEqual(firstCiphertext);
    });

    expectCiphertext(l1Entry(cache, key), backend.store.get(key));
    expect(await load(3)).toEqual({ ssn: LEAK_CANARY, generation: 2 });
  });

  it('rejects a substituted L1 entry — AAD is verified against the cache key', async () => {
    const backend = new InMemoryBackend();
    const cache = makeCache(backend);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await cache.set('users:victim', { ssn: LEAK_CANARY });
      await cache.set('users:attacker', { ssn: 'attacker-controlled' });

      // Swap in a valid ciphertext sealed under a DIFFERENT key. Without an
      // AAD check on the L1 path this would be served as the victim's value.
      const attackerBytes = backend.store.get('users:attacker')!;
      l1Of(cache).set('users:victim', attackerBytes, 3600_000, 'users');

      expect(await cache.get('users:victim')).toEqual({ ssn: LEAK_CANARY });
      // AES-GCM tag verification is what rejected it, not a decode error.
      expect(consoleSpy).toHaveBeenCalledWith(
        '[cachekit] L1 decrypt failed — entry dropped:',
        expect.stringContaining('Authentication verification failed')
      );
      // The poisoned entry was dropped, then refilled from L2 on the way back.
      expectCiphertext(l1Entry(cache, 'users:victim'), backend.store.get('users:victim'));
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('serves a legitimately-null cached value from L1 without treating it as tampering', async () => {
    // decodeL1Entry wraps its result because null is a valid cached value: an
    // unwrapped null would read as a decrypt failure on every hit, so the
    // entry would be invalidated and re-fetched from L2 (a billed miss on a
    // metered backend) for its whole TTL.
    const backend = new InMemoryBackend();
    const cache = makeCache(backend);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await cache.set('users:null', null);
      const before = backend.gets;

      expect(await cache.get('users:null')).toBeNull();
      expect(await cache.get('users:null')).toBeNull();

      // Served from L1 both times, and nothing was logged as a decrypt failure.
      expect(backend.gets).toBe(before);
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(l1Entry(cache, 'users:null')).toBeInstanceOf(Uint8Array);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('exists() verifies the L1 entry rather than trusting its presence', async () => {
    // L1 holds ciphertext, so presence alone is not an answer: after a key
    // rotation every resident entry is undecryptable and exists() would
    // otherwise report present for entries get() rejects and drops.
    const backend = new InMemoryBackend();
    const cache = makeCache(backend);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await cache.set('users:5', { ssn: LEAK_CANARY });
      expect(await cache.exists('users:5')).toBe(true);

      // Poison L1 with a ciphertext sealed under a different key, then drop
      // the L2 copy: exists() must not report present off the bad L1 entry.
      await cache.set('users:6', { other: true });
      l1Of(cache).set('users:5', backend.store.get('users:6')!, 3600_000, 'users');
      backend.store.delete('users:5');

      expect(await cache.exists('users:5')).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('does not stampede the origin when the L2 write is degraded', async () => {
    // A degraded write still hands back the ciphertext it produced, so the SWR
    // refresh repopulates L1 and resets expiresAt. Without that, cancelRefresh
    // would leave the entry permanently stale and every read would re-arm the
    // refresh — turning a backend outage into an origin stampede on exactly
    // the encrypted caches that carry PII.
    const backend = new InMemoryBackend();
    let writesFail = false;
    const flaky: Backend = {
      ...backend,
      get: (k) => backend.get(k),
      set: async (k, v, t) => {
        if (writesFail) throw new Error('backend down');
        return backend.set(k, v, t);
      },
      delete: (k) => backend.delete(k),
      exists: (k) => backend.exists(k),
      close: () => backend.close(),
    };
    const cache = makeCache(flaky);

    let originCalls = 0;
    const load = cache.wrap(async (_id: number) => ({ ssn: LEAK_CANARY, n: ++originCalls }), {
      namespace: 'users',
      // 4s TTL read from 2.4s: stale against the 1.8-2.2s threshold (0.5
      // ratio, ±10% jitter) for every jitter draw, with 1.6s of lifetime left
      // so the whole read loop below finishes well before the entry expires —
      // an expiry mid-loop would send every later read down the cold path and
      // count origin calls that have nothing to do with stampede control.
      ttl: 4,
    });

    await load(7);
    expect(originCalls).toBe(1);

    writesFail = true;
    await new Promise((r) => setTimeout(r, 2400));

    // Stale reads during the outage, spaced so each scheduled refresh
    // settles before the next read — otherwise the in-flight marker masks the
    // behaviour under test. A refresh that stored something resets the entry's
    // freshness, so the origin is touched a couple of times; one that stored
    // nothing and released its marker would be re-armed by every single read.
    const READS = 10;
    for (let i = 0; i < READS; i++) {
      await load(7);
      await new Promise((r) => setTimeout(r, 10));
    }

    await vi.waitFor(() => {
      expect(originCalls).toBeGreaterThan(1);
    });
    // The signal is "far fewer origin calls than reads", not an absolute count.
    expect(originCalls).toBeLessThan(READS / 2);
  });

  it('leaves plaintext caches storing decoded values (unchanged, non-goal)', async () => {
    const backend = new InMemoryBackend();
    const cache = makeCache(backend, false);

    await cache.set('users:4', { ssn: LEAK_CANARY });
    expect(l1Entry(cache, 'users:4')).toEqual({ ssn: LEAK_CANARY });

    const load = cache.wrap(async (_id: number) => ({ plain: true }), {
      namespace: 'items',
      ttl: 60,
    });
    await load(9);
    expect(l1Entry(cache, generateKey('items', [9]))).toEqual({ plain: true });
  });
});

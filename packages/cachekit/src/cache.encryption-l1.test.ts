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

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCache } from './cache.js';
import { generateKey } from './serialization/key-generator.js';
import type { SecureCache } from './types/cache.js';
import type { Backend } from './backends/types.js';
import type { L1Cache } from './l1/lru-cache.js';

const MASTER_KEY = '61'.repeat(32);
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
  expect(stored).toBeInstanceOf(Uint8Array);
  // Byte-identical to what L2 holds: the same envelope, still sealed.
  expect(stored).toEqual(backendBytes);
  // And the secret is nowhere in the resident representation.
  expect(JSON.stringify(Array.from(stored as Uint8Array))).not.toContain(LEAK_CANARY);
  expect(new TextDecoder().decode(stored as Uint8Array)).not.toContain(LEAK_CANARY);
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
      // 1s TTL: past the 0.5 default SWR threshold (±10% jitter) after the
      // wait below, so the next read serves stale and schedules a refresh.
      { namespace: 'users', ttl: 1 }
    );

    await load(3);
    const key = generateKey('users', [3]);
    expect(generation).toBe(1);
    const firstCiphertext = l1Entry(cache, key);

    await new Promise((r) => setTimeout(r, 700));

    // Stale hit: served from L1, refresh scheduled in the background.
    expect(await load(3)).toEqual({ ssn: LEAK_CANARY, generation: 1 });

    // Wait for the refresh to actually land in L1 — the factory running is not
    // enough, completeRefresh only runs once the L2 write has resolved.
    await vi.waitFor(() => {
      expect(l1Entry(cache, key)).not.toEqual(firstCiphertext);
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
      expect(consoleSpy).toHaveBeenCalledWith(
        '[cachekit] L1 decrypt failed — entry dropped, falling through to L2:',
        expect.any(String)
      );
      // The poisoned entry was dropped, then refilled from L2 on the way back.
      expectCiphertext(l1Entry(cache, 'users:victim'), backend.store.get('users:victim'));
    } finally {
      consoleSpy.mockRestore();
    }
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

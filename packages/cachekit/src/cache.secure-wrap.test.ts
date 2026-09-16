/**
 * LAB-513 regression: `secure.wrap()` must never cache plaintext.
 *
 * Both `cache.secure.wrap` and the request-scoped
 * `cache.withExecutionContext(ctx).secure.wrap` used to be bare delegates to
 * `wrap()`. Every intent is typed `SecureCache`, so on a cache built without
 * `encryption` a "secure" registration silently stored plaintext (CWE-311).
 * cachekit-py raises at decoration time and cachekit-rs's `secure()` returns
 * `Err`; TypeScript now throws `ConfigurationError` at wrap time at both sites.
 * The view is exercised here in the Node lane because the guard lives in the
 * shared CacheImpl — the Workers entrypoint reuses the same method.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCache } from './cache.js';
import { ConfigurationError } from './errors.js';
import { CacheImpl, type ExecutionContextLike } from './cache-core.js';
import type { SecureCache } from './types/cache.js';
import type { Backend } from './backends/types.js';

// Derived at runtime from a public fixture string — not a key literal a
// secret scanner should match. No assertion depends on its value.
const MASTER_KEY = createHash('sha256').update('cachekit LAB-513 test fixture').digest('hex');
/** Distinctive enough that a substring search over stored bytes is conclusive. */
const CANARY = 'ssn-000-00-0000-do-not-leak';
const OPTIONS = { namespace: 'patients:records', ttl: 300 };

class InMemoryBackend implements Backend {
  store = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> {
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

/** The Workers request-scoped view. The method lives on CacheImpl, not on the Node type. */
function viewOf(
  cache: SecureCache,
  ctx: ExecutionContextLike = { waitUntil: () => {} }
): SecureCache {
  return (cache as unknown as CacheImpl).withExecutionContext(ctx);
}

describe('secure.wrap() fails closed without encryption (LAB-513)', () => {
  const caches: SecureCache[] = [];

  function makeCache(encrypted: boolean): { cache: SecureCache; backend: InMemoryBackend } {
    const backend = new InMemoryBackend();
    const cache = createCache({
      backend,
      defaultTtl: 3600,
      // LZ4 alone already hides the canary substring in the stored bytes (a
      // match token lands inside "000-00-0000"), which would let an
      // unencrypted store pass the ciphertext assertion below. With
      // compression off, only AES-GCM stands between MessagePack and the
      // backend, so "canary absent" means "encrypted" and nothing else.
      compression: false,
      ...(encrypted ? { encryption: { masterKey: MASTER_KEY } } : {}),
    });
    caches.push(cache);
    return { cache, backend };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(caches.splice(0).map((c) => c.close()));
  });

  const sites: Array<[string, (cache: SecureCache) => SecureCache['secure']]> = [
    ['cache.secure', (cache) => cache.secure],
    ['cache.withExecutionContext(ctx).secure', (cache) => viewOf(cache).secure],
  ];

  describe.each(sites)('%s', (_site, secureOf) => {
    it('throws ConfigurationError at wrap time, before the function is ever called', () => {
      const { cache } = makeCache(false);
      const fn = async (id: string) => ({ id, ssn: CANARY });

      expect(() => secureOf(cache).wrap(fn, OPTIONS)).toThrow(ConfigurationError);
      expect(() => secureOf(cache).wrap(fn, OPTIONS)).toThrow(/createCache\.secure\(\)/);
    });

    it('passes through to wrap() when encryption is configured and stores only ciphertext', async () => {
      const { cache, backend } = makeCache(true);
      const getRecord = secureOf(cache).wrap(async (id: string) => ({ id, ssn: CANARY }), OPTIONS);

      expect(await getRecord('p1')).toEqual({ id: 'p1', ssn: CANARY });
      // Second call is a hit and still decrypts to the same value.
      expect(await getRecord('p1')).toEqual({ id: 'p1', ssn: CANARY });

      expect(backend.store.size).toBe(1);
      for (const bytes of backend.store.values()) {
        expect(new TextDecoder().decode(bytes)).not.toContain(CANARY);
      }
    });
  });

  it('forwards the request waitUntil handle to wrap() on the view (Workers SWR)', () => {
    const { cache } = makeCache(true);
    const ctx: ExecutionContextLike = { waitUntil: vi.fn() };
    const wrapSpy = vi.spyOn(CacheImpl.prototype, 'wrap');

    viewOf(cache, ctx).secure.wrap(async (id: string) => ({ id }), OPTIONS);

    // Before LAB-513 the view's secure.wrap WAS wrapWith and inherited its
    // waitUntil; now it is its own closure, so pin the plumbing explicitly.
    const handle = wrapSpy.mock.lastCall?.[2];
    expect(handle).toBeTypeOf('function');
    handle?.(Promise.resolve());
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });

  it('plain wrap() on an unencrypted cache is unaffected — and is the plaintext control', async () => {
    const { cache, backend } = makeCache(false);
    const getRecord = cache.wrap(async (id: string) => ({ id, ssn: CANARY }), OPTIONS);
    expect(await getRecord('p1')).toEqual({ id: 'p1', ssn: CANARY });

    // Proves the canary probe can see plaintext when it is there, so the
    // ciphertext assertions above are not vacuous.
    expect(backend.store.size).toBe(1);
    for (const bytes of backend.store.values()) {
      expect(new TextDecoder().decode(bytes)).toContain(CANARY);
    }
  });
});

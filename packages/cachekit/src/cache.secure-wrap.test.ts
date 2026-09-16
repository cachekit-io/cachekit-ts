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
import { describe, it, expect, afterEach } from 'vitest';
import { createCache } from './cache.js';
import { ConfigurationError } from './errors.js';
import type { CacheImpl } from './cache-core.js';
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
function viewOf(cache: SecureCache): SecureCache {
  return (cache as unknown as CacheImpl).withExecutionContext({ waitUntil: () => {} });
}

describe('secure.wrap() fails closed without encryption (LAB-513)', () => {
  const caches: SecureCache[] = [];

  function makeCache(encrypted: boolean): { cache: SecureCache; backend: InMemoryBackend } {
    const backend = new InMemoryBackend();
    const cache = createCache({
      backend,
      defaultTtl: 3600,
      ...(encrypted ? { encryption: { masterKey: MASTER_KEY } } : {}),
    });
    caches.push(cache);
    return { cache, backend };
  }

  afterEach(async () => {
    await Promise.all(caches.splice(0).map((c) => c.close()));
  });

  const sites: Array<[string, (cache: SecureCache) => SecureCache['secure']]> = [
    ['cache.secure', (cache) => cache.secure],
    ['cache.withExecutionContext(ctx).secure', (cache) => viewOf(cache).secure],
  ];

  describe.each(sites)('%s', (_site, secureOf) => {
    it('throws ConfigurationError at wrap time, before the function is ever called', () => {
      const { cache, backend } = makeCache(false);
      let calls = 0;
      const fn = async (id: string) => {
        calls++;
        return { id, ssn: CANARY };
      };

      expect(() => secureOf(cache).wrap(fn, OPTIONS)).toThrow(ConfigurationError);
      expect(() => secureOf(cache).wrap(fn, OPTIONS)).toThrow(/createCache\.secure\(\)/);
      expect(calls).toBe(0);
      expect(backend.store.size).toBe(0);
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

  it('plain wrap() on an unencrypted cache is unaffected', async () => {
    const { cache } = makeCache(false);
    const getRecord = cache.wrap(async (id: string) => ({ id }), OPTIONS);
    expect(await getRecord('p1')).toEqual({ id: 'p1' });
  });
});

/**
 * Native edge storage backends (LAB-750) — runs inside real workerd.
 *
 * - Workers KV backend against a real miniflare KVNamespace binding
 *   (TEST_KV, vitest.workers.config.ts): round-trip, TTL semantics
 *   (min-60s floor asserted via the binding's list() expiration metadata —
 *   the floor itself makes sub-minute expiry unobservable in-test), delete,
 *   exists.
 * - Cache API backend against workerd's real caches.default / named caches:
 *   round-trip, real TTL expiry (no KV-style floor), delete, exists.
 * - Secure-cache path over both: same master-key fixture as the LAB-595
 *   suites — ciphertext at rest, plaintext never reaches the store.
 * - Intent factories with a backend instance and explicit config
 *   (no process.env).
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createCache,
  workersKV,
  workersCacheAPI,
  KV_MIN_TTL_SECONDS,
  ConfigurationError,
  generateKey,
  type KVNamespaceLike,
  type WorkersKVBackendConfig,
} from '../../src/workers/index.js';

// Public protocol test-vector key (32 bytes of 0x61) — the same fixture the
// LAB-595 suites and protocol/test-vectors use. Not a credential.
const MASTER_KEY_HEX = '61'.repeat(32); // pragma: allowlist secret

/** The real miniflare binding, widened with the list() the tests use to
 * inspect expiration metadata. */
const TEST_KV = (
  env as unknown as {
    TEST_KV: KVNamespaceLike & {
      list(options?: {
        prefix?: string;
      }): Promise<{ keys: { name: string; expiration?: number }[] }>;
    };
  }
).TEST_KV;

const BINARY_PAYLOAD = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x80, 0x7f]);

async function kvExpiration(key: string): Promise<number | undefined> {
  const { keys } = await TEST_KV.list({ prefix: key });
  expect(keys.map((k) => k.name)).toContain(key);
  return keys.find((k) => k.name === key)?.expiration;
}

describe('Workers KV backend inside workerd', () => {
  it('round-trips binary bytes and reports existence/deletion correctly', async () => {
    const backend = workersKV({ kv: TEST_KV });

    expect(await backend.get('kv:missing')).toBeNull();
    expect(await backend.exists('kv:missing')).toBe(false);

    await backend.set('kv:key', BINARY_PAYLOAD, 300);
    expect(await backend.get('kv:key')).toEqual(BINARY_PAYLOAD);
    expect(await backend.exists('kv:key')).toBe(true);

    expect(await backend.delete('kv:key')).toBe(true);
    expect(await backend.delete('kv:key')).toBe(false);
    expect(await backend.get('kv:key')).toBeNull();

    await backend.close();
    await expect(backend.get('kv:key')).rejects.toThrow(/closed/);
  });

  // KV's expirationTtl floor is 60s, so actual expiry is unobservable in a
  // fast test; the expiration metadata KV records IS the expiry contract —
  // assert it directly.
  it('passes TTL through to KV expiration, clamping to the 60s floor', async () => {
    const backend = workersKV({ kv: TEST_KV });
    const now = Math.floor(Date.now() / 1000);

    await backend.set('kv:ttl300', BINARY_PAYLOAD, 300);
    const at300 = await kvExpiration('kv:ttl300');
    expect(at300).toBeGreaterThanOrEqual(now + 295);
    expect(at300).toBeLessThanOrEqual(now + 305);

    await backend.set('kv:ttl30', BINARY_PAYLOAD, 30);
    const at30 = await kvExpiration('kv:ttl30');
    expect(at30).toBeGreaterThanOrEqual(now + KV_MIN_TTL_SECONDS - 5);
    expect(at30).toBeLessThanOrEqual(now + KV_MIN_TTL_SECONDS + 5);

    await backend.set('kv:ttl0', BINARY_PAYLOAD, 0);
    expect(await kvExpiration('kv:ttl0')).toBeUndefined(); // ttl <= 0 → no expiry

    await backend.close();
  });

  it('requires a KVNamespace binding', () => {
    expect(() => workersKV({} as WorkersKVBackendConfig)).toThrow(ConfigurationError);
  });
});

describe('Cache API backend inside workerd', () => {
  it('round-trips binary bytes and reports existence/deletion correctly', async () => {
    const backend = workersCacheAPI();

    expect(await backend.get('cacheapi:missing')).toBeNull();
    expect(await backend.exists('cacheapi:missing')).toBe(false);

    await backend.set('cacheapi:key', BINARY_PAYLOAD, 300);
    expect(await backend.get('cacheapi:key')).toEqual(BINARY_PAYLOAD);
    expect(await backend.exists('cacheapi:key')).toBe(true);

    expect(await backend.delete('cacheapi:key')).toBe(true);
    expect(await backend.delete('cacheapi:key')).toBe(false);
    expect(await backend.get('cacheapi:key')).toBeNull();

    await backend.close();
    await expect(backend.get('cacheapi:key')).rejects.toThrow(/closed/);
  });

  it('expires entries when the TTL elapses (no 60s floor)', async () => {
    const backend = workersCacheAPI();

    await backend.set('cacheapi:short', BINARY_PAYLOAD, 1);
    expect(await backend.get('cacheapi:short')).toEqual(BINARY_PAYLOAD);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await backend.get('cacheapi:short')).toBeNull();
    expect(await backend.exists('cacheapi:short')).toBe(false);

    await backend.close();
  });

  // Regression (panel MAJ, CWE-41): path-borne keys '.', '..' (and their
  // %2E escapes) get dot-normalized by the URL parser — '.' aliased '' and
  // '..' escaped the key prefix. Keys ride a query parameter now, which is
  // never normalized.
  it('degenerate keys ("", ".", "..") stay distinct — no dot-segment aliasing', async () => {
    const backend = workersCacheAPI();
    const valueA = new Uint8Array([0x0a]);
    const valueB = new Uint8Array([0x0b]);
    const valueC = new Uint8Array([0x0c]);

    await backend.set('', valueA, 300);
    await backend.set('.', valueB, 300);
    await backend.set('..', valueC, 300);

    expect(await backend.get('')).toEqual(valueA);
    expect(await backend.get('.')).toEqual(valueB);
    expect(await backend.get('..')).toEqual(valueC);

    expect(await backend.delete('.')).toBe(true);
    expect(await backend.get('')).toEqual(valueA); // deleting '.' must not touch ''
    expect(await backend.get('..')).toEqual(valueC);

    await backend.close();
  });

  it('named caches are isolated from caches.default', async () => {
    const namedBackend = workersCacheAPI({ cacheName: 'cachekit-test' });
    const defaultBackend = workersCacheAPI();

    await namedBackend.set('cacheapi:scoped', BINARY_PAYLOAD, 300);
    expect(await namedBackend.get('cacheapi:scoped')).toEqual(BINARY_PAYLOAD);
    expect(await defaultBackend.get('cacheapi:scoped')).toBeNull();

    await namedBackend.close();
    await defaultBackend.close();
  });
});

describe('secure-cache path: ciphertext at rest in the edge stores', () => {
  // Same shape as the LAB-595 full-stack test: wrap() through serialize →
  // envelope → encrypt → backend, then read the raw stored bytes via the
  // canonical key and assert no plaintext reached the store.
  async function assertCiphertextAtRest(
    backend: ReturnType<typeof workersKV> | ReturnType<typeof workersCacheAPI>,
    namespace: string
  ) {
    const cache = createCache({
      backend,
      defaultTtl: 300,
      encryption: { masterKey: MASTER_KEY_HEX, tenantId: 'edge-backends' },
      l1: { enabled: false }, // force the L2 path so reads exercise the backend
    });

    let calls = 0;
    const expensive = cache.wrap(
      async (id: number) => {
        calls++;
        return { id, name: `user-${id}` };
      },
      { namespace, ttl: 300 }
    );

    expect(await expensive(7)).toEqual({ id: 7, name: 'user-7' });
    expect(await expensive(7)).toEqual({ id: 7, name: 'user-7' });
    expect(calls).toBe(1); // second call served by the edge store

    const stored = await backend.get(generateKey(namespace, [7]));
    expect(stored).not.toBeNull();
    const storedText = new TextDecoder('utf-8', { fatal: false }).decode(stored!);
    expect(storedText).not.toContain('user-7');

    await cache.close();
  }

  it('Workers KV stores only ciphertext for secure caches', async () => {
    await assertCiphertextAtRest(workersKV({ kv: TEST_KV }), 'kv:secure');
  });

  it('Cache API stores only ciphertext for secure caches', async () => {
    await assertCiphertextAtRest(workersCacheAPI(), 'cacheapi:secure');
  });
});

describe('intent factories with backend instances (no process.env)', () => {
  it('createCache.production({ backend: workersKV(...) }) drives the full stack', async () => {
    const cache = createCache.production({
      backend: workersKV({ kv: TEST_KV }),
      ttl: 300,
      l1: { enabled: false },
    });

    await cache.set('intent:kv', { hello: 'edge' });
    expect(await cache.get('intent:kv')).toEqual({ hello: 'edge' });
    expect(await cache.delete('intent:kv')).toBe(true);

    await cache.close();
  });

  it('createCache.secure({ backend: workersCacheAPI(...) }) encrypts through the intent', async () => {
    const cache = createCache.secure({
      backend: workersCacheAPI({ cacheName: 'cachekit-secure-intent' }),
      masterKey: MASTER_KEY_HEX, // pragma: allowlist secret
      ttl: 300,
      l1: { enabled: false },
    });

    await cache.set('intent:secure', { sensitive: 'edge-value' });
    expect(await cache.get('intent:secure')).toEqual({ sensitive: 'edge-value' });

    await cache.close();
  });

  it('rejects url + backend together, and neither', () => {
    expect(() =>
      createCache.production({
        url: 'redis://localhost:6379',
        backend: workersKV({ kv: TEST_KV }),
      } as never)
    ).toThrow(/not both/);
    expect(() => createCache.minimal({} as never)).toThrow(/requires a Redis url or a backend/);
  });
});

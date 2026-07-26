/**
 * Cache-level interop mode tests: the wrap() opt-in path.
 *
 * Byte-level vector conformance lives in
 * test/protocol/interop-mode.protocol.test.ts; this file verifies the wiring:
 * interop keys, plain-MessagePack storage (no ByteStorage envelope even with
 * the default compression:true), compressed=False AAD under encryption, and
 * auto mode staying byte-for-byte unchanged.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createCache } from './cache.js';
import type { SecureCache, WrapOptions } from './types/cache.js';
import type { Backend } from './backends/types.js';
import {
  generateInteropKey,
  encodeInteropValue,
  decodeInteropValue,
} from './serialization/interop.js';
import { generateKey } from './serialization/key-generator.js';
import { EncryptionManager } from './encryption/manager.js';
import { ConfigurationError } from './errors.js';

class InMemoryBackend implements Backend {
  store = new Map<string, Uint8Array>();

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

describe('cache.wrap interop mode', () => {
  let cache: SecureCache | null = null;

  afterEach(async () => {
    await cache?.close();
    cache = null;
  });

  it('stores plain MessagePack under the interop key — no ByteStorage envelope, compression default untouched', async () => {
    const backend = new InMemoryBackend();
    cache = createCache({ backend, l1: { enabled: false } }); // compression defaults to true

    const getUser = cache.wrap(async (_id: number) => ({ name: 'alice', age: 30 }), {
      namespace: 'users',
      interop: 'get_user',
      interopArity: 1,
      ttl: 300,
    });
    await getUser(42);

    const expectedKey = generateInteropKey('users', 'get_user', [42]);
    const stored = backend.store.get(expectedKey);
    expect(stored).toBeDefined();
    // Byte-identical to the canonical plain-MessagePack encoding — proves the
    // ByteStorage envelope was skipped despite compression:true.
    expect(stored).toEqual(encodeInteropValue({ name: 'alice', age: 30 }));
    expect(decodeInteropValue(stored!)).toEqual({ name: 'alice', age: 30 });
  });

  it('round-trips through L2 (compute once, then serve from cache)', async () => {
    const backend = new InMemoryBackend();
    cache = createCache({ backend, l1: { enabled: false } });

    let calls = 0;
    const fn = cache.wrap(
      async (id: bigint) => {
        calls++;
        return { id: id.toString() };
      },
      { namespace: 'users', interop: 'get_user', interopArity: 1, ttl: 300 }
    );

    const a = await fn(18446744073709551615n); // u64 max — BigInt required in JS
    const b = await fn(18446744073709551615n);
    expect(a).toEqual({ id: '18446744073709551615' });
    expect(b).toEqual(a);
    expect(calls).toBe(1);
  });

  it('enforces the declared interopArity at call time', async () => {
    const backend = new InMemoryBackend();
    cache = createCache({ backend, l1: { enabled: false } });

    const twoArgs = cache.wrap(async (a: number, b: number) => a + b, {
      namespace: 'math',
      interop: 'add',
      interopArity: 2,
      ttl: 60,
    });
    // A short call (which would rely on a default the other SDKs bind into
    // the hash) must fail loudly, not hash a divergent key.
    await expect(
      (twoArgs as unknown as (...args: unknown[]) => Promise<number>)(1)
    ).rejects.toThrow(ConfigurationError);
    await expect(twoArgs(1, 2)).resolves.toBe(3);
  });

  it('requires interopArity and cross-checks it against the parameter list at wrap time', () => {
    const backend = new InMemoryBackend();
    cache = createCache({ backend, l1: { enabled: false } });

    // Missing declaration — a compile error for TS callers (discriminated
    // union), pinned here for plain-JS callers via the cast.
    expect(() =>
      cache!.wrap(async (a: number) => a, {
        namespace: 'math',
        interop: 'id',
        ttl: 60,
      } as unknown as WrapOptions)
    ).toThrow(/requires interopArity/);

    // interopArity without interop: the opt-in was dropped (typo/refactor) —
    // auto-mode keys would silently miss every cross-SDK entry.
    expect(() =>
      cache!.wrap(async (a: number) => a, {
        namespace: 'math',
        interopArity: 1,
        ttl: 60,
      } as unknown as WrapOptions)
    ).toThrow(/interopArity was set without interop/);

    // Default parameter: fn.length drops to 1, so an accidental default —
    // which Python would bind into the hash while JS silently omits it — is
    // caught at registration, not discovered as a divergent key in prod.
    expect(() =>
      cache!.wrap(async (a: number, b: number = 5) => a + b, {
        namespace: 'math',
        interop: 'add',
        interopArity: 2,
        ttl: 60,
      })
    ).toThrow(/remove default, optional, and rest parameters/);

    // Rest parameter: fn.length === 0 — must trip the parameter-list
    // cross-check specifically.
    expect(() =>
      cache!.wrap(async (...nums: number[]) => nums.length, {
        namespace: 'math',
        interop: 'count',
        interopArity: 2,
        ttl: 60,
      })
    ).toThrow(/parameter list reports 0/);

    // Non-integer and negative declarations.
    expect(() =>
      cache!.wrap(async (a: number) => a, {
        namespace: 'math',
        interop: 'id',
        interopArity: 1.5,
        ttl: 60,
      })
    ).toThrow(/non-negative integer, got 1.5/);
    expect(() =>
      cache!.wrap(async (a: number) => a, {
        namespace: 'math',
        interop: 'id',
        interopArity: -1,
        ttl: 60,
      })
    ).toThrow(/non-negative integer, got -1/);
  });

  it('fails closed at wrap time when the backend applies a key prefix', () => {
    class PrefixedBackend extends InMemoryBackend {
      readonly keyPrefix = 'app:';
    }
    const backend = new PrefixedBackend();
    cache = createCache({ backend, l1: { enabled: false } });

    // Interop keys must reach the wire byte-identical to py/rs's bare keys —
    // fail closed at registration (Ray's call on LAB-247, mirroring
    // cachekit-rs); see Backend.keyPrefix.
    expect(() =>
      cache!.wrap(async (id: number) => ({ id }), {
        namespace: 'users',
        interop: 'get_user',
        interopArity: 1,
        ttl: 60,
      })
    ).toThrow(/key prefix/);

    // Auto mode on the same prefixed backend stays fully usable.
    expect(() =>
      cache!.wrap(async (id: number) => ({ id }), { namespace: 'users', ttl: 60 })
    ).not.toThrow();
  });

  it('fails closed at wrap time when the backend transforms keys (Backend.transformsKeys)', () => {
    // Re-encoding backends (e.g. the Cloudflare Cache API maps keys onto
    // synthetic URLs) can't express the transform as a keyPrefix, but they
    // break interop for the same reason — fail closed. See Backend.transformsKeys.
    class KeyTransformBackend extends InMemoryBackend {
      readonly transformsKeys = true;
    }
    cache = createCache({ backend: new KeyTransformBackend(), l1: { enabled: false } });

    expect(() =>
      cache!.wrap(async (id: number) => ({ id }), {
        namespace: 'users',
        interop: 'get_user',
        interopArity: 1,
        ttl: 60,
      })
    ).toThrow(/transforms keys/);

    // Auto mode on the same key-transforming backend stays fully usable.
    expect(() =>
      cache!.wrap(async (id: number) => ({ id }), { namespace: 'users', ttl: 60 })
    ).not.toThrow();
  });

  it('fails closed at call time when a keyPrefix appears after wrap (dynamic prefix)', async () => {
    // The Backend contract requires a construction-time-constant keyPrefix;
    // a request-scoped getter (e.g. AsyncLocalStorage tenant router) would
    // report '' at registration and prefix at runtime — the call-time
    // re-check keeps that fail-closed instead of fail-open.
    class LatePrefixBackend extends InMemoryBackend {
      prefix = '';
      get keyPrefix(): string {
        return this.prefix;
      }
    }
    const backend = new LatePrefixBackend();
    cache = createCache({ backend, l1: { enabled: false } });

    const fn = cache.wrap(async (id: number) => ({ id }), {
      namespace: 'users',
      interop: 'get_user',
      interopArity: 1,
      ttl: 60,
    });
    await expect(fn(1)).resolves.toEqual({ id: 1 });

    backend.prefix = 'tenant-a:';
    await expect(fn(2)).rejects.toThrow(/key prefix/);
  });

  it('allows interop on backends with an empty or absent keyPrefix', async () => {
    class EmptyPrefixBackend extends InMemoryBackend {
      readonly keyPrefix = '';
    }
    cache = createCache({ backend: new EmptyPrefixBackend(), l1: { enabled: false } });
    expect(() =>
      cache!.wrap(async (id: number) => ({ id }), {
        namespace: 'users',
        interop: 'get_user',
        interopArity: 1,
        ttl: 60,
      })
    ).not.toThrow();

    // Absent property (plain InMemoryBackend) — the shipped default shape.
    const bare = createCache({ backend: new InMemoryBackend(), l1: { enabled: false } });
    try {
      expect(() =>
        bare.wrap(async (id: number) => ({ id }), {
          namespace: 'users',
          interop: 'get_user',
          interopArity: 1,
          ttl: 60,
        })
      ).not.toThrow();
    } finally {
      await bare.close();
    }
  });

  it('surfaces interop model rejections instead of silently skipping the cache', async () => {
    const backend = new InMemoryBackend();
    cache = createCache({ backend, l1: { enabled: false } });

    class Exotic {
      x = 1;
    }
    const fn = cache.wrap(async (_id: number) => new Exotic(), {
      namespace: 'users',
      interop: 'get_exotic',
      interopArity: 1,
      ttl: 60,
    });
    // Degradation must NOT swallow the closed-model error into "computed but
    // never cached" — the spec requires a loud rejection.
    await expect(fn(1)).rejects.toThrow(/not in the interop data model/);
  });

  it('rejects invalid segments at wrap time, before any call', () => {
    const backend = new InMemoryBackend();
    cache = createCache({ backend });

    expect(() =>
      cache!.wrap(async () => 1, {
        namespace: 'Users',
        interop: 'get_user',
        interopArity: 0,
        ttl: 60,
      })
    ).toThrow(ConfigurationError);
    expect(() =>
      cache!.wrap(async () => 1, {
        namespace: 'users',
        interop: 'get:user',
        interopArity: 0,
        ttl: 60,
      })
    ).toThrow(ConfigurationError);
    expect(() =>
      cache!.wrap(async () => 1, {
        namespace: 'users\n',
        interop: 'get_user',
        interopArity: 0,
        ttl: 60,
      })
    ).toThrow(ConfigurationError);
  });

  it('encrypts interop entries with compressed=False AAD (cross-SDK decryptable)', async () => {
    const backend = new InMemoryBackend();
    const masterKey = '61'.repeat(32);
    const tenantId = 'cross-sdk-test';
    cache = createCache({
      backend,
      l1: { enabled: false },
      encryption: { masterKey, tenantId },
    });

    const fn = cache.wrap(async (id: number) => ({ id }), {
      namespace: 'users',
      interop: 'get_user',
      interopArity: 1,
      ttl: 300,
    });
    await fn(42);

    const key = generateInteropKey('users', 'get_user', [42]);
    const ciphertext = backend.store.get(key)!;
    expect(ciphertext).toBeDefined();

    // An independent manager (as the Python/Rust SDK would) must decrypt with
    // the interop AAD: format=msgpack, compressed=False — and the plaintext
    // must be the plain MessagePack document, no envelope.
    const reader = new EncryptionManager(masterKey, tenantId);
    try {
      const plaintext = await reader.decrypt(ciphertext, key, false);
      expect(plaintext).toEqual(encodeInteropValue({ id: 42 }));
      expect(decodeInteropValue(plaintext)).toEqual({ id: 42 });
    } finally {
      reader.dispose();
    }

    // Round-trip through the cache's own read path.
    expect(await fn(42)).toEqual({ id: 42 });
  });

  it('leaves auto mode byte-for-byte unchanged (ByteStorage envelope still applied)', async () => {
    const backend = new InMemoryBackend();
    cache = createCache({ backend, l1: { enabled: false } });

    const fn = cache.wrap(async (id: number) => ({ id }), { namespace: 'users', ttl: 300 });
    await fn(42);

    const autoKey = generateKey('users', [42]);
    const stored = backend.store.get(autoKey)!;
    expect(stored).toBeDefined();
    // Auto-mode bytes are the ByteStorage envelope (a positional msgpack
    // array of [data, checksum, size, format]) — not the plain-MessagePack
    // interop encoding of the value.
    expect(stored).not.toEqual(encodeInteropValue({ id: 42 }));
    expect(await fn(42)).toEqual({ id: 42 });
  });

  it('serves interop entries from L1 and repopulates L1 from L2 under the user namespace', async () => {
    const backend = new InMemoryBackend();
    cache = createCache({ backend, l1: { enabled: true, maxEntries: 10 } });

    let calls = 0;
    const fn = cache.wrap(
      async (id: number) => {
        calls++;
        return { id };
      },
      { namespace: 'users', interop: 'get_user', interopArity: 1, ttl: 300 }
    );

    await fn(1);
    await fn(1); // L1 hit
    expect(calls).toBe(1);

    // Namespace-level invalidation uses the user-facing namespace segment.
    await cache.invalidate('namespace', { namespace: 'users' });
    await fn(1); // L1 invalidated; L2 still holds it — no recompute
    expect(calls).toBe(1);
  });
});

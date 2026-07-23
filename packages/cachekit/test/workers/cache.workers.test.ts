/**
 * Workers entrypoint smoke tests (LAB-595) — runs inside real workerd.
 *
 * - CachekitIO backend over workerd's fetch, against the in-memory
 *   cachekit.io emulation configured as the miniflare outboundService
 *   (vitest.workers.config.ts) — binary-safe, no real network.
 * - Full createCache stack (serialize → envelope → encrypt → backend and
 *   back) against an in-memory Backend instance.
 * - Intent factories with explicit config (no process.env), and the
 *   documented phase-1 failures: Redis-URL backends and invalidation config.
 */

import { describe, it, expect } from 'vitest';
import {
  createCache,
  CachekitIOCore,
  ConfigurationError,
  type Backend,
} from '../../src/workers/index.js';

const MASTER_KEY_HEX = '61'.repeat(32); // 32 bytes of 0x61, same as the vector fixture

/** Minimal in-memory Backend for full-stack tests (no network). */
function memoryBackend(): Backend & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      return store.delete(key);
    },
    async exists(key) {
      return store.has(key);
    },
    async close() {},
  };
}

describe('CachekitIO backend inside workerd (mocked upstream)', () => {
  it('round-trips binary bytes through set/get and maps 404 to null', async () => {
    const backend = new CachekitIOCore({ apiKey: 'ck_test_smoke' }); // pragma: allowlist secret
    const payload = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x80, 0x7f]);

    expect(await backend.get('smoke:missing')).toBeNull();

    await backend.set('smoke:key', payload, 120);
    expect(await backend.get('smoke:key')).toEqual(payload);
    expect(await backend.exists('smoke:key')).toBe(true);

    expect(await backend.delete('smoke:key')).toBe(true);
    expect(await backend.delete('smoke:key')).toBe(false);
    expect(await backend.get('smoke:key')).toBeNull();
    expect(await backend.exists('smoke:key')).toBe(false);

    await backend.close();
  });

  it('createCache.io drives the full stack over the fetch backend', async () => {
    const cache = createCache.io({
      apiKey: 'ck_test_fullstack', // pragma: allowlist secret
      ttl: 300,
      l1: { enabled: false }, // force the L2 path so reads exercise the backend
      encryption: { masterKey: MASTER_KEY_HEX, tenantId: 'workers-smoke' },
    });

    let calls = 0;
    const expensive = cache.wrap(
      async (id: number) => {
        calls++;
        return { id, name: `user-${id}` };
      },
      { namespace: 'io:getUser', ttl: 300 }
    );

    expect(await expensive(7)).toEqual({ id: 7, name: 'user-7' });
    expect(await expensive(7)).toEqual({ id: 7, name: 'user-7' });
    expect(calls).toBe(1); // second call came from the CachekitIO backend

    await cache.close();
  });
});

describe('createCache full stack inside workerd', () => {
  it('wrap() round-trips through envelope + encryption + backend', async () => {
    const backend = memoryBackend();
    const cache = createCache({
      backend,
      defaultTtl: 60,
      encryption: { masterKey: MASTER_KEY_HEX, tenantId: 'workers-smoke' },
      l1: { enabled: false }, // force the L2 path so every read exercises decrypt+unpack
    });

    let calls = 0;
    const expensive = cache.wrap(
      async (id: number) => {
        calls++;
        return { id, name: `user-${id}`, tags: ['a', 'b'] };
      },
      { namespace: 'users:getUser', ttl: 60 }
    );

    const first = await expensive(42);
    const second = await expensive(42);
    expect(first).toEqual({ id: 42, name: 'user-42', tags: ['a', 'b'] });
    expect(second).toEqual(first);
    expect(calls).toBe(1); // second call served from cache

    // The stored bytes are encrypted — no plaintext leaks to the backend
    const stored = [...backend.store.values()];
    expect(stored.length).toBe(1);
    const storedText = new TextDecoder('utf-8', { fatal: false }).decode(stored[0]);
    expect(storedText).not.toContain('user-42');

    await cache.close();
  });

  it('set/get round-trips without encryption (envelope only)', async () => {
    const backend = memoryBackend();
    const cache = createCache({ backend, defaultTtl: 60, l1: { enabled: false } });

    await cache.set('ns:plain', { hello: 'workers' });
    expect(await cache.get('ns:plain')).toEqual({ hello: 'workers' });
    expect(await cache.exists('ns:plain')).toBe(true);
    expect(await cache.delete('ns:plain')).toBe(true);
    expect(await cache.get('ns:plain')).toBeNull();

    await cache.close();
  });

  it('wrap() with L1 enabled works (SWR forced off — no background refresh)', async () => {
    const backend = memoryBackend();
    // Intent-style config would set swrEnabled: true; the Workers runtime
    // forces it off because fire-and-forget refreshes are canceled by
    // workerd when the response returns.
    const cache = createCache({ backend, defaultTtl: 60, l1: { swrEnabled: true } });

    let calls = 0;
    const fn = cache.wrap(
      async (id: number) => {
        calls++;
        return { id };
      },
      { namespace: 'swr:test', ttl: 60 }
    );

    expect(await fn(1)).toEqual({ id: 1 });
    expect(await fn(1)).toEqual({ id: 1 }); // L1 hit
    expect(calls).toBe(1);

    await cache.close();
  });
});

describe('intents with explicit config (no process.env)', () => {
  it('createCache.io without apiKey throws ConfigurationError (not a process crash)', () => {
    expect(() => createCache.io({} as Parameters<typeof createCache.io>[0])).toThrow(
      ConfigurationError
    );
  });

  it('Redis-URL intents throw a clear ConfigurationError on Workers', () => {
    expect(() => createCache.minimal({ url: 'redis://localhost:6379' })).toThrow(
      /not supported on Cloudflare Workers/
    );
    expect(() => createCache.production({ url: 'redis://localhost:6379' })).toThrow(
      /not supported on Cloudflare Workers/
    );
    expect(() =>
      createCache.secure({ url: 'redis://localhost:6379', masterKey: MASTER_KEY_HEX })
    ).toThrow(/not supported on Cloudflare Workers/);
  });

  it('invalidation config fails fast (Redis Pub/Sub is Node-only)', () => {
    const backend = memoryBackend();
    expect(() =>
      createCache({
        backend,
        invalidation: { redis: {} as never },
      })
    ).toThrow(/invalidation is not supported/i);
  });
});

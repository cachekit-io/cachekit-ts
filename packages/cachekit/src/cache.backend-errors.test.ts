/**
 * Backend error classification through the production reliability stack.
 *
 * The protocol (saas-api.md, Error Classification) marks HTTP 400, 401, 403,
 * 409 and 413 as permanent: do not retry. They are also request-specific, so
 * they must not count toward the circuit breaker — otherwise five malformed
 * keys open the breaker and every healthy key degrades to a miss.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCache } from './intents.js';
import { cachekitio } from './backends/cachekitio-factory.js';
import { BackendError } from './errors.js';
import { setLogger } from './logger.js';
import type { Backend } from './backends/types.js';

// Deliberately fake credential for fixtures.
const FAKE_API_KEY = 'ck_test_fake-not-a-secret'; // pragma: allowlist secret

/**
 * Stub fetch as a tiny CachekitIO server. While `failWith` is set every
 * request answers that status; once cleared, PUT stores and GET reads back.
 */
function stubServer(failWith: number | null) {
  const store = new Map<string, Uint8Array>();
  const server = {
    failWith,
    store,
    fetch: vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (server.failWith !== null) return new Response('rejected', { status: server.failWith });
      if (init?.method === 'PUT') {
        store.set(url, new Uint8Array(await new Response(init.body).arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      const body = store.get(url);
      return body ? new Response(body, { status: 200 }) : new Response(null, { status: 404 });
    }),
  };
  vi.stubGlobal('fetch', server.fetch);
  return server;
}

const ioBackend = () =>
  cachekitio({
    apiKey: FAKE_API_KEY,
    apiUrl: 'https://api.test.cachekit.io',
    allowCustomHost: true,
  });

// production preset: retry 3x with backoff, breaker opens at 5 failures in 60 s.
const productionCache = (backend: Backend, degradation = true) =>
  createCache.production({ backend, metrics: false, reliability: { degradation } });

/** A healthy set/get round-trip reaches the backend — impossible with the breaker open. */
async function expectHealthyRoundTrip(
  cache: ReturnType<typeof productionCache>,
  server: ReturnType<typeof stubServer>
) {
  server.failWith = null;
  server.fetch.mockClear();
  await cache.set('ns:healthy', 'ok');
  expect(server.fetch).toHaveBeenCalledTimes(1);
  expect(server.store.size).toBe(1);
  expect(await cache.get('ns:healthy')).toBe('ok');
}

describe('backend error classification on the production preset', () => {
  afterEach(() => {
    setLogger(null);
    vi.unstubAllGlobals();
  });

  it('six 400s on distinct keys make one fetch each and leave the breaker closed', async () => {
    setLogger(() => {});
    const server = stubServer(400);
    const cache = productionCache(ioBackend());

    for (let i = 0; i < 6; i++) {
      await expect(cache.get(`user:u${i}@example.com`)).resolves.toBeNull();
      expect(server.fetch).toHaveBeenCalledTimes(i + 1);
    }

    await expectHealthyRoundTrip(cache, server);
    await cache.close();
  });

  it('a 413 on set() makes one fetch and adds no breaker count', async () => {
    setLogger(() => {});
    const server = stubServer(413);
    const cache = productionCache(ioBackend());

    await expect(cache.set('ns:big0', 'v')).resolves.toBeUndefined();
    expect(server.fetch).toHaveBeenCalledTimes(1);
    for (let i = 1; i < 6; i++) await cache.set(`ns:big${i}`, 'v');
    expect(server.fetch).toHaveBeenCalledTimes(6);

    await expectHealthyRoundTrip(cache, server);
    await cache.close();
  });

  it.each([401, 403])('a %i makes one fetch and adds no breaker count', async (status) => {
    setLogger(() => {});
    const server = stubServer(status);
    const cache = productionCache(ioBackend());

    for (let i = 0; i < 6; i++) {
      await cache.get(`ns:k${i}`);
      expect(server.fetch).toHaveBeenCalledTimes(i + 1);
    }

    await expectHealthyRoundTrip(cache, server);
    await cache.close();
  });

  it('a 503 is still retried maxAttempts times, and five of them open the breaker', async () => {
    setLogger(() => {});
    const server = stubServer(503);
    const cache = productionCache(ioBackend());

    for (let i = 0; i < 5; i++) {
      await expect(cache.get(`ns:k${i}`)).resolves.toBeNull();
      expect(server.fetch).toHaveBeenCalledTimes((i + 1) * 3);
    }

    // Open breaker: the next call fails fast without reaching the server.
    server.fetch.mockClear();
    await expect(cache.get('ns:k5')).resolves.toBeNull();
    expect(server.fetch).not.toHaveBeenCalled();
    await cache.close();
  });

  it('a custom backend throwing an unclassified BackendError is still retried and counted', async () => {
    setLogger(() => {});
    const get = vi.fn(async (): Promise<Uint8Array | null> => {
      throw new BackendError('Custom get failed: Unknown error');
    });
    const backend: Backend = {
      get,
      set: async () => {},
      delete: async () => false,
      exists: async () => false,
      close: async () => {},
    };
    const cache = productionCache(backend);

    for (let i = 0; i < 5; i++) await cache.get(`ns:k${i}`);
    expect(get).toHaveBeenCalledTimes(15);

    await cache.get('ns:k5');
    expect(get).toHaveBeenCalledTimes(15);
    await cache.close();
  });

  it('with degradation off, a permanent 400 rejects get() with the BackendError after one fetch', async () => {
    const server = stubServer(400);
    const cache = productionCache(ioBackend(), false);

    const err = await cache.get('user:alice@example.com').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).classification).toBe('permanent');
    expect(server.fetch).toHaveBeenCalledTimes(1);
    await cache.close();
  });
});

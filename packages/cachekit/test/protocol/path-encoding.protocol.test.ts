/**
 * Cache-Key Path Encoding Protocol Tests (CWE-22)
 *
 * Verifies `encodeKey` and every CachekitIO request builder against
 * protocol/test-vectors/path-encoding.json (vendored in ./fixtures/ — re-copy
 * on spec change). Spec: protocol/spec/saas-api.md § Cache-Key Path Encoding.
 *
 * Every wire assertion reads the URL the real class handed to `fetch` and
 * parses it with `new URL()` — the post-WHATWG-normalisation path, which is
 * what leaves the process. A template-string comparison would pass while the
 * traversal ships (spec rule 2).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { CachekitIOCore, encodeKey } from '../../src/backends/cachekitio.js';
import { TTLCachekitIO } from '../../src/backends/cachekitio-ttl.js';
import { LockableCachekitIO } from '../../src/backends/cachekitio-lockable.js';
import { ConfigurationError } from '../../src/errors.js';

interface Vector {
  key: string;
  encoded: string | null;
  decoded: string | null;
  reject?: boolean;
  encoded_alternates?: string[];
  note: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const { vectors } = JSON.parse(
  readFileSync(join(here, 'fixtures', 'path-encoding.json'), 'utf8')
) as { vectors: Vector[] };
const reserved = vectors.filter((v) => v.reject);
const transmittable = vectors.filter((v) => !v.reject);

const BASE = 'https://api.cachekit.io';
const PREFIX = '/v1/cache/';

/** Real backend classes over a fetch spy that answers every call 200 with a JSON body. */
function harness() {
  const fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ ttl: 60, lock_id: 'lock-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchSpy);
  const core = new CachekitIOCore({ apiKey: 'ck_test_fake-not-a-secret', apiUrl: BASE }); // pragma: allowlist secret
  return { fetchSpy, core, ttl: new TTLCachekitIO(core), lock: new LockableCachekitIO(core) };
}
type Harness = ReturnType<typeof harness>;

/** Every operation that places `{key}` in the request path, with its route suffix. */
const OPERATIONS: Record<
  string,
  { run: (h: Harness, key: string) => Promise<unknown>; suffix: string }
> = {
  get: { run: (h, k) => h.core.get(k), suffix: '' },
  set: { run: (h, k) => h.core.set(k, new Uint8Array([1])), suffix: '' },
  delete: { run: (h, k) => h.core.delete(k), suffix: '' },
  exists: { run: (h, k) => h.core.exists(k), suffix: '' },
  getTTL: { run: (h, k) => h.ttl.getTTL(k), suffix: '/ttl' },
  refreshTTL: { run: (h, k) => h.ttl.refreshTTL(k, 60), suffix: '/ttl' },
  acquireLock: { run: (h, k) => h.lock.acquireLock(k, 1000), suffix: '/lock' },
  releaseLock: { run: (h, k) => h.lock.releaseLock(k, 'lock-1'), suffix: '/lock' },
};

/** The path `fetch` was handed, as the WHATWG parser resolves it. */
function sentPathname(h: Harness): string {
  expect(h.fetchSpy).toHaveBeenCalledTimes(1);
  const [url] = h.fetchSpy.mock.calls[0] as unknown as [string];
  return new URL(url).pathname;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Pins the platform premise the reject-not-encode design rests on. If a runtime
// ever stops collapsing these, the decision needs revisiting — not silently.
describe('AC-0 repro — raw encodeURIComponent lets a dot-segment key escape /v1/cache/', () => {
  it('literal dots collapse client-side', () => {
    expect(new URL(`${BASE}${PREFIX}${encodeURIComponent('.')}`).pathname).toBe(PREFIX);
    expect(new URL(`${BASE}${PREFIX}${encodeURIComponent('..')}`).pathname).toBe('/v1/');
    expect(new URL(`${BASE}${PREFIX}${encodeURIComponent('..')}/ttl`).pathname).toBe('/v1/ttl');
    expect(new URL(`${BASE}${PREFIX}${encodeURIComponent('..')}/lock`).pathname).toBe('/v1/lock');
  });

  it('%2E does not help — WHATWG treats it as a dot segment (URL Standard §4.1)', () => {
    expect(new URL(`${BASE}${PREFIX}%2E`).pathname).toBe(PREFIX);
    expect(new URL(`${BASE}${PREFIX}%2E%2E`).pathname).toBe('/v1/');
    expect(new URL(`${BASE}${PREFIX}%2E%2E/ttl`).pathname).toBe('/v1/ttl');
    expect(new URL(`${BASE}${PREFIX}%2e%2e/lock`).pathname).toBe('/v1/lock');
  });
});

describe('rule 2 — reserved segments are rejected before the URL is built', () => {
  it('the vendored fixture reserves exactly the five spec tokens', () => {
    expect(reserved.map((v) => v.key).sort()).toEqual(['.', '..', 'health', 'lock', 'ttl']);
  });

  it.each(reserved)('encodeKey($key) throws ConfigurationError', ({ key }) => {
    expect(() => encodeKey(key)).toThrow(ConfigurationError);
  });

  // Case-sensitive, exact match — mirrors the SaaS router (`=== 'health'`, `=== 'ttl' || 'lock'`).
  it.each(['...', 'HEALTH', 'ttls', 'unlock'])(
    'near-miss %j is transmittable and unchanged',
    (key) => {
      expect(encodeKey(key)).toBe(encodeURIComponent(key));
    }
  );

  it('a lone surrogate is a ConfigurationError, not a raw URIError', async () => {
    expect(() => encodeKey('a\uD800')).toThrow(ConfigurationError);
    const h = harness();
    await expect(h.core.get('a\uD800')).rejects.toBeInstanceOf(ConfigurationError);
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  // Backend.validateKey lets CacheImpl reject synchronously, before the
  // reliability executor could retry, count, and swallow the rejection.
  it.each(reserved)('validateKey($key) throws on the core and both wrappers', ({ key }) => {
    const h = harness();
    for (const backend of [h.core, h.ttl, h.lock]) {
      expect(() => backend.validateKey(key)).toThrow(ConfigurationError);
    }
  });

  describe.each(Object.entries(OPERATIONS))('%s', (_name, op) => {
    it.each(reserved)(
      'rejects $key with ConfigurationError and never calls fetch',
      async ({ key }) => {
        const h = harness();
        await expect(op.run(h, key)).rejects.toBeInstanceOf(ConfigurationError);
        expect(h.fetchSpy).not.toHaveBeenCalled();
      }
    );
  });
});

describe('rules 1, 3, 4 — transmittable keys travel as one segment and decode once to the key', () => {
  it.each(transmittable)(
    'encodeKey($key) is a conformant wire form',
    ({ key, encoded, encoded_alternates }) => {
      expect([encoded, ...(encoded_alternates ?? [])]).toContain(encodeKey(key));
      expect(encodeKey(key)).toBe(encodeURIComponent(key));
    }
  );

  describe.each(Object.entries(OPERATIONS))('%s', (_name, op) => {
    it.each(transmittable)(
      'sends $key inside /v1/cache/ as one segment',
      async ({ key, decoded }) => {
        const h = harness();
        await op.run(h, key);
        const pathname = sentPathname(h);
        expect(pathname).toBe(`${PREFIX}${encodeKey(key)}${op.suffix}`);
        const segment = pathname.slice(PREFIX.length, pathname.length - op.suffix.length);
        expect(decodeURIComponent(segment)).toBe(decoded);
      }
    );
  });
});

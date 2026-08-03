import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cachekitio } from './cachekitio-factory.js';
import type { Backend, CachekitIOBackendConfig } from './types.js';
import { BackendError, ConfigurationError, TimeoutError } from '../errors.js';

// Deliberately fake credential for fixtures — obviously-fake value so secret
// scanners and reviewers never mistake it for a live key.
const FAKE_API_KEY = 'ck_test_fake-not-a-secret'; // pragma: allowlist secret

// Helper to create a mock Response
function mockResponse(
  status: number,
  body?: Uint8Array | string | null,
  headers?: Record<string, string>
): Response {
  const responseBody =
    body instanceof Uint8Array ? body : body ? new TextEncoder().encode(body) : null;
  return new Response(responseBody, { status, headers });
}

describe('CachekitIO Backend', () => {
  const validConfig: CachekitIOBackendConfig = {
    apiKey: 'ck_test_abc123',
    apiUrl: 'https://api.test.cachekit.io',
    allowCustomHost: true,
  };

  let fetchSpy: ReturnType<typeof vi.fn>;
  let backend: Backend;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    backend = cachekitio(validConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Config Validation ─────────────────────────────────────

  describe('Configuration', () => {
    it('rejects missing apiKey', () => {
      expect(() => cachekitio({ apiKey: '' })).toThrow(ConfigurationError);
    });

    it('rejects HTTP URLs', () => {
      expect(() => cachekitio({ apiKey: 'key', apiUrl: 'http://api.cachekit.io' })).toThrow(
        ConfigurationError
      );
      expect(() => cachekitio({ apiKey: 'key', apiUrl: 'http://api.cachekit.io' })).toThrow(
        /HTTPS/
      );
    });

    it('accepts valid HTTPS URL', () => {
      expect(() => cachekitio({ apiKey: 'key', apiUrl: 'https://api.cachekit.io' })).not.toThrow();
    });

    it('defaults to https://api.cachekit.io', () => {
      const b = cachekitio({ apiKey: 'key' });
      fetchSpy.mockResolvedValueOnce(mockResponse(404));
      b.get('test'); // triggers fetch
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://api.cachekit.io/v1/cache/'),
        expect.anything()
      );
    });
  });

  // ── GET ───────────────────────────────────────────────────

  describe('get', () => {
    it('returns Uint8Array on 200', async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      fetchSpy.mockResolvedValueOnce(mockResponse(200, data));

      const result = await backend.get('my-key');
      expect(result).toEqual(data);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.test.cachekit.io/v1/cache/my-key',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('returns null on 404', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(404));
      const result = await backend.get('missing');
      expect(result).toBeNull();
    });

    it('sends Authorization header', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(404));
      await backend.get('key');

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer ck_test_abc123');
    });

    it('URL-encodes keys with special characters', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(404));
      await backend.get('namespace:user/123');

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.test.cachekit.io/v1/cache/namespace%3Auser%2F123');
    });

    it('throws BackendError on 500', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(500, 'Internal Server Error'));
      await expect(backend.get('key')).rejects.toThrow(BackendError);
    });

    it('throws BackendError on 401', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(401, 'Unauthorized'));
      await expect(backend.get('key')).rejects.toThrow(BackendError);
    });
  });

  // ── SET ───────────────────────────────────────────────────

  describe('set', () => {
    it('sends PUT with body and X-TTL', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200));
      const value = new Uint8Array([10, 20, 30]);

      await backend.set('my-key', value, 600);

      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.test.cachekit.io/v1/cache/my-key');
      expect(opts.method).toBe('PUT');

      const headers = opts.headers as Record<string, string>;
      expect(headers['X-TTL']).toBe('600');
      expect(headers['Content-Type']).toBe('application/octet-stream');
    });

    it('uses default TTL when none provided', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200));
      await backend.set('key', new Uint8Array([1]));

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers['X-TTL']).toBe('3600'); // DEFAULT_TTL_SECONDS
    });

    it('throws BackendError on 500', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(500, 'Server Error'));
      await expect(backend.set('key', new Uint8Array([1]))).rejects.toThrow(BackendError);
    });
  });

  // ── DELETE ────────────────────────────────────────────────

  describe('delete', () => {
    it('returns true on 200', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200));
      expect(await backend.delete('key')).toBe(true);
    });

    it('returns false on 404', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(404));
      expect(await backend.delete('missing')).toBe(false);
    });

    it('sends DELETE method', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200));
      await backend.delete('key');

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── EXISTS ────────────────────────────────────────────────

  describe('exists', () => {
    it('returns true on 200', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200));
      expect(await backend.exists('key')).toBe(true);
    });

    it('returns false on 404', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(404));
      expect(await backend.exists('missing')).toBe(false);
    });

    it('sends HEAD method', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200));
      await backend.exists('key');

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(opts.method).toBe('HEAD');
    });
  });

  // ── Closed State ──────────────────────────────────────────

  describe('closed state', () => {
    it('throws after close()', async () => {
      await backend.close();
      await expect(backend.get('key')).rejects.toThrow(BackendError);
      await expect(backend.get('key')).rejects.toThrow(/closed/);
    });

    it('close() is idempotent', async () => {
      await backend.close();
      await backend.close(); // No error
    });
  });

  // ── Error Handling ────────────────────────────────────────

  describe('error handling', () => {
    it('wraps network errors as BackendError', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(backend.get('key')).rejects.toThrow(BackendError);
    });

    it('wraps timeout as TimeoutError', async () => {
      const timeoutError = new DOMException('signal timed out', 'TimeoutError');
      fetchSpy.mockRejectedValueOnce(timeoutError);
      await expect(backend.get('key')).rejects.toThrow(TimeoutError);
    });

    it('sanitizes API key from error messages', async () => {
      const errorWithKey = new Error(`Connection to Bearer ck_test_abc123 failed`);
      fetchSpy.mockRejectedValueOnce(errorWithKey);

      try {
        await backend.get('key');
      } catch (e) {
        expect((e as Error).message).not.toContain('ck_test_abc123');
        expect((e as Error).message).toContain('***');
      }
    });

    it('wraps unknown (non-Error) throws as BackendError', async () => {
      fetchSpy.mockRejectedValueOnce('string error');
      await expect(backend.get('key')).rejects.toThrow(BackendError);
    });

    it('wraps network errors on set', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(backend.set('key', new Uint8Array([1]))).rejects.toThrow(BackendError);
    });

    it('wraps timeout on set', async () => {
      const timeoutError = new DOMException('signal timed out', 'TimeoutError');
      fetchSpy.mockRejectedValueOnce(timeoutError);
      await expect(backend.set('key', new Uint8Array([1]))).rejects.toThrow(TimeoutError);
    });

    it('wraps network errors on delete', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(backend.delete('key')).rejects.toThrow(BackendError);
    });

    it('wraps network errors on exists', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(backend.exists('key')).rejects.toThrow(BackendError);
    });

    it('throws BackendError on non-ok delete response', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(500, 'Server Error'));
      await expect(backend.delete('key')).rejects.toThrow(BackendError);
    });

    it('throws BackendError on non-ok exists response', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(500, 'Server Error'));
      await expect(backend.exists('key')).rejects.toThrow(BackendError);
    });

    it('falls back to statusText when response.text() fails in httpError', async () => {
      // Create a response where .text() throws
      const brokenResponse = {
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: () => Promise.reject(new Error('body unavailable')),
        arrayBuffer: () => Promise.reject(new Error('body unavailable')),
      } as unknown as Response;
      fetchSpy.mockResolvedValueOnce(brokenResponse);
      await expect(backend.get('key')).rejects.toThrow(/Bad Gateway/);
    });
  });

  // ── Health Check ────────────────────────────────────────────

  describe('health', () => {
    it('returns healthy with version on 200', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ version: '1.0.0' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const result = await (backend as import('./cachekitio.js').CachekitIOCore).health();
      expect(result.healthy).toBe(true);
      expect(result.version).toBe('1.0.0');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns unhealthy on 429', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(429));
      const result = await (backend as import('./cachekitio.js').CachekitIOCore).health();
      expect(result.healthy).toBe(false);
    });

    it('returns unhealthy on 500', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(500));
      const result = await (backend as import('./cachekitio.js').CachekitIOCore).health();
      expect(result.healthy).toBe(false);
    });

    it('returns unhealthy on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network down'));
      const result = await (backend as import('./cachekitio.js').CachekitIOCore).health();
      expect(result.healthy).toBe(false);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Set edge cases ─────────────────────────────────────────

  describe('set edge cases', () => {
    it('omits X-TTL header when TTL is 0', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200));
      await backend.set('key', new Uint8Array([1]), 0);
      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers['X-TTL']).toBeUndefined();
    });

    it('closed state rejects set', async () => {
      await backend.close();
      await expect(backend.set('key', new Uint8Array([1]))).rejects.toThrow(/closed/);
    });

    it('closed state rejects delete', async () => {
      await backend.close();
      await expect(backend.delete('key')).rejects.toThrow(/closed/);
    });

    it('closed state rejects exists', async () => {
      await backend.close();
      await expect(backend.exists('key')).rejects.toThrow(/closed/);
    });
  });

  // ── createCache integration ───────────────────────────────

  describe('createCache integration', () => {
    it('auto-detects CachekitIO config by apiKey field', async () => {
      // Import dynamically to avoid circular issues in test
      const { createCache } = await import('../cache.js');

      // This should not throw — it should detect apiKey and use cachekitio()
      const cache = createCache({
        backend: {
          apiKey: FAKE_API_KEY,
          apiUrl: 'https://api.test.cachekit.io',
          allowCustomHost: true,
        },
        l1: { enabled: false },
      });

      // Mock the fetch for the backend operation
      fetchSpy.mockResolvedValueOnce(mockResponse(404));
      const result = await cache.get('test');
      expect(result).toBeNull();

      await cache.close();
    });

    // LAB-517: the SaaS telemetry headers are auto-wired from the cache's
    // live hit/miss counters — no user-supplied metricsProvider needed.
    it('auto-wires X-CacheKit-L1-* telemetry headers from live cache counters', async () => {
      const { createCache } = await import('../cache.js');

      const cache = createCache({
        backend: {
          apiKey: FAKE_API_KEY,
          apiUrl: 'https://api.test.cachekit.io',
          allowCustomHost: true,
        },
        l1: { enabled: true },
      });

      fetchSpy.mockResolvedValue(mockResponse(404));
      await cache.get('ns:first'); // miss
      await cache.get('ns:second'); // second request sees the first miss

      const [, secondOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const headers = secondOpts.headers as Record<string, string>;
      expect(headers['X-CacheKit-L1-Status']).toBe('miss');
      expect(headers['X-CacheKit-Misses']).toBe('1');
      expect(headers['X-CacheKit-L1-Hits']).toBe('0');

      await cache.close();
    });

    it('reports L1 telemetry as disabled when the cache has no L1', async () => {
      const { createCache } = await import('../cache.js');

      const cache = createCache({
        backend: {
          apiKey: FAKE_API_KEY,
          apiUrl: 'https://api.test.cachekit.io',
          allowCustomHost: true,
        },
        l1: { enabled: false },
      });

      fetchSpy.mockResolvedValueOnce(mockResponse(404));
      await cache.get('ns:key');

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers['X-CacheKit-L1-Status']).toBe('disabled');

      await cache.close();
    });

    it('a user-supplied metricsProvider overrides the auto-wired one', async () => {
      const { createCache } = await import('../cache.js');

      const cache = createCache({
        backend: {
          apiKey: FAKE_API_KEY,
          apiUrl: 'https://api.test.cachekit.io',
          allowCustomHost: true,
          metricsProvider: () => ({ l1Hits: 42, l2Hits: 7, misses: 3, l1Enabled: true }),
        },
        l1: { enabled: true },
      });

      fetchSpy.mockResolvedValueOnce(mockResponse(404));
      await cache.get('ns:key');

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers['X-CacheKit-L1-Hits']).toBe('42');
      expect(headers['X-CacheKit-Misses']).toBe('3');

      await cache.close();
    });
  });
});

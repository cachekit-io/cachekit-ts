import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TTLCachekitIO } from './cachekitio-ttl.js';
import { CachekitIOCore } from './cachekitio.js';

function mockResponse(status: number, body?: object): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('TTLCachekitIO', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let ttlBackend: TTLCachekitIO;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const core = new CachekitIOCore({
      apiKey: 'ck_test_ttl',
      apiUrl: 'https://api.cachekit.io',
    });
    ttlBackend = new TTLCachekitIO(core);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getTTL returns seconds remaining', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { ttl: 3500 }));
    expect(await ttlBackend.getTTL('my-key')).toBe(3500);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('/v1/cache/my-key/ttl');
  });

  it('getTTL returns null on 404', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await ttlBackend.getTTL('missing')).toBeNull();
  });

  it('refreshTTL returns true on success', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { success: true }));
    expect(await ttlBackend.refreshTTL('key', 7200)).toBe(true);
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.method).toBe('PATCH');
  });

  it('refreshTTL returns false on 404', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await ttlBackend.refreshTTL('missing', 3600)).toBe(false);
  });

  it('sends JSON content type for TTL operations', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { success: true }));
    await ttlBackend.refreshTTL('key', 3600);
    const [, opts] = fetchSpy.mock.calls[0];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  // ── Missing branch coverage: error paths ───────────────────

  describe('getTTL error paths', () => {
    it('throws BackendError on HTTP error', async () => {
      const { BackendError } = await import('../errors.js');
      fetchSpy.mockResolvedValueOnce(mockResponse(500));
      await expect(ttlBackend.getTTL('key')).rejects.toThrow(BackendError);
    });

    it('throws TimeoutError on timeout network error', async () => {
      const { TimeoutError } = await import('../errors.js');
      const timeoutErr = new DOMException('signal timed out', 'TimeoutError');
      fetchSpy.mockRejectedValueOnce(timeoutErr);
      await expect(ttlBackend.getTTL('key')).rejects.toThrow(TimeoutError);
    });

    it('throws BackendError on generic network error', async () => {
      const { BackendError } = await import('../errors.js');
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(ttlBackend.getTTL('key')).rejects.toThrow(BackendError);
    });

    it('throws BackendError on unknown (non-Error) throw', async () => {
      const { BackendError } = await import('../errors.js');
      fetchSpy.mockRejectedValueOnce('string error');
      await expect(ttlBackend.getTTL('key')).rejects.toThrow(BackendError);
    });

    it('re-throws BackendError directly', async () => {
      const { BackendError } = await import('../errors.js');
      fetchSpy.mockResolvedValueOnce(mockResponse(401));
      const err = await ttlBackend.getTTL('key').catch((e: Error) => e);
      expect(err).toBeInstanceOf(BackendError);
      expect((err as Error).message).toContain('HTTP 401');
    });
  });

  describe('refreshTTL error paths', () => {
    it('throws BackendError on HTTP error', async () => {
      const { BackendError } = await import('../errors.js');
      fetchSpy.mockResolvedValueOnce(mockResponse(500));
      await expect(ttlBackend.refreshTTL('key', 3600)).rejects.toThrow(BackendError);
    });

    it('throws TimeoutError on timeout network error', async () => {
      const { TimeoutError } = await import('../errors.js');
      const timeoutErr = new DOMException('signal timed out', 'TimeoutError');
      fetchSpy.mockRejectedValueOnce(timeoutErr);
      await expect(ttlBackend.refreshTTL('key', 3600)).rejects.toThrow(TimeoutError);
    });

    it('throws BackendError on generic network error', async () => {
      const { BackendError } = await import('../errors.js');
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(ttlBackend.refreshTTL('key', 3600)).rejects.toThrow(BackendError);
    });

    it('throws BackendError on unknown (non-Error) throw', async () => {
      const { BackendError } = await import('../errors.js');
      fetchSpy.mockRejectedValueOnce('string error');
      await expect(ttlBackend.refreshTTL('key', 3600)).rejects.toThrow(BackendError);
    });

    it('re-throws BackendError directly', async () => {
      const { BackendError } = await import('../errors.js');
      fetchSpy.mockResolvedValueOnce(mockResponse(403));
      const err = await ttlBackend.refreshTTL('key', 3600).catch((e: Error) => e);
      expect(err).toBeInstanceOf(BackendError);
      expect((err as Error).message).toContain('HTTP 403');
    });
  });

  describe('delegate methods', () => {
    it('delegates get to inner backend', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
      expect(await ttlBackend.get('missing')).toBeNull();
    });

    it('delegates set to inner backend', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
      await ttlBackend.set('key', new Uint8Array([1, 2, 3]), 300);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/v1/cache/key');
      expect(opts.method).toBe('PUT');
    });

    it('delegates delete to inner backend', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
      expect(await ttlBackend.delete('key')).toBe(true);
    });

    it('delegates exists to inner backend', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
      expect(await ttlBackend.exists('key')).toBe(true);
    });

    it('delegates close to inner backend', async () => {
      await ttlBackend.close();
      const { BackendError } = await import('../errors.js');
      await expect(ttlBackend.get('key')).rejects.toThrow(BackendError);
    });
  });
});

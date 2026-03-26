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
});

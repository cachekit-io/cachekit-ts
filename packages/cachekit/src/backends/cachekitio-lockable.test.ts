import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LockableCachekitIO } from './cachekitio-lockable.js';
import { CachekitIOCore } from './cachekitio.js';
import { BackendError } from '../errors.js';

function mockResponse(status: number, body?: object): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('LockableCachekitIO', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let lockable: LockableCachekitIO;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const core = new CachekitIOCore({
      apiKey: 'ck_test_lock',
      apiUrl: 'https://api.cachekit.io',
    });
    lockable = new LockableCachekitIO(core);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('acquireLock returns lock_id on success', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { lock_id: 'uuid-123' }));
    const result = await lockable.acquireLock('my-key', 5000);
    expect(result).toBe('uuid-123');
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain('/v1/cache/my-key/lock');
    expect(opts.method).toBe('POST');
  });

  it('acquireLock returns null when contested', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { lock_id: null }));
    expect(await lockable.acquireLock('contested-key')).toBeNull();
  });

  it('releaseLock returns true on success', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { success: true }));
    expect(await lockable.releaseLock('key', 'lock-id')).toBe(true);
  });

  it('delegates get to inner backend', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await lockable.get('missing')).toBeNull();
  });

  it('throws BackendError on HTTP errors', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(500, { error: 'internal' }));
    await expect(lockable.acquireLock('key')).rejects.toThrow(BackendError);
  });

  it('sends JSON content type for lock operations', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { lock_id: 'id' }));
    await lockable.acquireLock('key', 5000);
    const [, opts] = fetchSpy.mock.calls[0];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });
});

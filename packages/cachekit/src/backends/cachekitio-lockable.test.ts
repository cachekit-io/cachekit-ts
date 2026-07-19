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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acquireLock returns lock_id on success', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { lock_id: 'uuid-123' }));
    const result = await lockable.acquireLock('my-key', 5000);
    expect(result).toBe('uuid-123');
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain('/v1/cache/my-key/lock');
    expect(opts.method).toBe('POST');
  });

  it('acquireLock returns null when contested (live SaaS shape: 200 + lock_id null)', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { lock_id: null }));
    expect(await lockable.acquireLock('contested-key')).toBeNull();
  });

  it('acquireLock returns null when contested (spec shape: 409 Conflict)', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(409));
    expect(await lockable.acquireLock('contested-key')).toBeNull();
  });

  it('releaseLock returns true on success', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { success: true }));
    expect(await lockable.releaseLock('key', 'lock-id')).toBe(true);
  });

  it('releaseLock sends lock_id in the X-CacheKit-Lock-Id header, not the URL (CWE-532)', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { success: true }));
    expect(await lockable.releaseLock('key', 'lock-secret')).toBe(true);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(opts.method).toBe('DELETE');
    // Capability token rides the header under the exact wire name...
    expect(opts.headers['X-CacheKit-Lock-Id']).toBe('lock-secret');
    // ...and never appears in the URL (no query smuggling / log leak).
    expect(url).not.toContain('lock_id');
    expect(url).not.toContain('lock-secret');
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

  // ── Bare-key lock contract (cachekit-py#135 parity) ────────
  //
  // cachekit-py's wrapper once appended ':lock' to the cache key before
  // acquire_lock, producing an 8th segment that the SaaS canonical-key
  // validator rejected (400 on every async cache miss). The LockableBackend
  // contract is a BARE key: lock semantics live in the URL path
  // (/v1/cache/{key}/lock), never in the key namespace.

  describe('bare-key lock contract (cachekit-py#135 parity)', () => {
    // Canonical 7-segment key — exactly what the SaaS validator accepts.
    const canonicalKey = `ns:app:func:mod.fn:args:${'a'.repeat(64)}:v1`;

    it('acquireLock sends the caller key verbatim — never a ":lock"-suffixed key', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, { lock_id: 'uuid-1' }));
      await lockable.acquireLock(canonicalKey, 1000);
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(`https://api.cachekit.io/v1/cache/${encodeURIComponent(canonicalKey)}/lock`);
      expect(decodeURIComponent(url)).not.toContain(':lock');
    });

    it('releaseLock sends the caller key verbatim — never a ":lock"-suffixed key', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, { success: true }));
      await lockable.releaseLock(canonicalKey, 'uuid-1');
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(`https://api.cachekit.io/v1/cache/${encodeURIComponent(canonicalKey)}/lock`);
      expect(decodeURIComponent(url)).not.toContain(':lock');
    });
  });

  // ── Missing branch coverage: error paths ───────────────────

  describe('acquireLock error paths', () => {
    it('throws TimeoutError on timeout network error', async () => {
      const { TimeoutError } = await import('../errors.js');
      const timeoutErr = new DOMException('signal timed out', 'TimeoutError');
      fetchSpy.mockRejectedValueOnce(timeoutErr);
      await expect(lockable.acquireLock('key')).rejects.toThrow(TimeoutError);
    });

    it('throws BackendError on generic network error', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(lockable.acquireLock('key')).rejects.toThrow(BackendError);
    });

    it('throws BackendError on unknown (non-Error) throw', async () => {
      fetchSpy.mockRejectedValueOnce('string error');
      await expect(lockable.acquireLock('key')).rejects.toThrow(BackendError);
    });

    it('re-throws BackendError directly', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(401));
      const err = await lockable.acquireLock('key').catch((e: Error) => e);
      expect(err).toBeInstanceOf(BackendError);
      expect((err as Error).message).toContain('HTTP 401');
    });
  });

  describe('releaseLock error paths', () => {
    it('throws BackendError on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(500));
      await expect(lockable.releaseLock('key', 'lock-id')).rejects.toThrow(BackendError);
    });

    it('throws TimeoutError on timeout network error', async () => {
      const { TimeoutError } = await import('../errors.js');
      const timeoutErr = new DOMException('signal timed out', 'TimeoutError');
      fetchSpy.mockRejectedValueOnce(timeoutErr);
      await expect(lockable.releaseLock('key', 'lock-id')).rejects.toThrow(TimeoutError);
    });

    it('throws BackendError on generic network error', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(lockable.releaseLock('key', 'lock-id')).rejects.toThrow(BackendError);
    });

    it('throws BackendError on unknown (non-Error) throw', async () => {
      fetchSpy.mockRejectedValueOnce('string error');
      await expect(lockable.releaseLock('key', 'lock-id')).rejects.toThrow(BackendError);
    });

    it('re-throws BackendError directly from catch', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(403));
      const err = await lockable.releaseLock('key', 'lock-id').catch((e: Error) => e);
      expect(err).toBeInstanceOf(BackendError);
      expect((err as Error).message).toContain('HTTP 403');
    });
  });

  describe('delegate methods', () => {
    it('delegates set to inner backend', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
      await lockable.set('key', new Uint8Array([1, 2, 3]), 300);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/v1/cache/key');
      expect(opts.method).toBe('PUT');
    });

    it('delegates delete to inner backend', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
      expect(await lockable.delete('key')).toBe(true);
    });

    it('delegates exists to inner backend', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
      expect(await lockable.exists('key')).toBe(true);
    });

    it('delegates close to inner backend', async () => {
      await lockable.close();
      // After close, operations should throw
      await expect(lockable.get('key')).rejects.toThrow(BackendError);
    });
  });
});

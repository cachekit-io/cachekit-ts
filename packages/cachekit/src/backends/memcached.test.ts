import { describe, it, expect, vi, beforeEach } from 'vitest';
import { memcached, MemcachedBackend, MAX_MEMCACHED_TTL } from './memcached.js';
import { BackendError, ConfigurationError, TimeoutError } from '../errors.js';

/**
 * MemcachedBackend unit tests against a mocked memjs client.
 *
 * This mock IS the documented CI strategy for LAB-430: unit tests exercise
 * every code path against a protocol-faithful fake (get returns
 * `{value, flags}`, set/delete/touch return booleans — the real memjs
 * promise API), while test/integration/memcached-backend.integration.test.ts
 * runs the same operations against a real memcached container when Docker is
 * available. CI's default `pnpm test` needs no memcached server.
 */

const mockClient = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  touch: vi.fn(),
  quit: vi.fn(),
};

const clientCreate = vi.fn(() => mockClient);

vi.mock('memjs', () => ({
  Client: {
    create: (...args: unknown[]) => clientCreate(...args),
  },
}));

describe('MemcachedBackend', () => {
  let backend: MemcachedBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.get.mockResolvedValue({ value: null, flags: null });
    mockClient.set.mockResolvedValue(true);
    mockClient.delete.mockResolvedValue(true);
    mockClient.touch.mockResolvedValue(true);
    backend = memcached();
  });

  describe('configuration', () => {
    it('rejects an empty server list', () => {
      expect(() => memcached({ servers: [] })).toThrow(ConfigurationError);
    });

    it.each(['no-port', 'host:notaport', 'host:0', 'host:70000'])(
      'rejects malformed server address %s',
      (server) => {
        expect(() => memcached({ servers: [server] })).toThrow(ConfigurationError);
      }
    );

    it('passes servers and second-based timeouts to memjs', async () => {
      const b = memcached({
        servers: ['mc1:11211', 'mc2:11212'],
        timeout: 500,
        connectTimeout: 3000,
        retries: 5,
      });
      await b.get('k'); // first op creates the client lazily
      expect(clientCreate).toHaveBeenCalledWith('mc1:11211,mc2:11212', {
        expires: 0,
        timeout: 0.5, // ms → s conversion for memjs
        conntimeout: 3,
        retries: 5,
      });
    });

    it('creates the client once and reuses it', async () => {
      await backend.get('a');
      await backend.get('b');
      expect(clientCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('get', () => {
    it('returns stored bytes as Uint8Array', async () => {
      mockClient.get.mockResolvedValue({ value: Buffer.from([1, 2, 3]), flags: null });
      expect(await backend.get('k')).toEqual(new Uint8Array([1, 2, 3]));
      expect(mockClient.get).toHaveBeenCalledWith('k');
    });

    it('returns null on miss', async () => {
      expect(await backend.get('k')).toBeNull();
    });

    it('wraps client errors in BackendError', async () => {
      mockClient.get.mockRejectedValue(new Error('boom'));
      await expect(backend.get('k')).rejects.toThrow(BackendError);
    });

    it('classifies timeouts as TimeoutError', async () => {
      mockClient.get.mockRejectedValue(new Error('operation timed out'));
      await expect(backend.get('k')).rejects.toThrow(TimeoutError);
    });
  });

  describe('set', () => {
    it('stores bytes with the given TTL', async () => {
      await backend.set('k', new Uint8Array([9]), 60);
      expect(mockClient.set).toHaveBeenCalledWith('k', Buffer.from([9]), { expires: 60 });
    });

    it('ttl omitted and defaultTtl unset → expires 0 / never (py parity, not Redis 1h)', async () => {
      await backend.set('k', new Uint8Array([9]));
      expect(mockClient.set).toHaveBeenCalledWith('k', Buffer.from([9]), { expires: 0 });
    });

    it('applies defaultTtl when ttl omitted', async () => {
      const b = memcached({ defaultTtl: 300 });
      await b.set('k', new Uint8Array([9]));
      expect(mockClient.set).toHaveBeenCalledWith('k', Buffer.from([9]), { expires: 300 });
    });

    it('clamps TTLs beyond 30 days (protocol treats them as unix timestamps)', async () => {
      await backend.set('k', new Uint8Array([9]), MAX_MEMCACHED_TTL + 999);
      expect(mockClient.set).toHaveBeenCalledWith('k', Buffer.from([9]), {
        expires: MAX_MEMCACHED_TTL,
      });
    });

    it('rejects oversized values client-side without calling the server', async () => {
      const b = memcached({ maxItemSizeBytes: 8 });
      await expect(b.set('k', new Uint8Array(9))).rejects.toThrow(/max\s+item size/);
      expect(mockClient.set).not.toHaveBeenCalled();
    });

    it('maxItemSizeBytes: 0 disables the size guard', async () => {
      const b = memcached({ maxItemSizeBytes: 0 });
      await b.set('k', new Uint8Array(2 * 1024 * 1024));
      expect(mockClient.set).toHaveBeenCalled();
    });
  });

  describe('delete / exists', () => {
    it('delete passes through the server result', async () => {
      expect(await backend.delete('k')).toBe(true);
      mockClient.delete.mockResolvedValue(false);
      expect(await backend.delete('gone')).toBe(false);
    });

    it('exists is GET-based (memcached has no EXISTS command)', async () => {
      mockClient.get.mockResolvedValue({ value: Buffer.from([1]), flags: null });
      expect(await backend.exists('k')).toBe(true);
      mockClient.get.mockResolvedValue({ value: null, flags: null });
      expect(await backend.exists('k')).toBe(false);
      expect(mockClient.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('refreshTTL', () => {
    it('touches the key with the clamped TTL', async () => {
      expect(await backend.refreshTTL('k', 60)).toBe(true);
      expect(mockClient.touch).toHaveBeenCalledWith('k', 60);

      await backend.refreshTTL('k', MAX_MEMCACHED_TTL + 1);
      expect(mockClient.touch).toHaveBeenLastCalledWith('k', MAX_MEMCACHED_TTL);
    });

    it('returns false when the key does not exist', async () => {
      mockClient.touch.mockResolvedValue(false);
      expect(await backend.refreshTTL('missing', 60)).toBe(false);
    });

    it('throws on ttl <= 0 (ts-wide refreshTTL contract)', async () => {
      await expect(backend.refreshTTL('k', 0)).rejects.toThrow(BackendError);
      await expect(backend.refreshTTL('k', -1)).rejects.toThrow(BackendError);
      expect(mockClient.touch).not.toHaveBeenCalled();
    });

    it('does not implement TTLBackend (no getTTL — protocol cannot read TTLs)', () => {
      expect('getTTL' in backend).toBe(false);
    });
  });

  describe('keyPrefix', () => {
    it('is applied to every operation and exposed for the interop guard', async () => {
      const b = memcached({ keyPrefix: 'app:' });
      expect(b.keyPrefix).toBe('app:');

      await b.get('k');
      expect(mockClient.get).toHaveBeenCalledWith('app:k');
      await b.set('k', new Uint8Array([1]), 60);
      expect(mockClient.set).toHaveBeenCalledWith('app:k', Buffer.from([1]), { expires: 60 });
      await b.delete('k');
      expect(mockClient.delete).toHaveBeenCalledWith('app:k');
      await b.refreshTTL('k', 60);
      expect(mockClient.touch).toHaveBeenCalledWith('app:k', 60);
    });

    it('defaults to empty (keys stored verbatim, interop-safe)', () => {
      expect(backend.keyPrefix).toBe('');
    });
  });

  describe('close', () => {
    it('quits the client and rejects further operations', async () => {
      await backend.get('k'); // materialize the client
      await backend.close();
      expect(mockClient.quit).toHaveBeenCalledTimes(1);
      await expect(backend.get('k')).rejects.toThrow('closed');
    });

    it('close before first use never creates a client', async () => {
      await backend.close();
      expect(clientCreate).not.toHaveBeenCalled();
    });

    it('close is idempotent', async () => {
      await backend.get('k');
      await backend.close();
      await backend.close();
      expect(mockClient.quit).toHaveBeenCalledTimes(1);
    });
  });
});

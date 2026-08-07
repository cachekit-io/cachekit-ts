import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackgroundRefreshManager } from './background-refresh.js';
import { L1Cache } from '../l1/lru-cache.js';

describe('BackgroundRefreshManager', () => {
  let manager: BackgroundRefreshManager;
  let l1Cache: L1Cache;
  let persistToL2: ReturnType<typeof vi.fn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    manager = new BackgroundRefreshManager();
    l1Cache = new L1Cache({ maxEntries: 100 });
    // The L2 write hands back what L1 should hold. For a plaintext cache that
    // is the value itself; a secure cache would return its ciphertext here.
    persistToL2 = vi.fn(async (_key: string, value: unknown) => ({ l1: value }));
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    manager.close();
    l1Cache.clear();
  });

  describe('scheduleRefresh', () => {
    it('should execute compute function and persist to L2', async () => {
      const computeFn = vi.fn().mockResolvedValue({ data: 'new' });
      const options = { ttl: 3600, namespace: 'test' };

      manager.scheduleRefresh('key1', computeFn, options, 0, null, persistToL2);

      // Wait for async execution
      await vi.waitFor(() => {
        expect(computeFn).toHaveBeenCalledTimes(1);
      });

      expect(persistToL2).toHaveBeenCalledWith('key1', { data: 'new' }, options);
    });

    it('registers the refresh with waitUntil, settling only after completion', async () => {
      let resolveCompute: (value: string) => void;
      const computeFn = vi.fn().mockReturnValue(
        new Promise<string>((resolve) => {
          resolveCompute = resolve;
        })
      );
      const registered: Promise<unknown>[] = [];
      const waitUntil = vi.fn((promise: Promise<unknown>) => {
        registered.push(promise);
      });

      manager.scheduleRefresh(
        'key1',
        computeFn,
        { ttl: 60, namespace: 'test' },
        0,
        null,
        persistToL2,
        waitUntil
      );

      // The platform handle received the refresh promise synchronously —
      // before the response could return.
      expect(waitUntil).toHaveBeenCalledTimes(1);

      resolveCompute!('done');
      await registered[0]; // resolves once L2 persistence finished
      expect(persistToL2).toHaveBeenCalledWith('key1', 'done', { ttl: 60, namespace: 'test' });
    });

    it('the promise handed to waitUntil never rejects, even when the refresh fails', async () => {
      const computeFn = vi.fn().mockRejectedValue(new Error('refresh boom'));
      const registered: Promise<unknown>[] = [];

      manager.scheduleRefresh(
        'key1',
        computeFn,
        { ttl: 60, namespace: 'test' },
        0,
        null,
        persistToL2,
        (promise) => registered.push(promise)
      );

      // A rejection here would surface as an unhandled rejection through
      // ctx.waitUntil — the refresh handles its own errors instead.
      await expect(registered[0]).resolves.toBeUndefined();
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should update L1 cache with version check on success', async () => {
      const computeFn = vi.fn().mockResolvedValue({ data: 'refreshed' });
      const options = { ttl: 3600, namespace: 'test' };

      // Set initial value in L1 with version 0
      l1Cache.set('key1', { data: 'old' }, 3600000, 'test');

      // Get version token
      const swrResult = l1Cache.getWithSwr('key1');
      const versionToken = swrResult.versionToken;

      manager.scheduleRefresh('key1', computeFn, options, versionToken, l1Cache, persistToL2);

      await vi.waitFor(() => {
        expect(persistToL2).toHaveBeenCalled();
      });

      // L1 should have updated value
      const cached = l1Cache.get('key1');
      expect(cached).toEqual({ data: 'refreshed' });
    });

    it('stores what the L2 write returned, not the plaintext it computed (LAB-238)', async () => {
      // A secure cache's persist callback returns the ciphertext it wrote to
      // L2. That, and never the factory's plaintext result, is what lands in
      // L1 — otherwise the SWR refresh re-poisons L1 on every revalidation.
      const ciphertext = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const secretPersist = vi.fn(async () => ({ l1: ciphertext }));
      const computeFn = vi.fn().mockResolvedValue({ ssn: '000-00-0000' });

      l1Cache.set('key1', ciphertext, 3600000, 'test');
      const { versionToken } = l1Cache.getWithSwr('key1');

      manager.scheduleRefresh(
        'key1',
        computeFn,
        { ttl: 3600, namespace: 'test' },
        versionToken,
        l1Cache,
        secretPersist
      );

      await vi.waitFor(() => {
        expect(secretPersist).toHaveBeenCalled();
      });

      expect(l1Cache.get('key1')).toBe(ciphertext);
      expect(JSON.stringify(l1Cache.get('key1'))).not.toContain('000-00-0000');
    });

    it('cancels the refresh when the write returns nothing storable', async () => {
      // Degraded L2 write on a secure cache: no ciphertext to show for it, so
      // L1 must keep the stale entry rather than fall back to the plaintext.
      const degraded = vi.fn(async () => null);
      const computeFn = vi.fn().mockResolvedValue({ data: 'fresh' });

      l1Cache.set('key1', { data: 'stale' }, 3600000, 'test');
      const { versionToken } = l1Cache.getWithSwr('key1');

      manager.scheduleRefresh(
        'key1',
        computeFn,
        { ttl: 3600, namespace: 'test' },
        versionToken,
        l1Cache,
        degraded
      );

      await vi.waitFor(() => {
        expect(degraded).toHaveBeenCalled();
      });

      expect(l1Cache.get('key1')).toEqual({ data: 'stale' });
      // Marker released, so the key can be refreshed again on a later read.
      expect(l1Cache.stats.refreshing).toBe(0);
    });

    it('should log error and cancel L1 refresh on failure', async () => {
      const error = new Error('Compute failed');
      const computeFn = vi.fn().mockRejectedValue(error);

      // Set initial value in L1
      l1Cache.set('key1', { data: 'old' }, 3600000, 'test');

      // Trigger SWR to mark as refreshing
      l1Cache.getWithSwr('key1');

      manager.scheduleRefresh(
        'key1',
        computeFn,
        { ttl: 3600, namespace: 'test' },
        0,
        l1Cache,
        persistToL2
      );

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          '[cachekit] Background refresh failed:',
          'Compute failed'
        );
      });

      // persistToL2 should not be called on error
      expect(persistToL2).not.toHaveBeenCalled();
    });

    it('should skip refresh if manager is closed', async () => {
      const computeFn = vi.fn().mockResolvedValue('value');

      manager.close();
      manager.scheduleRefresh(
        'key1',
        computeFn,
        { ttl: 60, namespace: 'test' },
        0,
        null,
        persistToL2
      );

      // Give it a tick to potentially execute
      await new Promise((r) => setTimeout(r, 10));

      // Should not have computed
      expect(computeFn).not.toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('should mark manager as closed', () => {
      expect(manager.isClosed).toBe(false);
      manager.close();
      expect(manager.isClosed).toBe(true);
    });

    it('should be idempotent', () => {
      manager.close();
      manager.close();
      expect(manager.isClosed).toBe(true);
    });
  });

  describe('null L1 cache handling', () => {
    it('should work without L1 cache', async () => {
      const computeFn = vi.fn().mockResolvedValue('value');

      manager.scheduleRefresh(
        'key1',
        computeFn,
        { ttl: 60, namespace: 'test' },
        0,
        null,
        persistToL2
      );

      await vi.waitFor(() => {
        expect(persistToL2).toHaveBeenCalled();
      });
    });
  });
});

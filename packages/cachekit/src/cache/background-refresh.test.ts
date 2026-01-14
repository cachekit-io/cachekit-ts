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
    persistToL2 = vi.fn().mockResolvedValue(undefined);
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

    it('should track refreshing keys during execution', async () => {
      let resolveCompute: () => void;
      const computePromise = new Promise<string>((resolve) => {
        resolveCompute = () => resolve('done');
      });
      const computeFn = vi.fn().mockReturnValue(computePromise);

      manager.scheduleRefresh('key1', computeFn, { ttl: 60, namespace: 'test' }, 0, null, persistToL2);

      // Key should be tracked while computing
      expect(manager.isRefreshing('key1')).toBe(true);
      expect(manager.refreshingCount).toBe(1);

      // Complete the computation
      resolveCompute!();
      await vi.waitFor(() => {
        expect(manager.isRefreshing('key1')).toBe(false);
      });
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
      manager.scheduleRefresh('key1', computeFn, { ttl: 60, namespace: 'test' }, 0, null, persistToL2);

      // Give it a tick to potentially execute
      await new Promise((r) => setTimeout(r, 10));

      // Should not have computed
      expect(computeFn).not.toHaveBeenCalled();
    });

    it('should clean up tracking even after error', async () => {
      const computeFn = vi.fn().mockRejectedValue(new Error('fail'));

      manager.scheduleRefresh('key1', computeFn, { ttl: 60, namespace: 'test' }, 0, null, persistToL2);

      await vi.waitFor(() => {
        expect(manager.isRefreshing('key1')).toBe(false);
      });
    });
  });

  describe('close', () => {
    it('should mark manager as closed', () => {
      expect(manager.isClosed).toBe(false);
      manager.close();
      expect(manager.isClosed).toBe(true);
    });

    it('should clear all refreshing keys', async () => {
      // Start a long-running refresh
      const computeFn = vi.fn().mockReturnValue(new Promise(() => {})); // Never resolves
      manager.scheduleRefresh('key1', computeFn, { ttl: 60, namespace: 'test' }, 0, null, persistToL2);

      expect(manager.refreshingCount).toBe(1);

      manager.close();

      expect(manager.refreshingCount).toBe(0);
    });

    it('should be idempotent', () => {
      manager.close();
      manager.close();
      expect(manager.isClosed).toBe(true);
    });
  });

  describe('isRefreshing', () => {
    it('should return false for unknown keys', () => {
      expect(manager.isRefreshing('unknown')).toBe(false);
    });
  });

  describe('null L1 cache handling', () => {
    it('should work without L1 cache', async () => {
      const computeFn = vi.fn().mockResolvedValue('value');

      manager.scheduleRefresh('key1', computeFn, { ttl: 60, namespace: 'test' }, 0, null, persistToL2);

      await vi.waitFor(() => {
        expect(persistToL2).toHaveBeenCalled();
      });
    });
  });
});

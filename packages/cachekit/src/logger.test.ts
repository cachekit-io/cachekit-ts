import { describe, it, expect, afterEach, vi } from 'vitest';
import { setLogger, logError } from './logger.js';
import { BackgroundRefreshManager } from './cache/background-refresh.js';

describe('pluggable logger (LAB-517)', () => {
  afterEach(() => {
    setLogger(null);
    vi.restoreAllMocks();
  });

  it('defaults to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logError('[cachekit] something failed:', new Error('boom'));
    expect(spy).toHaveBeenCalledWith('[cachekit] something failed:', expect.any(Error));
  });

  it('routes through a custom logger and silences console', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const custom = vi.fn();
    setLogger(custom);

    logError('[cachekit] something failed:', 'detail');

    expect(custom).toHaveBeenCalledWith('[cachekit] something failed:', 'detail');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a throwing custom logger never propagates out of logError', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setLogger(() => {
      throw new Error('logger bug');
    });

    expect(() => logError('[cachekit] report', 'detail')).not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(
      '[cachekit] logger threw; original report:',
      '[cachekit] report',
      'detail',
      expect.any(Error)
    );
  });

  it('a rejecting async logger is reported, never left as an unhandled rejection', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      setLogger(async () => {
        throw new Error('async logger bug');
      });

      expect(() => logError('[cachekit] report', 'detail')).not.toThrow();

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          '[cachekit] logger threw; original report:',
          '[cachekit] report',
          'detail',
          expect.objectContaining({ message: 'async logger bug' })
        );
      });
      // Unhandled-rejection detection runs after the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a throwing console.error fallback never escapes, sync or async', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('console sink down');
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      setLogger(() => {
        throw new Error('sync logger bug');
      });
      expect(() => logError('[cachekit] report', 'detail')).not.toThrow();

      setLogger(async () => {
        throw new Error('async logger bug');
      });
      expect(() => logError('[cachekit] report', 'detail')).not.toThrow();
      // Unhandled-rejection detection runs after the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('setLogger(null) restores the console.error default', () => {
    const custom = vi.fn();
    setLogger(custom);
    setLogger(null);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logError('[cachekit] back to default');
    expect(custom).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('[cachekit] back to default');
  });

  it('background refresh failures reach the custom logger', async () => {
    const custom = vi.fn();
    setLogger(custom);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const manager = new BackgroundRefreshManager();
    manager.scheduleRefresh(
      'ns:key',
      async () => {
        throw new Error('refresh exploded');
      },
      { ttl: 60, namespace: 'ns' },
      0,
      null,
      // PersistCallback contract: null = "nothing for L1 to hold".
      async () => null
    );

    await vi.waitFor(() => {
      expect(custom).toHaveBeenCalledWith(
        '[cachekit] Background refresh failed:',
        'refresh exploded'
      );
    });
    expect(consoleSpy).not.toHaveBeenCalled();
    manager.close();
  });
});

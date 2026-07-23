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
      async () => {}
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

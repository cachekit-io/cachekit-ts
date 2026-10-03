/**
 * A cachekit.io request that is accepted and never answered, through the
 * io preset. Each attempt has a 5 s timeout (the protocol's CACHEKIT_TIMEOUT
 * default), and the retry policy shares one 5 s deadline across attempts,
 * so a stalled op degrades after one attempt instead of 3 x 30 s (~90 s).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCache } from './intents.js';
import { setLogger } from './logger.js';

// Deliberately fake credential for fixtures.
const FAKE_API_KEY = 'ck_test_fake-not-a-secret'; // pragma: allowlist secret

/** fetch that never settles and rejects only when its signal aborts. */
function stubStalledFetch() {
  const fetch = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      })
  );
  vi.stubGlobal('fetch', fetch);
  // AbortSignal.timeout runs on Node's internal timers, which fake timers do
  // not control; rebuild it on setTimeout so the test can advance the clock.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  return fetch;
}

/** Run a cache op to completion under fake timers; return its result and fake ms elapsed. */
async function timed<T>(op: Promise<T>): Promise<{ result: T; elapsed: number }> {
  const start = Date.now();
  let settled = false;
  let result!: T;
  void op.then((r) => {
    settled = true;
    result = r;
  });
  while (!settled) await vi.advanceTimersByTimeAsync(100);
  return { result, elapsed: Date.now() - start };
}

describe('stalled cachekit.io request on the io preset', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLogger(null);
  });

  it('degrades a stalled get to null after one 5 s attempt', async () => {
    setLogger(() => {});
    vi.useFakeTimers();
    const fetch = stubStalledFetch();
    const cache = createCache.io({ apiKey: FAKE_API_KEY, metrics: false });

    const { result, elapsed } = await timed(cache.get('ns:stalled'));

    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThanOrEqual(5100);
    await cache.close();
  });

  it('opens the breaker for a serial caller: five stalled gets fit in the 60 s window', async () => {
    setLogger(() => {});
    vi.useFakeTimers();
    const fetch = stubStalledFetch();
    const cache = createCache.io({ apiKey: FAKE_API_KEY, metrics: false });

    for (let i = 0; i < 5; i++) {
      await timed(cache.get(`ns:k${i}`));
    }
    fetch.mockClear();

    const { result } = await timed(cache.get('ns:k5'));
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await cache.close();
  });

  it('keeps the per-attempt timeout overridable, and starts no attempt past the deadline', async () => {
    setLogger(() => {});
    vi.useFakeTimers();
    const fetch = stubStalledFetch();
    const cache = createCache.io({ apiKey: FAKE_API_KEY, metrics: false, timeout: 3000 });

    const { result, elapsed } = await timed(cache.get('ns:stalled'));

    // Attempt 2 starts at ~3.1 s, inside the 5 s deadline, and times out at
    // ~6.1 s; attempt 3 would start past the deadline, so it never does.
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(6000);
    expect(elapsed).toBeLessThanOrEqual(6300);
    await cache.close();
  });
});

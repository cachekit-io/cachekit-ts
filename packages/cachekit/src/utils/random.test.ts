import { describe, it, expect, vi, afterEach } from 'vitest';
import { secureRandomFloat } from './random.js';

describe('secureRandomFloat', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a value between 0 and 1', () => {
    for (let i = 0; i < 100; i++) {
      const value = secureRandomFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('uses crypto.getRandomValues internally', () => {
    // Spy on crypto.getRandomValues
    const spy = vi.spyOn(crypto, 'getRandomValues');
    secureRandomFloat();
    expect(spy).toHaveBeenCalled();
  });

  it('produces different values (not constant)', () => {
    const values = new Set<number>();
    for (let i = 0; i < 100; i++) {
      values.add(secureRandomFloat());
    }
    // Should have multiple unique values (extremely unlikely to get same value twice)
    expect(values.size).toBeGreaterThan(90);
  });

  it('does NOT use Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    secureRandomFloat();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('m7: PRNG usage in caching code', () => {
  it('L1Cache should use secureRandomFloat for SWR jitter', async () => {
    // This is a code inspection test - verify the import
    const { L1Cache } = await import('../l1/lru-cache.js');

    // Create a cache and access its internals
    const cache = new L1Cache({ swrEnabled: true, swrThresholdRatio: 0.5 });
    cache.set('key', 'value', 10000, 'test');

    // If Math.random is called during getWithSwr, this test should fail
    const mathRandomSpy = vi.spyOn(Math, 'random');
    cache.getWithSwr('key');

    // m7 fix: Math.random should NOT be called
    expect(mathRandomSpy).not.toHaveBeenCalled();
  });

  it('RetryPolicy should use secureRandomFloat for jitter', async () => {
    const { RetryPolicy } = await import('../reliability/retry.js');

    const policy = new RetryPolicy({
      maxAttempts: 3,
      baseDelay: 100,
      jitter: true,
    });

    const mathRandomSpy = vi.spyOn(Math, 'random');

    // Execute a failing operation to trigger retries
    let attempt = 0;
    await policy.execute(async () => {
      attempt++;
      if (attempt < 3) throw new Error('retry');
      return 'ok';
    });

    // m7 fix: Math.random should NOT be called during jitter calculation
    expect(mathRandomSpy).not.toHaveBeenCalled();
  });
});

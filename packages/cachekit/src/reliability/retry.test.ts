import { describe, it, expect, vi } from 'vitest';
import { RetryPolicy } from './retry';

describe('RetryPolicy', () => {
  it('succeeds on first attempt', async () => {
    const policy = new RetryPolicy();
    const fn = vi.fn().mockResolvedValue('success');

    const result = await policy.execute(fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelay: 1 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('success');

    const result = await policy.execute(fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after max attempts', async () => {
    const policy = new RetryPolicy({ maxAttempts: 2, baseDelay: 1 });
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(policy.execute(fn)).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('respects retryOn filter', async () => {
    const policy = new RetryPolicy({
      maxAttempts: 3,
      baseDelay: 1,
      retryOn: (err) => err.message.includes('RETRYABLE'),
    });

    const fn = vi.fn().mockRejectedValue(new Error('fatal error'));

    await expect(policy.execute(fn)).rejects.toThrow('fatal error');
    expect(fn).toHaveBeenCalledTimes(1); // No retry
  });

  it('applies exponential backoff', async () => {
    vi.useFakeTimers();

    const policy = new RetryPolicy({ maxAttempts: 3, baseDelay: 100, jitter: false });
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    // Catch promise rejection immediately to avoid unhandled rejection warnings
    const promise = policy.execute(fn).catch((err) => err);

    // First attempt immediate
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Second attempt after 100ms
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);

    // Third attempt after 200ms more
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(3);

    // Wait for all timers and verify error
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('fail');
    vi.useRealTimers();
  });
});

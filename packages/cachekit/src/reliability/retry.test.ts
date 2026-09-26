import { describe, it, expect, vi, afterEach } from 'vitest';
import { RetryPolicy } from './retry.js';
import { BackendError } from '../errors.js';

describe('RetryPolicy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('fail'));

    // Attach the assertion before advancing timers so the rejection is never unhandled
    const assertion = expect(policy.execute(fn)).rejects.toThrow('fail');

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
    await assertion;
  });

  describe('error classification', () => {
    it.each(['permanent', 'authentication'] as const)(
      '%s BackendError is attempted once',
      async (classification) => {
        const policy = new RetryPolicy({ maxAttempts: 3, baseDelay: 1 });
        const err = new BackendError('rejected', classification);
        const fn = vi.fn().mockRejectedValue(err);

        await expect(policy.execute(fn)).rejects.toBe(err);
        expect(fn).toHaveBeenCalledTimes(1);
      }
    );

    it('retryOn cannot widen retries to a permanent BackendError', async () => {
      const policy = new RetryPolicy({ maxAttempts: 3, baseDelay: 1, retryOn: () => true });
      const fn = vi.fn().mockRejectedValue(new BackendError('rejected', 'permanent'));

      await expect(policy.execute(fn)).rejects.toThrow('rejected');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['transient', new BackendError('down', 'transient')],
      ['timeout', new BackendError('slow', 'timeout')],
      ['unclassified', new BackendError('Unknown error')],
    ])('%s BackendError is retried maxAttempts times', async (_label, err) => {
      const policy = new RetryPolicy({ maxAttempts: 3, baseDelay: 1 });
      const fn = vi.fn().mockRejectedValue(err);

      await expect(policy.execute(fn)).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });
});

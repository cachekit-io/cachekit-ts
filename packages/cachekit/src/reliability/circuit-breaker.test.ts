import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';
import { CircuitBreakerOpenError } from '../errors.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 100,
      halfOpenMaxCalls: 2,
    });
  });

  it('starts in closed state', () => {
    expect(breaker.state).toBe('closed');
  });

  it('stays closed on success', async () => {
    await breaker.execute(() => Promise.resolve('ok'));
    expect(breaker.state).toBe('closed');
  });

  it('opens after failure threshold', async () => {
    const fail = () => Promise.reject(new Error('fail'));

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fail)).rejects.toThrow('fail');
    }

    expect(breaker.state).toBe('open');
  });

  it('throws CircuitBreakerOpenError when open', async () => {
    // Force open
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error()))).rejects.toThrow();
    }

    await expect(breaker.execute(() => Promise.resolve())).rejects.toThrow(CircuitBreakerOpenError);
  });

  it('transitions to half-open after timeout', async () => {
    vi.useFakeTimers();

    // Open the breaker
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error()))).rejects.toThrow();
    }
    expect(breaker.state).toBe('open');

    // Advance time past timeout
    vi.advanceTimersByTime(150);
    expect(breaker.state).toBe('half-open');

    vi.useRealTimers();
  });

  it('closes after successes in half-open', async () => {
    vi.useFakeTimers();

    // Open, then wait for half-open
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error()))).rejects.toThrow();
    }
    vi.advanceTimersByTime(150);
    expect(breaker.state).toBe('half-open');

    // Succeed twice
    await breaker.execute(() => Promise.resolve('ok'));
    await breaker.execute(() => Promise.resolve('ok'));

    expect(breaker.state).toBe('closed');

    vi.useRealTimers();
  });

  it('reopens on failure in half-open', async () => {
    vi.useFakeTimers();

    // Open, then wait for half-open
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error()))).rejects.toThrow();
    }
    vi.advanceTimersByTime(150);
    expect(breaker.state).toBe('half-open');

    // Fail once
    await expect(breaker.execute(() => Promise.reject(new Error()))).rejects.toThrow();
    expect(breaker.state).toBe('open');

    vi.useRealTimers();
  });

  it('enforces half-open max calls', async () => {
    vi.useFakeTimers();

    // Open, then wait for half-open
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error()))).rejects.toThrow();
    }
    vi.advanceTimersByTime(150);
    expect(breaker.state).toBe('half-open');

    // Make 2 successful calls (max)
    await breaker.execute(() => Promise.resolve('ok'));
    await breaker.execute(() => Promise.resolve('ok'));

    // Circuit should be closed now
    expect(breaker.state).toBe('closed');

    vi.useRealTimers();
  });

  it('reset returns to closed', async () => {
    // Open the breaker
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error()))).rejects.toThrow();
    }
    expect(breaker.state).toBe('open');

    breaker.reset();
    expect(breaker.state).toBe('closed');
  });

  it('rolling window prunes old failures', async () => {
    vi.useFakeTimers();

    const breaker2 = new CircuitBreaker({
      failureThreshold: 3,
      rollingWindow: 100,
    });

    // Record 2 failures
    for (let i = 0; i < 2; i++) {
      await expect(breaker2.execute(() => Promise.reject(new Error()))).rejects.toThrow();
    }
    expect(breaker2.state).toBe('closed');

    // Advance time past rolling window
    vi.advanceTimersByTime(150);

    // Old failures should be pruned, so 1 more failure shouldn't open it
    await expect(breaker2.execute(() => Promise.reject(new Error()))).rejects.toThrow();
    expect(breaker2.state).toBe('closed');

    vi.useRealTimers();
  });

  it('M6: concurrent requests in half-open must not exceed halfOpenMaxCalls limit', async () => {
    vi.useFakeTimers();

    // Create breaker with halfOpenMaxCalls = 2
    const concurrentBreaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 100,
      halfOpenMaxCalls: 2,
    });

    // Open the breaker
    for (let i = 0; i < 3; i++) {
      await expect(concurrentBreaker.execute(() => Promise.reject(new Error()))).rejects.toThrow();
    }
    expect(concurrentBreaker.state).toBe('open');

    // Advance to half-open
    vi.advanceTimersByTime(150);
    expect(concurrentBreaker.state).toBe('half-open');

    // Launch 10 concurrent requests that all "see" half-open state simultaneously
    // With the race condition bug, all 10 could pass the check before any increment
    let executedCount = 0;
    let rejectedCount = 0;

    const slowOperation = () =>
      new Promise<string>((resolve) => {
        // Simulate a slow operation (doesn't resolve immediately)
        setTimeout(() => {
          executedCount++;
          resolve('ok');
        }, 10);
      });

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        concurrentBreaker.execute(slowOperation).catch((e) => {
          if (e instanceof CircuitBreakerOpenError) {
            rejectedCount++;
          }
          return null;
        })
      );
    }

    // Advance time to let the slow operations complete
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all(promises);

    // With halfOpenMaxCalls = 2, at most 2 should have executed
    // The rest (8) should have been rejected with CircuitBreakerOpenError
    expect(executedCount).toBeLessThanOrEqual(2);
    expect(rejectedCount).toBeGreaterThanOrEqual(8);

    vi.useRealTimers();
  });

  it('M6: tryAcquireHalfOpenSlot returns false when limit reached', async () => {
    vi.useFakeTimers();

    const breaker3 = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 100,
      halfOpenMaxCalls: 2,
    });

    // Open the breaker
    for (let i = 0; i < 3; i++) {
      await expect(breaker3.execute(() => Promise.reject(new Error()))).rejects.toThrow();
    }

    // Advance to half-open
    vi.advanceTimersByTime(150);
    expect(breaker3.state).toBe('half-open');

    // First two acquire should succeed, third should fail
    expect(breaker3.tryAcquireHalfOpenSlot()).toBe(true);
    expect(breaker3.tryAcquireHalfOpenSlot()).toBe(true);
    expect(breaker3.tryAcquireHalfOpenSlot()).toBe(false);
    expect(breaker3.tryAcquireHalfOpenSlot()).toBe(false);

    vi.useRealTimers();
  });
});

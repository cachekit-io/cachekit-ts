import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';
import { BackendError, CircuitBreakerOpenError } from '../errors.js';

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

  afterEach(() => {
    // Fake timers are process-global; a failing assertion before a trailing
    // vi.useRealTimers() would otherwise freeze the clock for every later test.
    vi.useRealTimers();
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
  });

  describe('error classification', () => {
    const openThenHalfOpen = async () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(() => Promise.reject(new Error()))).rejects.toThrow();
      }
      vi.advanceTimersByTime(150);
      expect(breaker.state).toBe('half-open');
    };

    it.each(['permanent', 'authentication'] as const)(
      '%s BackendError never counts toward opening',
      async (classification) => {
        const err = new BackendError('rejected', classification);
        for (let i = 0; i < 10; i++) {
          await expect(breaker.execute(() => Promise.reject(err))).rejects.toBe(err);
        }
        expect(breaker.state).toBe('closed');
      }
    );

    it.each(['transient', 'timeout'] as const)(
      '%s BackendError counts toward opening',
      async (classification) => {
        for (let i = 0; i < 3; i++) {
          await expect(
            breaker.execute(() => Promise.reject(new BackendError('down', classification)))
          ).rejects.toThrow('down');
        }
        expect(breaker.state).toBe('open');
      }
    );

    it('a permanent error on a half-open probe frees its slot instead of wedging', async () => {
      await openThenHalfOpen();
      const err = new BackendError('rejected', 'permanent');

      // More permanent probes than halfOpenMaxCalls (2): each must free its slot.
      for (let i = 0; i < 4; i++) {
        await expect(breaker.execute(() => Promise.reject(err))).rejects.toBe(err);
      }
      expect(breaker.state).toBe('half-open');

      // successThreshold (2) healthy probes still close the breaker.
      await breaker.execute(() => Promise.resolve('ok'));
      await breaker.execute(() => Promise.resolve('ok'));
      expect(breaker.state).toBe('closed');
    });

    it('a probe that outlives its half-open round frees no slot in the next round', async () => {
      await openThenHalfOpen();
      let rejectStale!: (e: Error) => void;
      const stale = breaker.execute(() => new Promise((_, reject) => (rejectStale = reject)));

      // A second probe fails for real: open, then half-open again (a new round).
      await expect(
        breaker.execute(() => Promise.reject(new BackendError('down', 'transient')))
      ).rejects.toThrow();
      vi.advanceTimersByTime(150);
      expect(breaker.state).toBe('half-open');

      // Fill this round's two slots, then let the stale probe hit a permanent error.
      for (let i = 0; i < 2; i++) void breaker.execute(() => new Promise(() => {}));
      const err = new BackendError('rejected', 'permanent');
      rejectStale(err);
      await expect(stale).rejects.toBe(err);

      await expect(breaker.execute(() => Promise.resolve('ok'))).rejects.toThrow(
        'half-open limit reached'
      );
    });

    // Opens, goes half-open, starts a probe that stays in flight, then reopens and
    // goes half-open again: the pending probe now belongs to a finished round.
    // With observe false nothing reads `state`, so the open -> half-open
    // transition is still pending when the probe settles.
    const strandProbeAcrossRounds = async (observe = true) => {
      await openThenHalfOpen();
      let settle!: { resolve: (v: string) => void; reject: (e: Error) => void };
      const stale = breaker.execute(
        () => new Promise<string>((resolve, reject) => (settle = { resolve, reject }))
      );
      await expect(
        breaker.execute(() => Promise.reject(new BackendError('down', 'transient')))
      ).rejects.toThrow();
      vi.advanceTimersByTime(150);
      if (observe) expect(breaker.state).toBe('half-open');
      return { stale, settle };
    };

    it('a probe that outlives its round does not count toward closing the next', async () => {
      const { stale, settle } = await strandProbeAcrossRounds();
      await breaker.execute(() => Promise.resolve('ok'));
      settle.resolve('ok');
      await stale;
      // successThreshold is 2, but only one success came from this round.
      expect(breaker.state).toBe('half-open');
    });

    it.each([
      ['after', true],
      ['before', false],
    ])(
      'a probe that outlives its round does not reopen the next (settles %s state is read)',
      async (_, observe) => {
        const { stale, settle } = await strandProbeAcrossRounds(observe);
        settle.reject(new BackendError('down', 'transient'));
        await expect(stale).rejects.toThrow('down');
        expect(breaker.state).toBe('half-open');
      }
    );

    it('a call started before the breaker opened does not count toward half-open', async () => {
      let resolveEarly!: (v: string) => void;
      const early = breaker.execute(() => new Promise<string>((r) => (resolveEarly = r)));
      await openThenHalfOpen();
      await breaker.execute(() => Promise.resolve('ok'));
      resolveEarly('ok');
      await early;
      expect(breaker.state).toBe('half-open');
    });

    it('a transient error on a half-open probe still reopens', async () => {
      await openThenHalfOpen();
      await expect(
        breaker.execute(() => Promise.reject(new BackendError('down', 'transient')))
      ).rejects.toThrow();
      expect(breaker.state).toBe('open');
    });
  });
});

import { describe, it, expect } from 'vitest';
import { ReliabilityExecutor } from './executor.js';
import { CircuitBreakerOpenError } from '../errors.js';

describe('ReliabilityExecutor', () => {
  describe('constructor', () => {
    it('should create with no config (all patterns disabled)', () => {
      const executor = new ReliabilityExecutor();
      expect(executor.isConfigured).toBe(false);
      expect(executor.getCircuitBreakerState()).toBe(null);
    });

    it('should create with circuit breaker only', () => {
      const executor = new ReliabilityExecutor({
        circuitBreaker: { failureThreshold: 5 },
      });
      expect(executor.isConfigured).toBe(true);
      expect(executor.getCircuitBreakerState()).toBe('closed');
    });

    it('should create with retry only', () => {
      const executor = new ReliabilityExecutor({
        retry: { maxAttempts: 3 },
      });
      expect(executor.isConfigured).toBe(true);
    });

    it('should create with all patterns', () => {
      const executor = new ReliabilityExecutor({
        circuitBreaker: { failureThreshold: 5 },
        retry: { maxAttempts: 3 },
        degradation: true,
      });
      expect(executor.isConfigured).toBe(true);
    });
  });

  describe('execute', () => {
    it('should pass through successful operations', async () => {
      const executor = new ReliabilityExecutor();
      const result = await executor.execute(async () => 'success', 'fallback');
      expect(result).toBe('success');
    });

    it('should return fallback on failure with degradation enabled', async () => {
      const executor = new ReliabilityExecutor({ degradation: true });
      const result = await executor.execute(async () => {
        throw new Error('fail');
      }, 'fallback');
      expect(result).toBe('fallback');
    });

    it('should throw on failure with degradation disabled', async () => {
      const executor = new ReliabilityExecutor({ degradation: false });
      await expect(
        executor.execute(async () => {
          throw new Error('fail');
        }, 'fallback')
      ).rejects.toThrow('fail');
    });

    it('should retry on failure with retry configured', async () => {
      const executor = new ReliabilityExecutor({
        retry: { maxAttempts: 3, baseDelay: 10, jitter: false },
        degradation: false,
      });

      let attempts = 0;
      const result = await executor.execute(async () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return 'success';
      }, 'fallback');

      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should open circuit breaker after failures', async () => {
      const executor = new ReliabilityExecutor({
        circuitBreaker: { failureThreshold: 2, rollingWindow: 60000 },
        degradation: false,
      });

      // Fail twice to open circuit
      for (let i = 0; i < 2; i++) {
        try {
          await executor.execute(async () => {
            throw new Error('fail');
          }, null);
        } catch {
          // expected
        }
      }

      expect(executor.getCircuitBreakerState()).toBe('open');

      // Next call should fail fast with CircuitBreakerOpenError
      await expect(executor.execute(async () => 'success', null)).rejects.toThrow(
        CircuitBreakerOpenError
      );
    });

    it('should combine retry and circuit breaker', async () => {
      const executor = new ReliabilityExecutor({
        circuitBreaker: { failureThreshold: 5 },
        retry: { maxAttempts: 2, baseDelay: 10, jitter: false },
        degradation: false,
      });

      let attempts = 0;
      const result = await executor.execute(async () => {
        attempts++;
        if (attempts < 2) throw new Error('fail');
        return 'success';
      }, 'fallback');

      expect(result).toBe('success');
      expect(attempts).toBe(2);
      expect(executor.getCircuitBreakerState()).toBe('closed');
    });

    it('should degrade to fallback when circuit breaker is open', async () => {
      const executor = new ReliabilityExecutor({
        circuitBreaker: { failureThreshold: 1 },
        degradation: true,
      });

      // Trigger circuit breaker open
      await executor.execute(async () => {
        throw new Error('fail');
      }, null);
      expect(executor.getCircuitBreakerState()).toBe('open');

      // Should degrade to fallback
      const result = await executor.execute(async () => 'success', 'fallback');
      expect(result).toBe('fallback');
    });
  });

  describe('resetCircuitBreaker', () => {
    it('should reset circuit breaker to closed', async () => {
      const executor = new ReliabilityExecutor({
        circuitBreaker: { failureThreshold: 1 },
        degradation: false,
      });

      // Open circuit
      try {
        await executor.execute(async () => {
          throw new Error('fail');
        }, null);
      } catch {
        // expected
      }
      expect(executor.getCircuitBreakerState()).toBe('open');

      // Reset
      executor.resetCircuitBreaker();
      expect(executor.getCircuitBreakerState()).toBe('closed');
    });

    it('should be no-op when circuit breaker not configured', () => {
      const executor = new ReliabilityExecutor();
      executor.resetCircuitBreaker(); // should not throw
    });
  });

  describe('degradation defaults', () => {
    it('should enable degradation by default', async () => {
      const executor = new ReliabilityExecutor({});
      const result = await executor.execute(async () => {
        throw new Error('fail');
      }, 'fallback');
      expect(result).toBe('fallback');
    });

    it('should respect explicit degradation: false', async () => {
      const executor = new ReliabilityExecutor({ degradation: false });
      await expect(
        executor.execute(async () => {
          throw new Error('fail');
        }, 'fallback')
      ).rejects.toThrow('fail');
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { RedisInvalidationChannel } from './redis-channel.js';
import type { Redis } from 'ioredis';

describe('RedisInvalidationChannel', () => {
  // Mock Redis client
  const createMockRedis = (): Redis => {
    const mockSubscriber = {
      on: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      quit: vi.fn().mockResolvedValue(undefined),
    };

    return {
      duplicate: vi.fn(() => mockSubscriber),
      publish: vi.fn().mockResolvedValue(undefined),
    } as unknown as Redis;
  };

  describe('M8: subscriber leak prevention', () => {
    it('should not leak connections when start() is called multiple times', async () => {
      const mockRedis = createMockRedis();
      const channel = new RedisInvalidationChannel(mockRedis);

      // First start
      await channel.start();
      expect(mockRedis.duplicate).toHaveBeenCalledTimes(1);

      // Stop properly
      await channel.stop();

      // Second start - should create new subscriber
      await channel.start();
      expect(mockRedis.duplicate).toHaveBeenCalledTimes(2);

      // Cleanup
      await channel.stop();
    });

    it('should cleanup old subscriber when start() called without stop()', async () => {
      const mockSubscriber1 = {
        on: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        quit: vi.fn().mockResolvedValue(undefined),
      };

      const mockSubscriber2 = {
        on: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        quit: vi.fn().mockResolvedValue(undefined),
      };

      let callCount = 0;
      const mockRedis = {
        duplicate: vi.fn(() => {
          callCount++;
          return callCount === 1 ? mockSubscriber1 : mockSubscriber2;
        }),
        publish: vi.fn().mockResolvedValue(undefined),
      } as unknown as Redis;

      const channel = new RedisInvalidationChannel(mockRedis);

      // First start
      await channel.start();
      expect(mockSubscriber1.subscribe).toHaveBeenCalled();

      // Force restart without calling stop() first
      // This simulates what happens if running flag gets out of sync
      await channel.restart();

      // Old subscriber should have been cleaned up
      expect(mockSubscriber1.unsubscribe).toHaveBeenCalled();
      expect(mockSubscriber1.quit).toHaveBeenCalled();

      // New subscriber should be active
      expect(mockSubscriber2.subscribe).toHaveBeenCalled();

      // Cleanup
      await channel.stop();
    });

    it('should have only one active subscriber at a time', async () => {
      const subscribers: { quit: ReturnType<typeof vi.fn> }[] = [];

      const mockRedis = {
        duplicate: vi.fn(() => {
          const sub = {
            on: vi.fn(),
            subscribe: vi.fn().mockResolvedValue(undefined),
            unsubscribe: vi.fn().mockResolvedValue(undefined),
            quit: vi.fn().mockResolvedValue(undefined),
          };
          subscribers.push(sub);
          return sub;
        }),
        publish: vi.fn().mockResolvedValue(undefined),
      } as unknown as Redis;

      const channel = new RedisInvalidationChannel(mockRedis);

      // Start, then force restart
      await channel.start();
      await channel.restart();
      await channel.restart();

      // Should have created 3 subscribers
      expect(subscribers.length).toBe(3);

      // First two should have been quit
      expect(subscribers[0].quit).toHaveBeenCalled();
      expect(subscribers[1].quit).toHaveBeenCalled();

      // Last one should still be active (not quit)
      expect(subscribers[2].quit).not.toHaveBeenCalled();

      // Now stop
      await channel.stop();
      expect(subscribers[2].quit).toHaveBeenCalled();
    });
  });

  describe('basic functionality', () => {
    it('should return false for isAvailable when not started', () => {
      const mockRedis = createMockRedis();
      const channel = new RedisInvalidationChannel(mockRedis);
      expect(channel.isAvailable()).toBe(false);
    });

    it('should return true for isAvailable after start', async () => {
      const mockRedis = createMockRedis();
      const channel = new RedisInvalidationChannel(mockRedis);
      await channel.start();
      expect(channel.isAvailable()).toBe(true);
      await channel.stop();
    });

    it('should return false for isAvailable after stop', async () => {
      const mockRedis = createMockRedis();
      const channel = new RedisInvalidationChannel(mockRedis);
      await channel.start();
      await channel.stop();
      expect(channel.isAvailable()).toBe(false);
    });
  });
});

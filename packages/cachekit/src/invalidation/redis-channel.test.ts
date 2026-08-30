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

    it('should not start twice when already running', async () => {
      const mockRedis = createMockRedis();
      const channel = new RedisInvalidationChannel(mockRedis);
      await channel.start();
      await channel.start(); // second call should be a no-op
      expect(mockRedis.duplicate).toHaveBeenCalledTimes(1);
      await channel.stop();
    });

    it('stop is a no-op when not running', async () => {
      const mockRedis = createMockRedis();
      const channel = new RedisInvalidationChannel(mockRedis);
      await channel.stop(); // should not throw
    });

    it('uses custom channel name', async () => {
      const mockRedis = createMockRedis();
      const channel = new RedisInvalidationChannel(mockRedis, {
        channelName: 'custom:channel',
      });
      await channel.start();
      const mockSub = (mockRedis.duplicate as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(mockSub.subscribe).toHaveBeenCalledWith('custom:channel');
      await channel.stop();
    });
  });

  describe('publish', () => {
    it('publishes serialized event to channel', () => {
      const mockRedis = createMockRedis();
      const channel = new RedisInvalidationChannel(mockRedis);

      const event = {
        level: 'namespace' as const,
        namespace: 'users',
        timestamp: 12345,
        sourceInstance: 'inst-1',
      };
      channel.publish(event);

      expect(mockRedis.publish).toHaveBeenCalledWith('cachekit:invalidate', expect.any(Buffer));
    });

    it('logs but does not throw on publish error', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockRedis = createMockRedis();
      (mockRedis.publish as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('publish failed')
      );

      const channel = new RedisInvalidationChannel(mockRedis);
      channel.publish({
        level: 'namespace',
        namespace: 'users',
        timestamp: 12345,
        sourceInstance: 'inst-1',
      });

      // Wait for the async catch to fire
      await new Promise((r) => setTimeout(r, 10));
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to publish'),
        expect.any(String)
      );
      consoleError.mockRestore();
    });
  });

  describe('message handling', () => {
    it('dispatches deserialized events to callbacks', async () => {
      const mockSubscriber = {
        on: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        quit: vi.fn().mockResolvedValue(undefined),
      };

      const mockRedis = {
        duplicate: vi.fn(() => mockSubscriber),
        publish: vi.fn().mockResolvedValue(undefined),
      } as unknown as Redis;

      const channel = new RedisInvalidationChannel(mockRedis);
      const received: unknown[] = [];
      channel.subscribe((event) => received.push(event));
      await channel.start();

      // Simulate incoming message by calling the messageBuffer handler
      const messageHandler = mockSubscriber.on.mock.calls.find(
        (c: [string, unknown]) => c[0] === 'messageBuffer'
      )?.[1] as (channel: Buffer, message: Buffer) => void;

      // Serialize a test event
      const { serializeEvent } = await import('./event.js');
      const event = {
        level: 'namespace' as const,
        namespace: 'users',
        timestamp: 12345,
        sourceInstance: 'inst-1',
      };
      const serialized = serializeEvent(event);

      messageHandler(Buffer.from('cachekit:invalidate'), Buffer.from(serialized));

      expect(received).toHaveLength(1);
      expect((received[0] as { namespace: string }).namespace).toBe('users');

      await channel.stop();
    });

    it('ignores messages from wrong channel', async () => {
      const mockSubscriber = {
        on: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        quit: vi.fn().mockResolvedValue(undefined),
      };

      const mockRedis = {
        duplicate: vi.fn(() => mockSubscriber),
        publish: vi.fn().mockResolvedValue(undefined),
      } as unknown as Redis;

      const channel = new RedisInvalidationChannel(mockRedis);
      const received: unknown[] = [];
      channel.subscribe((event) => received.push(event));
      await channel.start();

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (c: [string, unknown]) => c[0] === 'messageBuffer'
      )?.[1] as (channel: Buffer, message: Buffer) => void;

      messageHandler(Buffer.from('wrong:channel'), Buffer.from([0x90]));
      expect(received).toHaveLength(0);

      await channel.stop();
    });

    it('logs deserialization errors without throwing', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockSubscriber = {
        on: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        quit: vi.fn().mockResolvedValue(undefined),
      };

      const mockRedis = {
        duplicate: vi.fn(() => mockSubscriber),
        publish: vi.fn().mockResolvedValue(undefined),
      } as unknown as Redis;

      const channel = new RedisInvalidationChannel(mockRedis);
      await channel.start();

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (c: [string, unknown]) => c[0] === 'messageBuffer'
      )?.[1] as (channel: Buffer, message: Buffer) => void;

      // Send invalid msgpack data
      messageHandler(Buffer.from('cachekit:invalidate'), Buffer.from([0xff, 0xff]));

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to deserialize'),
        expect.anything()
      );
      consoleError.mockRestore();
      await channel.stop();
    });

    it('logs callback errors without throwing', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockSubscriber = {
        on: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        quit: vi.fn().mockResolvedValue(undefined),
      };

      const mockRedis = {
        duplicate: vi.fn(() => mockSubscriber),
        publish: vi.fn().mockResolvedValue(undefined),
      } as unknown as Redis;

      const channel = new RedisInvalidationChannel(mockRedis);
      channel.subscribe(() => {
        throw new Error('callback boom');
      });
      await channel.start();

      const messageHandler = mockSubscriber.on.mock.calls.find(
        (c: [string, unknown]) => c[0] === 'messageBuffer'
      )?.[1] as (channel: Buffer, message: Buffer) => void;

      const { serializeEvent } = await import('./event.js');
      const event = {
        level: 'namespace' as const,
        namespace: 'users',
        timestamp: 12345,
        sourceInstance: 'inst-1',
      };

      messageHandler(Buffer.from('cachekit:invalidate'), Buffer.from(serializeEvent(event)));

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('callback error'),
        expect.anything()
      );
      consoleError.mockRestore();
      await channel.stop();
    });
  });

  describe('cleanup edge cases', () => {
    it('handles errors during cleanup gracefully', async () => {
      const mockSubscriber = {
        on: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockRejectedValue(new Error('unsub failed')),
        quit: vi.fn().mockRejectedValue(new Error('quit failed')),
      };

      const mockRedis = {
        duplicate: vi.fn(() => mockSubscriber),
        publish: vi.fn().mockResolvedValue(undefined),
      } as unknown as Redis;

      const channel = new RedisInvalidationChannel(mockRedis);
      await channel.start();
      // Stop should not throw even if cleanup fails
      await expect(channel.stop()).resolves.toBeUndefined();
    });
  });

  describe('LAB-2487: oversized event on publish', () => {
    it('publish() never throws and never transmits an event serializeEvent rejects', () => {
      const mockRedis = createMockRedis();
      const channel = new RedisInvalidationChannel(mockRedis);
      const oversized = {
        level: 'namespace' as const,
        namespace: 'n'.repeat(5000),
        timestamp: 12345,
        sourceInstance: 'instance-1',
      };
      // publish() is fire-and-forget by contract: the serializeEvent size
      // rejection must be logged, not propagated into the caller's write path.
      expect(() => channel.publish(oversized)).not.toThrow();
      expect(mockRedis.publish).not.toHaveBeenCalled();
    });
  });
});

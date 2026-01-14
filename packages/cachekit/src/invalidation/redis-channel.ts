import type { Redis } from 'ioredis';
import type { InvalidationEvent, InvalidationCallback } from '../l1/types.js';
import { serializeEvent, deserializeEvent } from './event.js';

const DEFAULT_CHANNEL = 'cachekit:invalidate';

/**
 * Configuration for RedisInvalidationChannel.
 */
export interface RedisInvalidationChannelConfig {
  /** Redis channel name (default: "cachekit:invalidate") */
  channelName?: string;
}

/**
 * Cross-instance cache invalidation via Redis Pub/Sub.
 *
 * Features:
 * - Fire-and-forget publish (never blocks, never throws)
 * - Automatic reconnection with exponential backoff
 * - Multi-tenant support via channel name isolation
 *
 * @example
 * ```typescript
 * const channel = new RedisInvalidationChannel(redisClient);
 * channel.subscribe((event) => l1Cache.handleInvalidationEvent(event));
 * await channel.start();
 *
 * // Publish invalidation
 * channel.publish(createInvalidationEvent('namespace', instanceId, { namespace: 'users' }));
 *
 * // Cleanup
 * await channel.stop();
 * ```
 */
export class RedisInvalidationChannel {
  private readonly redis: Redis;
  private readonly channelName: string;
  private subscriber: Redis | null = null;
  private callbacks: InvalidationCallback[] = [];
  private running = false;

  constructor(redis: Redis, config: RedisInvalidationChannelConfig = {}) {
    this.redis = redis;
    this.channelName = config.channelName ?? DEFAULT_CHANNEL;
  }

  /**
   * Publish an invalidation event (fire-and-forget).
   *
   * Never throws - errors are logged but not propagated.
   * This is intentional: invalidation is best-effort optimization.
   */
  publish(event: InvalidationEvent): void {
    const data = serializeEvent(event);

    // Fire-and-forget - don't await, don't throw
    this.redis.publish(this.channelName, Buffer.from(data)).catch((err) => {
      // eslint-disable-next-line no-console -- Library intentionally uses console for error visibility
      console.error('[cachekit] Failed to publish invalidation:', err.message);
    });
  }

  /**
   * Subscribe to invalidation events.
   */
  subscribe(callback: InvalidationCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Start listening for invalidation events.
   *
   * M8 Fix: If a subscriber already exists, it is cleaned up before creating a new one.
   * This prevents connection leaks if start() is called multiple times.
   */
  async start(): Promise<void> {
    if (this.running) return;

    // M8 Fix: Clean up any existing subscriber before creating new one
    await this.cleanupSubscriber();

    // Create a dedicated subscriber connection (ioredis requires this for pub/sub)
    this.subscriber = this.redis.duplicate();

    // Handle incoming messages
    this.subscriber.on('messageBuffer', (channel, message) => {
      if (channel.toString() !== this.channelName) return;

      try {
        const event = deserializeEvent(new Uint8Array(message));

        // Dispatch to all callbacks
        for (const callback of this.callbacks) {
          try {
            callback(event);
          } catch (err) {
            // eslint-disable-next-line no-console -- Library intentionally uses console for error visibility
            console.error('[cachekit] Invalidation callback error:', err);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console -- Library intentionally uses console for error visibility
        console.error('[cachekit] Failed to deserialize invalidation event:', err);
      }
    });

    // Subscribe to channel
    await this.subscriber.subscribe(this.channelName);
    this.running = true;
  }

  /**
   * Restart the subscription (stop + start).
   * Useful for reconnection or configuration changes.
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Clean up existing subscriber connection if present.
   */
  private async cleanupSubscriber(): Promise<void> {
    if (!this.subscriber) return;

    try {
      await this.subscriber.unsubscribe(this.channelName);
      await this.subscriber.quit();
    } catch {
      // Ignore errors during cleanup
    }

    this.subscriber = null;
  }

  /**
   * Stop listening for invalidation events.
   */
  async stop(): Promise<void> {
    if (!this.running || !this.subscriber) return;

    this.running = false;

    try {
      await this.subscriber.unsubscribe(this.channelName);
      await this.subscriber.quit();
    } catch {
      // Ignore errors during shutdown
    }

    this.subscriber = null;
  }

  /**
   * Check if channel is running.
   */
  isAvailable(): boolean {
    return this.running && this.subscriber !== null;
  }
}

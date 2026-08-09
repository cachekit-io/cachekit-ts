// Deliberately NOT `import type { Redis } from 'ioredis'`: this module's
// types flow into InvalidationConfig, which sits in the shared type closure
// re-exported by the workers entry — nominal ioredis types would drag
// @types/node requirements onto every Workers consumer (LAB-1388). The
// structural RedisPubSubLike covers exactly the Pub/Sub surface used here,
// and a real ioredis client satisfies it as-is.
import type { RedisPubSubLike } from '../types/cache.js';
import type { InvalidationEvent, InvalidationCallback } from '../l1/types.js';
import { logError } from '../logger.js';
import { serializeEvent, deserializeEvent } from './event.js';

const DEFAULT_CHANNEL = 'cachekit:invalidate';

/** Channel names are UTF-8; decode explicitly — the structural
 * RedisPubSubLike types messageBuffer args as Uint8Array, whose own
 * toString() is NOT utf-8. */
const utf8 = new TextDecoder();

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
  private readonly redis: RedisPubSubLike;
  private readonly channelName: string;
  private subscriber: RedisPubSubLike | null = null;
  private callbacks: InvalidationCallback[] = [];
  private running = false;

  constructor(redis: RedisPubSubLike, config: RedisInvalidationChannelConfig = {}) {
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
      logError('[cachekit] Failed to publish invalidation:', err.message);
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
      if (utf8.decode(channel) !== this.channelName) return;

      try {
        const event = deserializeEvent(new Uint8Array(message));

        // Dispatch to all callbacks
        for (const callback of this.callbacks) {
          try {
            callback(event);
          } catch (err) {
            logError('[cachekit] Invalidation callback error:', err);
          }
        }
      } catch (err) {
        logError('[cachekit] Failed to deserialize invalidation event:', err);
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

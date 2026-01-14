import type { L1Cache } from '../l1/lru-cache.js';

/**
 * Options for scheduling a background refresh.
 */
export interface RefreshOptions {
  /** TTL in seconds for the cached value */
  ttl: number;
  /** Namespace for cache entry */
  namespace: string;
}

/**
 * Callback for persisting refreshed values to L2 cache.
 */
export type PersistCallback<T> = (key: string, value: T, options: RefreshOptions) => Promise<void>;

/**
 * Manages stale-while-revalidate (SWR) background refreshes.
 *
 * Responsibilities:
 * - Track in-flight background refreshes
 * - Execute refresh operations asynchronously
 * - Coordinate L1 cache version tokens to prevent stale data resurrection
 * - Handle errors gracefully with logging
 * - Provide cleanup on cache close
 *
 * This class extracts SWR logic from CacheImpl for better separation of concerns.
 */
export class BackgroundRefreshManager {
  private readonly refreshingKeys = new Set<string>();
  private closed = false;

  /**
   * Schedule a background refresh for a cache key.
   *
   * The refresh happens asynchronously (fire-and-forget). Results are persisted
   * to L2 first, then L1 is updated with version check to prevent stale data.
   *
   * @param key - Cache key being refreshed
   * @param computeFn - Function to compute the new value
   * @param options - TTL and namespace for the cached value
   * @param versionToken - L1 version token at time of read (for staleness detection)
   * @param l1Cache - L1 cache instance (may be null if L1 disabled)
   * @param persistToL2 - Callback to persist value to L2 cache
   */
  scheduleRefresh<T>(
    key: string,
    computeFn: () => Promise<T>,
    options: RefreshOptions,
    versionToken: number,
    l1Cache: L1Cache | null,
    persistToL2: PersistCallback<T>
  ): void {
    // Track at manager level for cleanup on close
    this.refreshingKeys.add(key);

    // Fire-and-forget background refresh
    (async () => {
      try {
        // Skip if manager is closed (avoid operations on closed cache)
        if (this.closed) {
          return;
        }

        const result = await computeFn();

        // Update L2 FIRST (before version check)
        await persistToL2(key, result, options);

        // Then complete L1 refresh with version check
        // If version changed during L2 update, L1 update is rejected (stale data protection)
        if (l1Cache) {
          l1Cache.completeRefresh(key, result, options.ttl * 1000, versionToken);
        }
      } catch (error) {
        // Log error for observability
        // eslint-disable-next-line no-console
        console.error(
          '[cachekit] Background refresh failed:',
          error instanceof Error ? error.message : 'Unknown error'
        );

        if (l1Cache) {
          l1Cache.cancelRefresh(key);
        }
      } finally {
        // Always clean up tracking
        this.refreshingKeys.delete(key);
      }
    })();
  }

  /**
   * Check if a key is currently being refreshed.
   */
  isRefreshing(key: string): boolean {
    return this.refreshingKeys.has(key);
  }

  /**
   * Get count of in-flight refreshes.
   */
  get refreshingCount(): number {
    return this.refreshingKeys.size;
  }

  /**
   * Mark manager as closed and cancel all pending refreshes.
   * Called during cache shutdown.
   */
  close(): void {
    this.closed = true;
    this.refreshingKeys.clear();
  }

  /**
   * Check if manager is closed.
   */
  get isClosed(): boolean {
    return this.closed;
  }
}

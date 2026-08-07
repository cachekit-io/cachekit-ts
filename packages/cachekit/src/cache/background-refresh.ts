import type { L1Cache } from '../l1/lru-cache.js';
import { logError } from '../logger.js';

/**
 * Registers a background promise with the platform so it survives past the
 * current request — Cloudflare Workers' `ExecutionContext.waitUntil`. On
 * platforms where fire-and-forget is safe (Node), no handle is needed.
 */
export type WaitUntil = (promise: Promise<unknown>) => void;

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
 * What L1 should hold for an entry, as produced by the L2 write that just
 * landed: the ciphertext for a secure cache, the plain value otherwise.
 *
 * Wrapped rather than returned bare because a cached value may legitimately be
 * null or undefined — the wrapper is what distinguishes "store this" from
 * "there is nothing to store" (LAB-238).
 */
export interface L1Write {
  readonly l1: unknown;
}

/**
 * Callback for persisting refreshed values to L2 cache. Returns the payload
 * L1 should hold for the entry, or null when the write produced nothing L1 may
 * hold (a degraded write on a secure cache — no ciphertext to store, and the
 * refresh must not fall back to the plaintext it computed).
 */
export type PersistCallback<T> = (
  key: string,
  value: T,
  options: RefreshOptions
) => Promise<L1Write | null>;

/**
 * Manages stale-while-revalidate (SWR) background refreshes.
 *
 * Responsibilities:
 * - Execute refresh operations asynchronously
 * - Coordinate L1 cache version tokens to prevent stale data resurrection
 * - Handle errors gracefully with logging
 * - Provide cleanup on cache close
 *
 * This class extracts SWR logic from CacheImpl for better separation of concerns.
 */
export class BackgroundRefreshManager {
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
   * @param waitUntil - Platform handle that keeps the refresh alive past the
   *   current request (Workers ctx.waitUntil). Without it the refresh is
   *   fire-and-forget, which is only safe on platforms that never cancel
   *   pending work (Node).
   */
  scheduleRefresh<T>(
    key: string,
    computeFn: () => Promise<T>,
    options: RefreshOptions,
    versionToken: number,
    l1Cache: L1Cache | null,
    persistToL2: PersistCallback<T>,
    waitUntil?: WaitUntil
  ): void {
    // Background refresh. Note computeFn is invoked synchronously here (the
    // async body runs to its first await on invocation) — on workerd that
    // matters: the refresh's I/O is created inside the request that
    // triggered it, i.e. the same request whose waitUntil is passed in.
    const refresh = (async () => {
      try {
        // Skip if manager is closed (avoid operations on closed cache)
        if (this.closed) {
          return;
        }

        const result = await computeFn();

        // Update L2 FIRST (before version check). The write hands back what L1
        // should hold — for a secure cache the ciphertext it just produced,
        // never the plaintext `result` computed above (LAB-238).
        const persisted = await persistToL2(key, result, options);

        // Then complete L1 refresh with version check
        // If version changed during L2 update, L1 update is rejected (stale data protection)
        if (l1Cache) {
          if (!persisted) {
            // Nothing storable came back (degraded write on a secure cache):
            // release the marker and leave the stale entry to expire.
            l1Cache.cancelRefresh(key);
          } else {
            l1Cache.completeRefresh(
              key,
              persisted.l1,
              options.ttl * 1000,
              versionToken,
              options.namespace
            );
          }
        }
      } catch (error) {
        // Log error for observability
        logError(
          '[cachekit] Background refresh failed:',
          error instanceof Error ? error.message : 'Unknown error'
        );

        if (l1Cache) {
          l1Cache.cancelRefresh(key);
        }
      }
    })();

    // Register with the platform so the refresh survives response return.
    // The promise never rejects (errors are handled above), so this cannot
    // surface an unhandled rejection through waitUntil.
    //
    // Guard the registration call itself: waitUntil() is a synchronous
    // platform call that can throw (e.g. a caller reusing a wrapped function
    // across requests with a stale ExecutionContext). A failed registration
    // must forfeit only this refresh attempt, never the read that already
    // has a valid (stale) value to return. A stranded L1 marker
    // is bounded by SWR_REFRESH_MARKER_TTL_MS.
    try {
      waitUntil?.(refresh);
    } catch (error) {
      logError(
        '[cachekit] Failed to register background refresh with waitUntil:',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /**
   * Mark manager as closed.
   * Called during cache shutdown.
   */
  close(): void {
    this.closed = true;
  }

  /**
   * Check if manager is closed.
   */
  get isClosed(): boolean {
    return this.closed;
  }
}

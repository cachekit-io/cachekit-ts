import { L1Config, DEFAULT_L1_CONFIG, CacheEntry, SwrResult, InvalidationEvent } from './types.js';
import { secureRandomFloat } from '../utils/random.js';
import { extractNamespace } from '../serialization/key-generator.js';
import {
  SWR_JITTER_MIN,
  SWR_JITTER_RANGE,
  SWR_REFRESH_MARKER_TTL_MS,
  DEFAULT_L1_FALLBACK_SIZE,
} from '../constants.js';

/**
 * L1 in-memory cache with LRU eviction, SWR, and multi-level invalidation.
 *
 * Features:
 * - LRU eviction when maxEntries or maxMemory exceeded
 * - Stale-while-revalidate (SWR) with jitter
 * - Version tokens to prevent stale data resurrection
 * - Namespace-level invalidation (O(n) with namespace index)
 * - C1 fix: entryVersion cleaned up on LRU eviction
 * - C3 fix: maxConcurrentRefreshes limit enforced
 */
export class L1Cache<T = unknown> {
  private readonly config: L1Config;

  // Core data structures
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly namespaceIndex = new Map<string, Set<string>>();

  // SWR tracking: key → marker expiry timestamp. Markers expire
  // (SWR_REFRESH_MARKER_TTL_MS) because a refresh promise can be torn down
  // without settling — workerd drops waitUntil work at its deadline while
  // the isolate keeps serving — and a marker nobody clears would wedge the
  // key (and eventually all refresh slots) in a permanent "refreshing"
  // state. An expired marker merely allows a duplicate refresh, which
  // version tokens make benign.
  private readonly refreshingKeys = new Map<string, number>();
  private readonly entryVersion = new Map<string, number>();
  private versionCounter = 0;

  // Memory tracking
  private currentMemory = 0;

  // Instance ID for invalidation echo detection (m10 Fix: already readonly)
  private readonly instanceId = crypto.randomUUID();

  constructor(config: Partial<L1Config> = {}) {
    this.config = { ...DEFAULT_L1_CONFIG, ...config };
  }

  /**
   * Get a value from cache (simple get, no SWR).
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return null;
    }

    // Update last access for LRU
    entry.lastAccess = Date.now();

    return entry.value;
  }

  /**
   * Get with stale-while-revalidate semantics.
   * Returns value even if stale, with refresh hint.
   */
  getWithSwr(key: string): SwrResult<T> {
    const entry = this.cache.get(key);
    const version = this.entryVersion.get(key) ?? 0;

    if (!entry) {
      return {
        value: null,
        isFresh: false,
        shouldRefresh: false,
        versionToken: version,
      };
    }

    const now = Date.now();

    // Fully expired - don't return value
    if (now > entry.expiresAt) {
      this.delete(key);
      return {
        value: null,
        isFresh: false,
        shouldRefresh: false,
        versionToken: version,
      };
    }

    // Update last access
    entry.lastAccess = now;

    // Calculate SWR threshold with jitter (±10%)
    // m7 Fix: Use crypto PRNG instead of Math.random for unpredictable timing
    const jitter = SWR_JITTER_MIN + secureRandomFloat() * SWR_JITTER_RANGE;
    const swrThreshold = entry.originalTtl * this.config.swrThresholdRatio * jitter;
    const remainingTtl = entry.expiresAt - now;
    const isFresh = remainingTtl > swrThreshold;

    // Should refresh if stale AND SWR enabled AND not already refreshing AND under limit
    const shouldRefresh =
      this.config.swrEnabled &&
      !isFresh &&
      !this.isRefreshInFlight(key, now) &&
      this.hasRefreshSlot(now); // C3 fix

    if (shouldRefresh) {
      this.refreshingKeys.set(key, now + SWR_REFRESH_MARKER_TTL_MS);
    }

    return {
      value: entry.value,
      isFresh,
      shouldRefresh,
      versionToken: version,
    };
  }

  /**
   * Complete a SWR refresh, updating the cache if version matches.
   * Returns false if version changed (stale refresh result).
   *
   * Pass `namespace` when the caller knows it (wrap options) — deriving it
   * from the key only works for auto-mode keys; an interop key
   * `{ns}:{op}:{hash}` would be mis-grouped as `ns:op` and escape
   * namespace-level invalidation.
   */
  completeRefresh(
    key: string,
    value: T,
    ttl: number,
    versionToken: number,
    namespace?: string
  ): boolean {
    this.refreshingKeys.delete(key);

    // Check version - if changed, this refresh is stale
    const currentVersion = this.entryVersion.get(key) ?? 0;
    if (currentVersion !== versionToken) {
      return false; // Stale refresh, discard
    }

    // Update with new value
    this.set(key, value, ttl, namespace ?? extractNamespace(key));
    return true;
  }

  /**
   * Cancel a pending refresh (e.g., on error).
   */
  cancelRefresh(key: string): void {
    this.refreshingKeys.delete(key);
  }

  /**
   * Is a live (unexpired) refresh marker held for this key?
   * An expired marker is dropped on sight — the refresh that set it was
   * torn down without settling, so the key must become refreshable again.
   */
  private isRefreshInFlight(key: string, now: number): boolean {
    const markerExpiry = this.refreshingKeys.get(key);
    if (markerExpiry === undefined) return false;
    if (markerExpiry <= now) {
      this.refreshingKeys.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Concurrency gate for starting a refresh. At the limit, sweep expired
   * markers once before refusing — stranded markers must not permanently
   * consume refresh slots. The sweep is bounded: the map never grows past
   * maxConcurrentRefreshes entries.
   */
  private hasRefreshSlot(now: number): boolean {
    if (this.refreshingKeys.size < this.config.maxConcurrentRefreshes) return true;
    for (const [key, markerExpiry] of this.refreshingKeys) {
      if (markerExpiry <= now) this.refreshingKeys.delete(key);
    }
    return this.refreshingKeys.size < this.config.maxConcurrentRefreshes;
  }

  /**
   * Increment version counter with overflow protection.
   * Wraps at MAX_SAFE_INTEGER to prevent precision loss.
   */
  private incrementVersion(): number {
    this.versionCounter++;

    // Wrap at MAX_SAFE_INTEGER to prevent precision loss (2^53)
    if (this.versionCounter > Number.MAX_SAFE_INTEGER) {
      this.versionCounter = 1;
      // Clear all version tokens on wrap to prevent collisions
      this.entryVersion.clear();
    }

    return this.versionCounter;
  }

  /**
   * Set a value in cache.
   */
  set(key: string, value: T, ttl: number, namespace: string): void {
    // Estimate size (rough approximation)
    const size = this.estimateSize(value);

    // Evict if necessary
    while (
      (this.cache.size >= this.config.maxEntries ||
        this.currentMemory + size > this.config.maxMemory) &&
      this.cache.size > 0
    ) {
      this.evictLRU();
    }

    const now = Date.now();
    const entry: CacheEntry<T> = {
      value,
      expiresAt: now + ttl,
      originalTtl: ttl,
      size,
      namespace,
      lastAccess: now,
    };

    // Remove old entry memory tracking
    const oldEntry = this.cache.get(key);
    if (oldEntry) {
      this.currentMemory -= oldEntry.size;
      this.removeFromNamespaceIndex(key, oldEntry.namespace);
    }

    // Add new entry
    this.cache.set(key, entry);
    this.currentMemory += size;
    this.addToNamespaceIndex(key, namespace);

    // Bump version (prevents stale refresh from overwriting)
    this.entryVersion.set(key, this.incrementVersion());
  }

  /**
   * Delete a key from cache.
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.cache.delete(key);
    this.currentMemory -= entry.size;
    this.removeFromNamespaceIndex(key, entry.namespace);

    // Bump version to invalidate any pending refreshes
    this.entryVersion.set(key, this.incrementVersion());

    return true;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.cache.clear();
    this.namespaceIndex.clear();
    this.refreshingKeys.clear();
    this.entryVersion.clear();
    this.currentMemory = 0;
  }

  /**
   * Invalidate by key (params-level).
   */
  invalidateByKey(key: string): void {
    this.delete(key);
  }

  /**
   * Invalidate all keys in a namespace.
   */
  invalidateByNamespace(namespace: string): void {
    if (!this.config.namespaceIndex) {
      // Without index, scan all keys
      for (const [key, entry] of this.cache) {
        if (entry.namespace === namespace) {
          this.delete(key);
        }
      }
      return;
    }

    const keys = this.namespaceIndex.get(namespace);
    if (!keys) return;

    // Copy keys to avoid modification during iteration
    for (const key of [...keys]) {
      this.delete(key);
    }
  }

  /**
   * Invalidate all entries.
   */
  invalidateAll(): void {
    this.clear();
  }

  /**
   * Handle an invalidation event.
   */
  handleInvalidationEvent(event: InvalidationEvent): void {
    // Ignore events from this instance (echo detection)
    if (event.sourceInstance === this.instanceId) {
      return;
    }

    switch (event.level) {
      case 'global':
        this.invalidateAll();
        break;
      case 'namespace':
        if (event.namespace) {
          this.invalidateByNamespace(event.namespace);
        }
        break;
      case 'params':
        // For params-level, we'd need the full key
        // This is handled at a higher layer that knows the key format
        break;
    }
  }

  /**
   * Get cache statistics.
   */
  get stats() {
    return {
      entries: this.cache.size,
      memoryUsed: this.currentMemory,
      refreshing: this.refreshingKeys.size,
      namespaces: this.namespaceIndex.size,
    };
  }

  /**
   * Get instance ID for invalidation events.
   */
  get instanceID(): string {
    return this.instanceId;
  }

  // ========== Private Methods ==========

  /**
   * Evict the least recently used entry.
   * C1 FIX: Also cleans up entryVersion to prevent memory leak.
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey)!;
      this.cache.delete(oldestKey);
      this.currentMemory -= entry.size;
      this.removeFromNamespaceIndex(oldestKey, entry.namespace);

      // C1 FIX: Clean up entryVersion - safe because no in-flight refresh for evicted entry
      this.entryVersion.delete(oldestKey);
      this.refreshingKeys.delete(oldestKey);
    }
  }

  private addToNamespaceIndex(key: string, namespace: string): void {
    if (!this.config.namespaceIndex) return;

    let keys = this.namespaceIndex.get(namespace);
    if (!keys) {
      keys = new Set();
      this.namespaceIndex.set(namespace, keys);
    }
    keys.add(key);
  }

  private removeFromNamespaceIndex(key: string, namespace: string): void {
    if (!this.config.namespaceIndex) return;

    const keys = this.namespaceIndex.get(namespace);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) {
        this.namespaceIndex.delete(namespace);
      }
    }
  }

  private estimateSize(value: unknown): number {
    // Rough estimation - JSON stringify length as proxy
    // m2 Fix: Track visited objects to prevent infinite recursion on circular refs
    const visited = new WeakSet<object>();

    const estimate = (val: unknown): number => {
      // Handle primitives
      if (val === null || typeof val !== 'object') {
        try {
          return JSON.stringify(val).length * 2; // UTF-16 chars
        } catch {
          return DEFAULT_L1_FALLBACK_SIZE;
        }
      }

      // Check for circular reference
      if (visited.has(val as object)) {
        return 0; // Already counted, don't recurse
      }

      visited.add(val as object);

      try {
        return JSON.stringify(val).length * 2;
      } catch {
        return DEFAULT_L1_FALLBACK_SIZE;
      }
    };

    return estimate(value);
  }
}

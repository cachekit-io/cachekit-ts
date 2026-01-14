import {
  DEFAULT_L1_MAX_ENTRIES,
  DEFAULT_L1_MAX_MEMORY,
  DEFAULT_L1_SWR_THRESHOLD_RATIO,
  DEFAULT_L1_MAX_CONCURRENT_REFRESHES,
} from '../constants.js';

/**
 * L1 cache configuration.
 */
export interface L1Config {
  /** Maximum number of entries in the cache (default: 1000) */
  maxEntries: number;

  /** Maximum memory usage in bytes (default: 50MB) */
  maxMemory: number;

  /** Enable stale-while-revalidate (default: true) */
  swrEnabled: boolean;

  /**
   * SWR threshold as ratio of TTL (default: 0.5)
   * Entry is considered stale when remaining TTL < originalTTL * swrThresholdRatio
   */
  swrThresholdRatio: number;

  /**
   * Maximum concurrent SWR refreshes (default: 10)
   * C3 FIX: Prevents SWR cascade when L2 is slow
   */
  maxConcurrentRefreshes: number;

  /** Enable cross-instance invalidation (default: true) */
  invalidationEnabled: boolean;

  /**
   * Enable namespace index for namespace-level invalidation (default: true)
   * Uses extra memory but enables O(n) namespace invalidation
   */
  namespaceIndex: boolean;
}

/**
 * Default L1 configuration values.
 */
export const DEFAULT_L1_CONFIG: L1Config = {
  maxEntries: DEFAULT_L1_MAX_ENTRIES,
  maxMemory: DEFAULT_L1_MAX_MEMORY,
  swrEnabled: true,
  swrThresholdRatio: DEFAULT_L1_SWR_THRESHOLD_RATIO,
  maxConcurrentRefreshes: DEFAULT_L1_MAX_CONCURRENT_REFRESHES,
  invalidationEnabled: true,
  namespaceIndex: true,
};

/**
 * A single entry in the L1 cache.
 */
export interface CacheEntry<T = unknown> {
  /** The cached value */
  value: T;

  /** When this entry expires (Unix timestamp in ms) */
  expiresAt: number;

  /** Original TTL in milliseconds (used for SWR threshold calculation) */
  originalTtl: number;

  /** Approximate memory size in bytes */
  size: number;

  /** Namespace this entry belongs to (for namespace-level invalidation) */
  namespace: string;

  /** Last access time (Unix timestamp in ms) for LRU ordering */
  lastAccess: number;
}

/**
 * Result of a getWithSwr operation.
 */
export interface SwrResult<T> {
  /** The cached value (may be stale) */
  value: T | null;

  /** Whether the value is fresh (not past SWR threshold) */
  isFresh: boolean;

  /** Whether a background refresh should be triggered */
  shouldRefresh: boolean;

  /**
   * Version token for this cache entry.
   * Must be passed to completeRefresh to prevent stale data resurrection.
   */
  versionToken: number;
}

/**
 * Invalidation levels for cache clearing.
 */
export type InvalidationLevel = 'global' | 'namespace' | 'params';

/**
 * Invalidation event payload.
 */
export interface InvalidationEvent {
  /** Level of invalidation */
  level: InvalidationLevel;

  /** Namespace to invalidate (required if level is 'namespace' or 'params') */
  namespace?: string;

  /** Specific params hash to invalidate (required if level is 'params') */
  paramsHash?: string;

  /** When this event was created (Unix timestamp in ms) */
  timestamp: number;

  /** Instance ID that originated this event (for echo detection) */
  sourceInstance: string;
}

/**
 * Callback type for invalidation subscribers.
 */
export type InvalidationCallback = (event: InvalidationEvent) => void;

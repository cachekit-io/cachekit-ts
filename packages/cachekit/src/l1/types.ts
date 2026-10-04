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

  /**
   * Memory budget in bytes (default: 50MB). An estimate, not the heap
   * footprint: byte values (a secure cache's ciphertext) are charged their
   * byteLength; values the cache serialized or decoded, a fixed multiple of
   * the serialized length plus a fixed amount per object, array or binary
   * value and per element or entry it holds; anything else its JSON length
   * x 2. Some shapes still occupy several times their charge on the heap,
   * such as long arrays of tiny binary values or of small Maps and Sets, and
   * some far more, so `maxEntries` is the hard bound on L1's size. A value
   * charged above an eighth of `maxMemory` is not stored in L1 at all
   * (storing it would evict that much of L1 first), and the write drops any
   * older entry under its key; reads of it always miss L1: they are served
   * from L2, or recomputed when L2 cannot serve them. Must be finite and
   * greater than 0 (`undefined` means the default); anything else throws
   * `ConfigurationError`.
   */
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

  /**
   * Namespace to invalidate. Optional on the wire and not enforced by the
   * shape guard, despite what a 'namespace' level implies.
   *
   * This SDK never publishes one without it: `CacheImpl.invalidate()` reports
   * a namespace-level call with no namespace to its own caller and returns
   * without publishing. So a namespace-level event that arrives without one
   * came from some other publisher, and it invalidates nothing —
   * `handleInvalidationEvent` logs it and moves on.
   */
  namespace?: string;

  /**
   * Params hash to invalidate. Published but never consumed — no read path
   * acts on it and params-level events are a no-op in L1.
   */
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

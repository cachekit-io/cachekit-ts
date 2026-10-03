import { L1Config, DEFAULT_L1_CONFIG, CacheEntry, SwrResult, InvalidationEvent } from './types.js';
import { secureRandomFloat } from '../utils/random.js';
import { logError } from '../logger.js';
import { extractNamespace } from '../serialization/key-generator.js';
import {
  SWR_JITTER_MIN,
  SWR_JITTER_RANGE,
  SWR_REFRESH_MARKER_TTL_MS,
  DEFAULT_L1_FALLBACK_SIZE,
} from '../constants.js';

/**
 * What L1 charges per serialized (MessagePack) byte when the caller passes
 * the serialized length, so maxMemory means about what the JSON.stringify
 * estimate made it mean. That estimate charges JSON length x 2, which comes to
 * about 2x the MessagePack length for ASCII strings and 2.2-2.9x for objects
 * and rows of records; 2.5 sits between them. Number-heavy values ran about 4x
 * under the estimate and CJK text about 0.7x, so those shift the most.
 * Internal calibration, not a setting: kept off the public exports.
 */
const SERIALIZED_SIZE_FACTOR = 2.5;

/**
 * What L1 charges per array or map (object, Map, Set) when the caller passes
 * the value's container count, on top of SERIALIZED_SIZE_FACTOR. An empty
 * container serializes to one byte but is a whole heap object, so a byte
 * charge alone missed most of the cost of a value made of many small ones:
 * 2,000 empty objects held about 26x their charge. On 64-bit Node an empty
 * array measured 40 bytes of heap with its slot in the parent, an empty object
 * 64; 32 is the array without its slot, the least a container costs there.
 * With it such values hold under 2x their charge, ordinary shapes move toward
 * their real heap cost, and eviction on a mixed workload stays within about
 * 15% of the JSON.stringify estimate. Runtimes that compress pointers
 * (workerd) spend about half that, so they are charged high, never low.
 * Internal calibration, not a setting: kept off the public exports.
 */
const CONTAINER_SIZE = 32;

/**
 * An entry plus its links in the recency list. The list is what makes LRU
 * O(1): a hit moves its node to the tail, eviction takes the head, and
 * neither scans the Map.
 */
interface Node<T> extends CacheEntry<T> {
  readonly key: string;
  prev: Node<T> | null;
  next: Node<T> | null;
}

/**
 * L1 in-memory cache with LRU eviction, SWR, and multi-level invalidation.
 *
 * Features:
 * - O(1) LRU eviction when maxEntries or maxMemory exceeded
 * - Stale-while-revalidate (SWR) with jitter
 * - Version tokens to prevent stale data resurrection
 * - Namespace-level invalidation (O(n) with namespace index)
 * - C1 fix: entryVersion cleaned up on LRU eviction
 * - C3 fix: maxConcurrentRefreshes limit enforced
 */
export class L1Cache<T = unknown> {
  private readonly config: L1Config;

  // Core data structures
  private readonly cache = new Map<string, Node<T>>();
  // Recency list: head is the least recently used entry, tail the most.
  private head: Node<T> | null = null;
  private tail: Node<T> | null = null;
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

    this.touch(entry);

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

    this.touch(entry);

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
      entry.value !== null &&
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
    namespace?: string,
    serializedSize?: number,
    containers?: number
  ): boolean {
    this.refreshingKeys.delete(key);

    // Check version - if changed, this refresh is stale
    const currentVersion = this.entryVersion.get(key) ?? 0;
    if (currentVersion !== versionToken) {
      return false; // Stale refresh, discard
    }

    // Update with new value
    this.set(key, value, ttl, namespace ?? extractNamespace(key), serializedSize, containers);
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
   *
   * @param serializedSize - Byte length of the value's serialized form, when
   *   the caller already holds it. The entry is then charged a fixed
   *   multiple of that length against maxMemory instead of a
   *   JSON.stringify estimate. Ignored for byte values, which are charged
   *   their byteLength, and when it is not a finite non-negative number.
   * @param containers - How many arrays and maps the value holds, empty ones
   *   included, when the caller already counted them. Each adds a fixed
   *   charge on top of the serializedSize one. Ignored without a usable
   *   serializedSize, and when it is not a finite non-negative number.
   */
  set(
    key: string,
    value: T,
    ttl: number,
    namespace: string,
    serializedSize?: number,
    containers?: number
  ): void {
    const size = this.sizeOf(value, serializedSize, containers);

    // Take out the entry being replaced first, so it neither counts toward
    // maxEntries nor gets an unrelated entry evicted in its place.
    const oldEntry = this.cache.get(key);
    if (oldEntry) this.remove(oldEntry);

    // Evict if necessary
    while (
      (this.cache.size >= this.config.maxEntries ||
        this.currentMemory + size > this.config.maxMemory) &&
      this.head !== null
    ) {
      this.evictLRU();
    }

    const node: Node<T> = {
      key,
      value,
      // ttl <= 0 means "no expiry" (ts-wide Backend contract, LAB-1388) —
      // without this guard `now + 0` expires the entry on the very next
      // millisecond instead of caching it forever.
      expiresAt: ttl > 0 ? Date.now() + ttl : Infinity,
      originalTtl: ttl,
      size,
      namespace,
      prev: null,
      next: null,
    };
    this.cache.set(key, node);
    this.append(node);
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

    this.remove(entry);

    // Bump version to invalidate any pending refreshes
    this.entryVersion.set(key, this.incrementVersion());

    return true;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.cache.clear();
    this.head = null;
    this.tail = null;
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
        } else {
          // A foreign publisher sent an instruction nothing can carry out.
          // This class used to fail the shape guard and get logged by the
          // channel; accepting nil must not cost that signal.
          //
          // sourceInstance is untrusted text, so it is escaped here rather than
          // left to the sink: setLogger lets an application install any sink, and
          // the message reaches every one verbatim, console.error included.
          // JSON.stringify covers C0 controls and lone surrogates. The replace adds
          // what it leaves raw: DEL and the C1 range (NEL U+0085 is a line break,
          // CSI U+009B opens a terminal control sequence) and U+2028/U+2029, which
          // some log viewers break a line on. typeof, not String(): L1Cache is
          // exported, so a JS caller reaches this method with any value at all, and
          // the report on an error path must not be what throws. Sliced because
          // nothing else bounds it here: channel events are capped at 4KB, direct
          // callers not at all.
          const source =
            typeof event.sourceInstance === 'string'
              ? JSON.stringify(event.sourceInstance.slice(0, 64)).replace(
                  /[\u007f-\u009f\u2028\u2029]/g,
                  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
                )
              : 'unknown';
          logError(
            `[cachekit] Ignored namespace-level invalidation: no namespace on the event (sourceInstance=${source})`
          );
        }
        break;
      case 'params':
        // Nothing consumes this. No higher layer picks it up, and the `ph` on
        // the wire is a digest of the key string rather than the canonical
        // params hash, so it cannot be matched here: a remote instance keeps
        // serving the invalidated key until TTL. Tracked in LAB-4359.
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
    const oldest = this.head;
    if (!oldest) return;

    this.remove(oldest);

    // C1 FIX: Clean up entryVersion - safe because no in-flight refresh for evicted entry
    this.entryVersion.delete(oldest.key);
    this.refreshingKeys.delete(oldest.key);
  }

  /** Drop an entry from the Map, the recency list, the memory total and the namespace index. */
  private remove(node: Node<T>): void {
    this.cache.delete(node.key);
    this.unlink(node);
    this.currentMemory -= node.size;
    this.removeFromNamespaceIndex(node.key, node.namespace);
  }

  /** Mark an entry most recently used. */
  private touch(node: Node<T>): void {
    if (node === this.tail) return;
    this.unlink(node);
    this.append(node);
  }

  private append(node: Node<T>): void {
    node.prev = this.tail;
    node.next = null;
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;
  }

  private unlink(node: Node<T>): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
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

  private sizeOf(
    value: unknown,
    serializedSize: number | undefined,
    containers: number | undefined
  ): number {
    // Secure caches store the L2 ciphertext here (LAB-238), so the common
    // entry is a Uint8Array. JSON.stringify turns one into {"0":12,"1":34,…} —
    // roughly 14x its real size — which would blow the memory budget and evict
    // most of L1 on the first encrypted entry. Count the buffer instead.
    if (ArrayBuffer.isView(value)) return value.byteLength;

    // A cache write already holds the serialized bytes, so their length costs
    // nothing, where the estimate below stringifies the whole value.
    // Finite and non-negative only: a NaN would poison currentMemory for good.
    if (Number.isFinite(serializedSize) && serializedSize! >= 0) {
      const perContainer =
        Number.isFinite(containers) && containers! >= 0 ? containers! * CONTAINER_SIZE : 0;
      return serializedSize! * SERIALIZED_SIZE_FACTOR + perContainer;
    }
    return this.estimateSize(value);
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

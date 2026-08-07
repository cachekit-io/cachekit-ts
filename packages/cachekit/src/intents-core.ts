/**
 * Intent-based cache factory logic, shared across platform entrypoints.
 *
 * `buildIntents(baseCreate)` assembles the public `createCache` object over a
 * platform's base factory — Node (intents.ts) and Cloudflare Workers
 * (workers/index.ts) get identical intent semantics from one implementation.
 */

import type {
  CacheOptions,
  SecureCache,
  ReliabilityConfig,
  EncryptionConfig,
  InvalidationConfig,
} from './types/cache.js';
import type { L1Config } from './l1/types.js';
import type { MetricsConfig } from './metrics/prometheus.js';
import type { Backend } from './backends/types.js';
import type { SerializerConfig } from './serialization/serializer.js';
import { ConfigurationError } from './errors.js';

// ============================================================================
// Intent Option Types
// ============================================================================

/** Options shared by all intents. */
interface BaseIntentOptions {
  /** Default TTL in seconds (each intent has its own default) */
  ttl?: number;
  /** L1 (in-memory) cache configuration */
  l1?: Partial<L1Config> & { enabled?: boolean };
  /** Serializer configuration */
  serializer?: Partial<SerializerConfig>;
  /** Enable ByteStorage compression (default: true) */
  compression?: boolean;
  /** Cross-instance invalidation via Redis Pub/Sub */
  invalidation?: InvalidationConfig;
}

/**
 * Backend selection for the storage-agnostic intents (minimal / production /
 * secure): a Redis connection URL, or any pre-built {@link Backend} instance
 * (Workers KV / Cache API, custom backends). Exactly one of `url` /
 * `backend` — enforced at compile time here and at runtime for JS callers.
 */
type IntentBackendOptions =
  | {
      /** Redis connection URL */
      url: string;
      /** Redis key prefix */
      keyPrefix?: string;
      backend?: undefined;
    }
  | {
      /** Pre-built backend instance (e.g. `workersKV(...)`, a custom Backend) */
      backend: Backend;
      url?: undefined;
      keyPrefix?: undefined;
    };

/**
 * Options for `createCache.minimal()` — speed-first, no protection.
 *
 * Disables circuit breaker, retry, and degradation for maximum throughput.
 * Use for read-heavy, non-critical caching (product catalogs, public APIs).
 */
export type MinimalOptions = BaseIntentOptions & IntentBackendOptions;

/**
 * Options for `createCache.production()` — reliability-first.
 *
 * Enables circuit breaker (failureThreshold: 5), retry with backoff,
 * and graceful degradation. Full L1 with SWR.
 */
export type ProductionOptions = BaseIntentOptions &
  IntentBackendOptions & {
    /**
     * Enable Prometheus metrics (default: true), or pass a MetricsConfig to
     * customize prefix/labels/registry. Requires the optional `prom-client`
     * peer dependency — reports once through the library logger and degrades
     * to no-ops when it is missing.
     */
    metrics?: boolean | MetricsConfig;
    /** Override default reliability settings */
    reliability?: Partial<ReliabilityConfig>;
  };

/**
 * Options for `createCache.secure()` — zero-knowledge encryption.
 *
 * Production-grade reliability + AES-256-GCM client-side encryption.
 * Master key never leaves the client. GDPR/HIPAA/PCI-DSS compliant.
 */
export type SecureOptions = BaseIntentOptions &
  IntentBackendOptions & {
    /**
     * Master encryption key (hex-encoded, min 32 bytes / 64 hex chars).
     * Falls back to CACHEKIT_MASTER_KEY env var if not provided.
     */
    masterKey?: string;
    /**
     * Decrypt-only previous master keys (max 3, same hex format as
     * masterKey) retained during a key-rotation grace window. Falls back to
     * the CACHEKIT_PREVIOUS_MASTER_KEYS env var (comma-separated hex) if
     * not provided. More than 3 keys, or repeating masterKey, throws
     * ConfigurationError at load.
     */
    previousMasterKeys?: string[];
    /** Tenant ID for key derivation isolation */
    tenantId?: string;
    /**
     * Enable Prometheus metrics (default: true), or pass a MetricsConfig to
     * customize prefix/labels/registry. Requires the optional `prom-client`
     * peer dependency — reports once through the library logger and degrades
     * to no-ops when it is missing.
     */
    metrics?: boolean | MetricsConfig;
    /** Override default reliability settings */
    reliability?: Partial<ReliabilityConfig>;
  };

/**
 * Options for `createCache.io()` — SaaS backend (cachekit.io).
 *
 * Zero-infrastructure caching via api.cachekit.io. Full reliability enabled.
 * Optionally add encryption for zero-knowledge mode.
 */
export interface IOOptions extends BaseIntentOptions {
  /**
   * CacheKit API key (e.g., "ck_live_...").
   * Falls back to CACHEKIT_API_KEY env var if not provided.
   */
  apiKey?: string;
  /** Custom API endpoint (default: "https://api.cachekit.io") */
  apiUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Optional encryption config for zero-knowledge mode */
  encryption?: EncryptionConfig;
  /**
   * Enable Prometheus metrics (default: true), or pass a MetricsConfig to
   * customize prefix/labels/registry. Requires the optional `prom-client`
   * peer dependency — reports once through the library logger and degrades
   * to no-ops when it is missing.
   */
  metrics?: boolean | MetricsConfig;
  /** Override default reliability settings */
  reliability?: Partial<ReliabilityConfig>;
}

// ============================================================================
// CreateCacheFn — callable with intent properties
// ============================================================================

/**
 * The createCache function augmented with intent-based factory methods.
 * Generic over the platform's cache surface — Node returns SecureCache,
 * Workers returns WorkersCache (SecureCache + withExecutionContext).
 */
export interface CreateCacheFn<TCache extends SecureCache = SecureCache> {
  /** Create a cache with explicit options. */
  (options: CacheOptions): TCache;

  /** Speed-first cache: no circuit breaker, no retry, minimal L1. */
  minimal(options: MinimalOptions): TCache;

  /** Reliability-first cache: circuit breaker + retry + degradation + full L1. */
  production(options: ProductionOptions): TCache;

  /** Zero-knowledge encrypted cache: production reliability + AES-256-GCM. */
  secure(options: SecureOptions): TCache;

  /** SaaS-backed cache via cachekit.io: full reliability, zero infrastructure. */
  io(options: IOOptions): TCache;
}

// ============================================================================
// Production-grade reliability defaults (tighter than SDK defaults)
// ============================================================================

const PRODUCTION_RELIABILITY: ReliabilityConfig = {
  circuitBreaker: {
    failureThreshold: 5,
    successThreshold: 3,
    timeout: 5000,
    halfOpenMaxCalls: 3,
    rollingWindow: 60000,
  },
  retry: {
    maxAttempts: 3,
    baseDelay: 100,
    maxDelay: 5000,
  },
  degradation: true,
};

// ============================================================================
// Intent assembly
// ============================================================================

/**
 * Build the intent-augmented createCache over a platform's base factory.
 */
export function buildIntents<TCache extends SecureCache>(
  baseCreate: (options: CacheOptions) => TCache
): CreateCacheFn<TCache> {
  function createMinimal(options: MinimalOptions): TCache {
    const cacheOptions: CacheOptions = {
      backend: resolveIntentBackend(options, 'minimal'),
      defaultTtl: options.ttl ?? 300,
      l1: {
        ...options.l1,
        swrEnabled: false,
        invalidationEnabled: false,
        namespaceIndex: false,
      },
      reliability: {
        circuitBreaker: { failureThreshold: Infinity },
        degradation: false,
      },
      compression: options.compression,
      serializer: options.serializer,
      invalidation: options.invalidation,
    };

    return baseCreate(cacheOptions);
  }

  function createProduction(options: ProductionOptions): TCache {
    const cacheOptions: CacheOptions = {
      backend: resolveIntentBackend(options, 'production'),
      defaultTtl: options.ttl ?? 600,
      l1: withFullL1Defaults(options.l1),
      reliability: mergeReliability(PRODUCTION_RELIABILITY, options.reliability),
      compression: options.compression,
      metrics: options.metrics ?? true,
      serializer: options.serializer,
      invalidation: options.invalidation,
    };

    return baseCreate(cacheOptions);
  }

  function createSecure(options: SecureOptions): TCache {
    const masterKey = options.masterKey ?? envVar('CACHEKIT_MASTER_KEY');
    if (!masterKey) {
      throw new ConfigurationError(
        'createCache.secure() requires a master key. ' +
          'Provide masterKey in options or set CACHEKIT_MASTER_KEY environment variable.'
      );
    }

    const cacheOptions: CacheOptions = {
      backend: resolveIntentBackend(options, 'secure'),
      defaultTtl: options.ttl ?? 600,
      l1: withFullL1Defaults(options.l1),
      encryption: {
        masterKey,
        tenantId: options.tenantId,
        previousMasterKeys: options.previousMasterKeys ?? envPreviousMasterKeys(),
      },
      reliability: mergeReliability(PRODUCTION_RELIABILITY, options.reliability),
      compression: options.compression,
      metrics: options.metrics ?? true,
      serializer: options.serializer,
      invalidation: options.invalidation,
    };

    return baseCreate(cacheOptions);
  }

  function createIO(options: IOOptions): TCache {
    const apiKey = options.apiKey ?? envVar('CACHEKIT_API_KEY');
    if (!apiKey) {
      throw new ConfigurationError(
        'createCache.io() requires an API key. ' +
          'Provide apiKey in options or set CACHEKIT_API_KEY environment variable.'
      );
    }

    const cacheOptions: CacheOptions = {
      backend: {
        apiKey,
        apiUrl: options.apiUrl,
        timeout: options.timeout,
      },
      defaultTtl: options.ttl ?? 3600,
      l1: withFullL1Defaults(options.l1),
      encryption: options.encryption,
      reliability: mergeReliability(PRODUCTION_RELIABILITY, options.reliability),
      compression: options.compression,
      metrics: options.metrics ?? true,
      serializer: options.serializer,
      invalidation: options.invalidation,
    };

    return baseCreate(cacheOptions);
  }

  return Object.assign(baseCreate, {
    minimal: createMinimal,
    production: createProduction,
    secure: createSecure,
    io: createIO,
  }) as CreateCacheFn<TCache>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the backend for the storage-agnostic intents: a pre-built Backend
 * instance wins; otherwise the url becomes a Redis backend config. The
 * runtime guard covers JS callers the compile-time union can't reach.
 */
function resolveIntentBackend(
  options: IntentBackendOptions,
  intent: 'minimal' | 'production' | 'secure'
): CacheOptions['backend'] {
  if (options.backend !== undefined) {
    if (options.url !== undefined) {
      throw new ConfigurationError(
        `createCache.${intent}() accepts either url (Redis) or backend (instance), not both.`
      );
    }
    return options.backend;
  }
  if (options.url === undefined) {
    throw new ConfigurationError(
      `createCache.${intent}() requires a Redis url or a backend instance.`
    );
  }
  return { url: options.url, keyPrefix: options.keyPrefix };
}

/**
 * Full-featured L1 defaults shared by the production / secure / io intents
 * (SWR + invalidation + namespace index on unless overridden). `minimal`
 * deliberately does NOT use this — it hard-disables all three.
 */
function withFullL1Defaults(l1: BaseIntentOptions['l1']): CacheOptions['l1'] {
  return {
    ...l1,
    swrEnabled: l1?.swrEnabled ?? true,
    invalidationEnabled: l1?.invalidationEnabled ?? true,
    namespaceIndex: l1?.namespaceIndex ?? true,
  };
}

/**
 * Environment fallback that survives runtimes without a `process` global
 * (Cloudflare Workers without nodejs_compat). Explicit config always wins;
 * this is only the fallback path.
 */
function envVar(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

/**
 * Parse CACHEKIT_PREVIOUS_MASTER_KEYS (comma-separated hex) into a keyring
 * list. Whitespace around entries is tolerated; empty segments are dropped
 * (a trailing comma is not a key). Per-key validation — hex format, length,
 * the cap of 3, the masterKey collision — happens in EncryptionManagerCore,
 * identically to explicitly configured keys.
 */
function envPreviousMasterKeys(): string[] | undefined {
  const raw = envVar('CACHEKIT_PREVIOUS_MASTER_KEYS');
  if (!raw) return undefined;
  const keys = raw
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  return keys.length > 0 ? keys : undefined;
}

function mergeReliability(
  defaults: ReliabilityConfig,
  overrides?: Partial<ReliabilityConfig>
): ReliabilityConfig {
  if (!overrides) return defaults;
  return {
    circuitBreaker: overrides.circuitBreaker
      ? { ...defaults.circuitBreaker, ...overrides.circuitBreaker }
      : defaults.circuitBreaker,
    retry: overrides.retry ? { ...defaults.retry, ...overrides.retry } : defaults.retry,
    degradation: overrides.degradation ?? defaults.degradation,
  };
}

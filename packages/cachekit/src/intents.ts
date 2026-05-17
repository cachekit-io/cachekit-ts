/**
 * Intent-based cache factory functions.
 *
 * Each intent pre-configures the full stack (backend, reliability, encryption)
 * so users declare WHAT they want, not HOW to wire it.
 *
 * @example
 * ```typescript
 * // Speed-first, no protection
 * const cache = createCache.minimal({ url: 'redis://localhost:6379', ttl: 300 });
 *
 * // Reliability-first with circuit breaker + retry
 * const cache = createCache.production({ url: 'redis://localhost:6379', ttl: 600 });
 *
 * // Zero-knowledge encryption
 * const cache = createCache.secure({ url: 'redis://localhost:6379', masterKey: '...' });
 *
 * // SaaS backend (cachekit.io)
 * const cache = createCache.io({ apiKey: 'ck_live_...', ttl: 3600 });
 * ```
 */

import type {
  CacheOptions,
  SecureCache,
  ReliabilityConfig,
  EncryptionConfig,
  InvalidationConfig,
} from './types/cache.js';
import type { L1Config } from './l1/types.js';
import type { SerializerConfig } from './serialization/serializer.js';
import { createCache as _createCache } from './cache.js';
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
 * Options for `createCache.minimal()` — speed-first, no protection.
 *
 * Disables circuit breaker, retry, and degradation for maximum throughput.
 * Use for read-heavy, non-critical caching (product catalogs, public APIs).
 */
export interface MinimalOptions extends BaseIntentOptions {
  /** Redis connection URL */
  url: string;
  /** Redis key prefix */
  keyPrefix?: string;
}

/**
 * Options for `createCache.production()` — reliability-first.
 *
 * Enables circuit breaker (failureThreshold: 5), retry with backoff,
 * and graceful degradation. Full L1 with SWR.
 */
export interface ProductionOptions extends BaseIntentOptions {
  /** Redis connection URL */
  url: string;
  /** Redis key prefix */
  keyPrefix?: string;
  /** Enable Prometheus metrics (default: true) */
  metrics?: boolean;
  /** Override default reliability settings */
  reliability?: Partial<ReliabilityConfig>;
}

/**
 * Options for `createCache.secure()` — zero-knowledge encryption.
 *
 * Production-grade reliability + AES-256-GCM client-side encryption.
 * Master key never leaves the client. GDPR/HIPAA/PCI-DSS compliant.
 */
export interface SecureOptions extends BaseIntentOptions {
  /** Redis connection URL */
  url: string;
  /**
   * Master encryption key (hex-encoded, min 32 bytes / 64 hex chars).
   * Falls back to CACHEKIT_MASTER_KEY env var if not provided.
   */
  masterKey?: string;
  /** Tenant ID for key derivation isolation */
  tenantId?: string;
  /** Redis key prefix */
  keyPrefix?: string;
  /** Enable Prometheus metrics (default: true) */
  metrics?: boolean;
  /** Override default reliability settings */
  reliability?: Partial<ReliabilityConfig>;
}

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
  /** Enable Prometheus metrics (default: true) */
  metrics?: boolean;
  /** Override default reliability settings */
  reliability?: Partial<ReliabilityConfig>;
}

// ============================================================================
// CreateCacheFn — callable with intent properties
// ============================================================================

/** The createCache function augmented with intent-based factory methods. */
export interface CreateCacheFn {
  /** Create a cache with explicit options. */
  (options: CacheOptions): SecureCache;

  /** Speed-first cache: no circuit breaker, no retry, minimal L1. */
  minimal(options: MinimalOptions): SecureCache;

  /** Reliability-first cache: circuit breaker + retry + degradation + full L1. */
  production(options: ProductionOptions): SecureCache;

  /** Zero-knowledge encrypted cache: production reliability + AES-256-GCM. */
  secure(options: SecureOptions): SecureCache;

  /** SaaS-backed cache via cachekit.io: full reliability, zero infrastructure. */
  io(options: IOOptions): SecureCache;
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
// Factory Functions
// ============================================================================

function createMinimal(options: MinimalOptions): SecureCache {
  const cacheOptions: CacheOptions = {
    backend: {
      url: options.url,
      keyPrefix: options.keyPrefix,
    },
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

  return _createCache(cacheOptions);
}

function createProduction(options: ProductionOptions): SecureCache {
  const cacheOptions: CacheOptions = {
    backend: {
      url: options.url,
      keyPrefix: options.keyPrefix,
    },
    defaultTtl: options.ttl ?? 600,
    l1: {
      ...options.l1,
      swrEnabled: options.l1?.swrEnabled ?? true,
      invalidationEnabled: options.l1?.invalidationEnabled ?? true,
      namespaceIndex: options.l1?.namespaceIndex ?? true,
    },
    reliability: mergeReliability(PRODUCTION_RELIABILITY, options.reliability),
    compression: options.compression,
    metrics: options.metrics ?? true,
    serializer: options.serializer,
    invalidation: options.invalidation,
  };

  return _createCache(cacheOptions);
}

function createSecure(options: SecureOptions): SecureCache {
  const masterKey = options.masterKey ?? process.env.CACHEKIT_MASTER_KEY;
  if (!masterKey) {
    throw new ConfigurationError(
      'createCache.secure() requires a master key. ' +
        'Provide masterKey in options or set CACHEKIT_MASTER_KEY environment variable.'
    );
  }

  const cacheOptions: CacheOptions = {
    backend: {
      url: options.url,
      keyPrefix: options.keyPrefix,
    },
    defaultTtl: options.ttl ?? 600,
    l1: {
      ...options.l1,
      swrEnabled: options.l1?.swrEnabled ?? true,
      invalidationEnabled: options.l1?.invalidationEnabled ?? true,
      namespaceIndex: options.l1?.namespaceIndex ?? true,
    },
    encryption: {
      masterKey,
      tenantId: options.tenantId,
    },
    reliability: mergeReliability(PRODUCTION_RELIABILITY, options.reliability),
    compression: options.compression,
    metrics: options.metrics ?? true,
    serializer: options.serializer,
    invalidation: options.invalidation,
  };

  return _createCache(cacheOptions);
}

function createIO(options: IOOptions): SecureCache {
  const apiKey = options.apiKey ?? process.env.CACHEKIT_API_KEY;
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
    l1: {
      ...options.l1,
      swrEnabled: options.l1?.swrEnabled ?? true,
      invalidationEnabled: options.l1?.invalidationEnabled ?? true,
      namespaceIndex: options.l1?.namespaceIndex ?? true,
    },
    encryption: options.encryption,
    reliability: mergeReliability(PRODUCTION_RELIABILITY, options.reliability),
    compression: options.compression,
    metrics: options.metrics ?? true,
    serializer: options.serializer,
    invalidation: options.invalidation,
  };

  return _createCache(cacheOptions);
}

// ============================================================================
// Augmented createCache export
// ============================================================================

/** createCache with intent-based factory methods attached. */
export const createCache = Object.assign(_createCache, {
  minimal: createMinimal,
  production: createProduction,
  secure: createSecure,
  io: createIO,
}) as CreateCacheFn;

// ============================================================================
// Helpers
// ============================================================================

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

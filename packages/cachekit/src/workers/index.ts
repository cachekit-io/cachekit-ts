/**
 * Cloudflare Workers entrypoint (`@cachekit-io/cachekit/workers`, also the
 * `workerd` condition on the root export).
 *
 * Workers-safe surface: no node:* builtins (no nodejs_compat required), no
 * ioredis, no NAPI addon, no prom-client. Crypto and the ByteStorage wire
 * envelope run on the wasm32 build of cachekit-core
 * (@cachekit-io/cachekit-core-wasm, ~55 KB gzipped).
 *
 * Phase-1 deltas vs the Node entrypoint:
 * - Backends: CachekitIO (`createCache.io` / `backend: { apiKey }`) or a
 *   custom Backend instance. Redis-URL intents (minimal / production /
 *   secure) throw ConfigurationError.
 * - No cross-instance invalidation (Redis Pub/Sub is Node-only).
 * - No Prometheus metrics.
 *
 * @example
 * ```typescript
 * import { createCache } from '@cachekit-io/cachekit/workers';
 *
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     const cache = createCache.io({
 *       apiKey: env.CACHEKIT_API_KEY,
 *       encryption: { masterKey: env.CACHEKIT_MASTER_KEY },
 *     });
 *     const value = await cache.wrap(expensive, { namespace: 'api:answer', ttl: 300 })();
 *     return Response.json(value);
 *   },
 * };
 * ```
 */

// ============ Main API ============
import { createWorkersCache } from './runtime.js';
import { buildIntents } from '../intents-core.js';

/** createCache with intent-based factory methods attached (Workers). */
export const createCache = buildIntents(createWorkersCache);

export type {
  CreateCacheFn,
  MinimalOptions,
  ProductionOptions,
  SecureOptions,
  IOOptions,
} from '../intents-core.js';
export {
  cachekitio,
  cachekitioWithLocking,
  cachekitioWithTTL,
  cachekitioFull,
} from '../backends/cachekitio-factory.js';
export { CachekitIOCore } from '../backends/cachekitio.js';

// ============ Types ============
export type {
  Cache,
  SecureCache,
  CacheOptions,
  SetOptions,
  WrapOptions,
  EncryptionConfig,
  ReliabilityConfig,
} from '../types/cache.js';

export type {
  Backend,
  CachekitIOBackendConfig,
  LockableBackend,
  TTLBackend,
  L1Metrics,
} from '../backends/types.js';

export type { ErrorClassification } from '../backends/error-classifier.js';

export type { L1Config, InvalidationLevel, InvalidationEvent } from '../l1/types.js';

export type { CircuitBreakerConfig, CircuitState } from '../reliability/circuit-breaker.js';
export type { RetryConfig } from '../reliability/retry.js';
export type { SerializerConfig, Serializer } from '../serialization/serializer.js';

// ============ Error Classes ============
export {
  CachekitError,
  ConfigurationError,
  EncryptionError,
  IntegrityError,
  BackendError,
  CircuitBreakerOpenError,
  TimeoutError,
  ValueTooLargeError,
  NonceExhaustedError,
  SerializationError,
} from '../errors.js';

// ============ Optional Utilities ============
// Export for advanced users who want to customize
export { L1Cache } from '../l1/lru-cache.js';
export { CircuitBreaker } from '../reliability/circuit-breaker.js';
export { RetryPolicy } from '../reliability/retry.js';
export { withDegradation, withDegradationFn } from '../reliability/degradation.js';
export { MessagePackSerializer, defaultSerializer } from '../serialization/serializer.js';
export {
  generateKey,
  generateParamsHash,
  extractNamespace,
} from '../serialization/key-generator.js';
// Interop mode (interop/v1) — same caveats as the root entrypoint: interop
// keys must only be used against unprefixed clients (see Backend.keyPrefix).
export {
  generateInteropKey,
  encodeInteropValue,
  decodeInteropValue,
} from '../serialization/interop.js';
// wasm-backed drop-ins for the root entrypoint's NAPI-backed exports.
export { EncryptionManager, ByteStorage } from './runtime.js';

// ============ Constants ============
// Export for users who want to reference defaults programmatically
export * from '../constants.js';

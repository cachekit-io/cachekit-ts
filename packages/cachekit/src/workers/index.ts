/**
 * Cloudflare Workers entrypoint (`@cachekit-io/cachekit/workers`, also the
 * `workerd` condition on the root export).
 *
 * Workers-safe surface: no node:* builtins (no nodejs_compat required), no
 * ioredis, no NAPI addon, no prom-client. Crypto and the ByteStorage wire
 * envelope run on the wasm32 build of cachekit-core
 * (@cachekit-io/cachekit-core-wasm, ~55 KB gzipped).
 *
 * Deltas vs the Node entrypoint:
 * - Backends: CachekitIO (`createCache.io` / `backend: { apiKey }`), the
 *   native edge stores added in phase 2 — Workers KV (`workersKV`) and the
 *   Cache API (`workersCacheAPI`), both passed as `backend:` instances to
 *   createCache or any intent — or a custom Backend instance. Redis-URL
 *   intents (minimal / production / secure with `url`) throw
 *   ConfigurationError.
 * - No cross-instance invalidation (Redis Pub/Sub is Node-only).
 * - No Prometheus metrics.
 * - SWR background refresh requires binding the request's ExecutionContext
 *   (`cache.withExecutionContext(ctx)`, as below) so refreshes ride
 *   `ctx.waitUntil` — workerd cancels fire-and-forget work at response
 *   return. Without a bound context, reads fail safe to plain (no-SWR) L1
 *   gets.
 *
 * Create the cache ONCE per isolate and reuse it across requests (lazy
 * singleton, as below). Per-request creation derives a fresh encryptor per
 * request — nonce uniqueness then rests on the encryptor's random 64-bit
 * instance id instead of its monotonic counter, weakening the birthday
 * bound at very high volumes — and leaves wasm allocations behind on hot
 * isolates (Workers' FinalizationRegistry is best-effort). If you must
 * create short-lived caches, call `cache.close()` when done.
 * `withExecutionContext` does NOT create a new cache — it returns a cheap
 * request-scoped view over the singleton (same encryptor, same L1).
 *
 * @example
 * ```typescript
 * import { createCache, type WorkersCache } from '@cachekit-io/cachekit/workers';
 *
 * let cache: WorkersCache | null = null;
 *
 * export default {
 *   async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
 *     cache ??= createCache.io({
 *       apiKey: env.CACHEKIT_API_KEY,
 *       encryption: { masterKey: env.CACHEKIT_MASTER_KEY },
 *     });
 *     // Bind THIS request's context so SWR refreshes outlive the response.
 *     const requestCache = cache.withExecutionContext(ctx);
 *     const value = await requestCache.wrap(expensive, { namespace: 'api:answer', ttl: 300 })();
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

// ============ Shared surface (identical on the Node entrypoint) ============
export * from '../exports-common.js';

// ============ Workers-only exports ============
// wasm-backed drop-ins for the root entrypoint's NAPI-backed exports.
export { EncryptionManager, ByteStorage } from './runtime.js';

// SWR on Workers: bind the request's ExecutionContext per request so
// background refreshes ride ctx.waitUntil (see WorkersCache).
export type { WorkersCache } from './runtime.js';
export type { ExecutionContextLike, WaitUntil } from '../cache-core.js';

// Native edge storage backends (phase 2): Workers KV and the Cache API.
export {
  workersKV,
  WorkersKVBackend,
  KV_MIN_TTL_SECONDS,
  type WorkersKVBackendConfig,
  type KVNamespaceLike,
} from '../backends/workers-kv.js';
export {
  workersCacheAPI,
  CacheAPIBackend,
  type CacheAPIBackendConfig,
  type CacheLike,
  type CacheStorageLike,
} from '../backends/workers-cache-api.js';

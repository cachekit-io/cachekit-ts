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
 * Create the cache ONCE per isolate and reuse it across requests (lazy
 * singleton, as below). Per-request creation derives a fresh encryptor per
 * request — nonce uniqueness then rests on the encryptor's random 64-bit
 * instance id instead of its monotonic counter, weakening the birthday
 * bound at very high volumes — and leaves wasm allocations behind on hot
 * isolates (Workers' FinalizationRegistry is best-effort). If you must
 * create short-lived caches, call `cache.close()` when done.
 *
 * @example
 * ```typescript
 * import { createCache, type SecureCache } from '@cachekit-io/cachekit/workers';
 *
 * let cache: SecureCache | null = null;
 *
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     cache ??= createCache.io({
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

// ============ Shared surface (identical on the Node entrypoint) ============
export * from '../exports-common.js';

// ============ Workers-only exports ============
// wasm-backed drop-ins for the root entrypoint's NAPI-backed exports.
export { EncryptionManager, ByteStorage } from './runtime.js';

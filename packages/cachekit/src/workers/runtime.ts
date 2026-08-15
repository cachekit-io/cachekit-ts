/**
 * Cloudflare Workers runtime wiring: CachekitIO backend + wasm32
 * cachekit-core bindings (@cachekit-io/cachekit-core-wasm).
 *
 * Everything protocol-critical (AAD construction, envelope semantics,
 * interop) is shared with Node via cache-core.ts / manager-core.ts — this
 * file only swaps the platform bindings.
 *
 * Semantics deltas vs Node (documented in the README Workers section):
 * - Keys live in wasm linear memory, which is a host-readable ArrayBuffer —
 *   weaker isolation than NAPI's Rust heap. On Workers, the host is your own
 *   isolate, so the threat model is roughly JS-heap-equivalent; free()
 *   still zeroizes deterministically on dispose().
 * - wasm instantiation is a one-time synchronous cost per isolate.
 */

import {
  ensureInitialized,
  ByteStorage as WasmByteStorage,
  TenantKeys as WasmTenantKeys,
  deriveTenantKeys,
  encryptWithTenantKeys,
  decryptWithTenantKeys,
} from '@cachekit-io/cachekit-core-wasm';
import type { CacheOptions, SecureCache } from '../types/cache.js';
import type { CachekitIOBackendConfig } from '../backends/types.js';
import { cachekitio } from '../backends/cachekitio-factory.js';
import { CacheImpl, type CacheRuntime, type ExecutionContextLike } from '../cache-core.js';
import { EncryptionManagerCore, type EncryptionBindings } from '../encryption/manager-core.js';
import { ConfigurationError } from '../errors.js';

function wasmEncryptionBindings(): EncryptionBindings {
  ensureInitialized();
  return {
    deriveTenantKeys,
    encryptWithTenantKeys: (plaintext, aad, tenantKeys) =>
      encryptWithTenantKeys(plaintext, aad, tenantKeys as WasmTenantKeys),
    decryptWithTenantKeys: (ciphertext, aad, tenantKeys) =>
      decryptWithTenantKeys(ciphertext, aad, tenantKeys as WasmTenantKeys),
  };
}

/**
 * High-level encryption manager backed by the wasm32 cachekit-core build.
 *
 * Same protocol behavior as the Node EncryptionManager (AAD v0x03,
 * HKDF-SHA256 tenant keys, counter nonces, getEncryptionCount monitoring) —
 * both subclass EncryptionManagerCore and differ only in bindings.
 */
export class EncryptionManager extends EncryptionManagerCore {
  /**
   * @param masterKey - Hex-encoded master key (exactly 32 bytes = 64 hex chars)
   * @param tenantId - Optional tenant ID for key derivation isolation
   * @param previousMasterKeys - Decrypt-only previous master keys (max 3,
   *   same hex format) for a key-rotation grace window; reads attempt keys
   *   sequentially, current first, writes always use masterKey
   * @throws {ConfigurationError} if any key is invalid, more than 3 previous
   *   keys are configured, or masterKey appears in previousMasterKeys
   */
  constructor(masterKey: string, tenantId?: string, previousMasterKeys?: readonly string[]) {
    super(masterKey, tenantId, async () => wasmEncryptionBindings(), previousMasterKeys);
  }
}

/**
 * ByteStorage envelope codec (LZ4 + xxHash3-64) backed by the wasm build.
 * Byte-identical output to the NAPI ByteStorage.
 */
export class ByteStorage extends WasmByteStorage {
  constructor() {
    ensureInitialized();
    super();
  }
}

const workersRuntime: CacheRuntime = {
  resolveBackend(config: CacheOptions['backend']) {
    if ('get' in config) {
      return config;
    }
    if ('apiKey' in config) {
      return cachekitio(config as CachekitIOBackendConfig);
    }
    // RedisBackendConfig — ioredis is TCP + Node-only, never bundled here.
    throw new ConfigurationError(
      'Redis backends are not supported on Cloudflare Workers. ' +
        'Use the CachekitIO backend (createCache.io / backend: { apiKey }), ' +
        'Workers KV (backend: workersKV({ kv: env.MY_KV })), ' +
        'the Cache API (backend: workersCacheAPI()), ' +
        'or pass a custom Backend instance.'
    );
  },
  createByteStorage: () => new ByteStorage(),
  createEncryption: (config) =>
    new EncryptionManager(config.masterKey, config.tenantId, config.previousMasterKeys),
  // No createInvalidationChannel: Redis Pub/Sub is Node-only. cache-core
  // fails fast with a ConfigurationError if `invalidation` is configured.

  // workerd cancels fire-and-forget work when the response returns, and a
  // cancelled refresh never clears its "refreshing" marker — so SWR
  // refreshes only schedule through a request context bound via
  // cache.withExecutionContext(ctx) (they ride ctx.waitUntil). Reads
  // without a bound context fall back to plain L1 gets: no marker taken,
  // nothing to wedge.
  swrRequiresWaitUntil: true,
};

/**
 * The Workers cache surface: SecureCache plus the per-request context
 * binding that enables SWR background refreshes (see withExecutionContext).
 */
export interface WorkersCache extends SecureCache {
  /**
   * Bind the current request's ExecutionContext, returning a request-scoped
   * view (shared state, same nonce counters) whose SWR refreshes are kept
   * alive past response return via `ctx.waitUntil`. Wrap functions through
   * the view inside the fetch handler; without it, reads are plain L1 gets
   * (no SWR, fail-safe).
   */
  withExecutionContext(ctx: ExecutionContextLike): SecureCache;
}

/**
 * Create a configured cache instance on Cloudflare Workers.
 *
 * Same API as the Node createCache, with the Workers backend surface:
 * CachekitIO, Workers KV (`workersKV`), the Cache API (`workersCacheAPI`),
 * or any custom Backend instance — compression and zero-knowledge
 * encryption included. Redis backends and cross-instance invalidation are
 * Node-only. SWR background refresh requires binding the request's
 * ExecutionContext per request — `cache.withExecutionContext(ctx)` — so
 * workerd keeps the refresh alive past response return.
 */
export function createWorkersCache(options: CacheOptions): WorkersCache {
  return new CacheImpl(options, workersRuntime);
}

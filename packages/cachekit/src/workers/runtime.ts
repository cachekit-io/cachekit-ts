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
 *   weaker isolation than NAPI's Rust heap. On Workers the host is your own
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
import { CacheImpl, type CacheRuntime } from '../cache-core.js';
import { EncryptionManagerCore, type EncryptionBindings } from '../encryption/manager-core.js';
import { ConfigurationError } from '../errors.js';

function wasmEncryptionBindings(): EncryptionBindings {
  ensureInitialized();
  return {
    deriveTenantKeys: (masterKey, tenantId) => deriveTenantKeys(masterKey, tenantId),
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
   * @param masterKey - Hex-encoded master key (min 32 bytes = 64 hex chars)
   * @param tenantId - Optional tenant ID for key derivation isolation
   * @throws {ConfigurationError} if masterKey is invalid
   */
  constructor(masterKey: string, tenantId?: string) {
    super(masterKey, tenantId, async () => wasmEncryptionBindings());
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
        'Use the CachekitIO backend (createCache.io / backend: { apiKey }) ' +
        'or pass a custom Backend instance.'
    );
  },
  createByteStorage: () => new ByteStorage(),
  createEncryption: (config) => new EncryptionManager(config.masterKey, config.tenantId),
  // No createInvalidationChannel: Redis Pub/Sub is Node-only. cache-core
  // fails fast with a ConfigurationError if `invalidation` is configured.
};

/**
 * Create a configured cache instance on Cloudflare Workers.
 *
 * Same API as the Node createCache, with the phase-1 Workers surface:
 * CachekitIO (or custom Backend instance) backends, compression and
 * zero-knowledge encryption included. Redis backends and cross-instance
 * invalidation are Node-only.
 */
export function createWorkersCache(options: CacheOptions): SecureCache {
  return new CacheImpl(options, workersRuntime);
}

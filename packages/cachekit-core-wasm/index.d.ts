/**
 * wasm32 build of cachekit-core for Cloudflare Workers.
 *
 * Hand-written mirror of the wasm-bindgen-generated pkg/cachekit_core_wasm.d.ts
 * (kept in sync by scripts/build.sh's API-surface check) so TypeScript
 * consumers type-check without the Rust toolchain — same pattern as the
 * NAPI sibling's committed index.d.ts.
 *
 * Call `ensureInitialized()` before using any other export.
 */

/**
 * ByteStorage provides LZ4 compression with xxHash3-64 integrity verification.
 * Full msgpack envelope — byte-identical to the NAPI binding.
 */
export declare class ByteStorage {
  constructor();
  /** Zeroize and release the underlying wasm resources. */
  free(): void;
  /** Pack data with LZ4 compression and xxHash3-64 integrity checksum. */
  pack(data: Uint8Array): Uint8Array;
  /** Unpack data, verifying xxHash3-64 integrity and decompressing LZ4. */
  unpack(packed: Uint8Array): Uint8Array;
  /** Validate packed data without extracting. */
  validate(packed: Uint8Array): boolean;
}

/**
 * Per-tenant derived keys with automatic zeroization. Keys stay in wasm
 * linear memory and are zeroized on `free()`.
 */
export declare class TenantKeys {
  private constructor();
  /** Zeroize keys and release the underlying wasm resources. */
  free(): void;
  /** Tenant ID these keys were derived for. */
  readonly tenantId: string;
  /** Encryption key fingerprint (safe to log/expose). */
  encryptionFingerprint(): Uint8Array;
  /** Current nonce counter value — rotate before 2^32. */
  getNonceCounter(): number;
}

/** Derive a 32-byte domain key using HKDF-SHA256 (RFC 5869). */
export declare function deriveKey(
  masterKey: Uint8Array,
  domain: string,
  tenantSalt: string
): Uint8Array;

/**
 * Derive per-tenant keys (encryption / authentication / cache_keys domains).
 *
 * `previousMasterKeys` (max 3, each 32 bytes) holds decrypt-only previous
 * master keys retained during a key-rotation grace window: reads attempt
 * keys sequentially, current first, identical AAD per attempt; writes always
 * use `masterKey`.
 */
export declare function deriveTenantKeys(
  masterKey: Uint8Array,
  tenantId: string,
  previousMasterKeys?: Uint8Array[] | null
): TenantKeys;

/** Encrypt with AES-256-GCM: [nonce(12)][ciphertext][auth_tag(16)]. */
export declare function encryptWithTenantKeys(
  plaintext: Uint8Array,
  aad: Uint8Array,
  tenantKeys: TenantKeys
): Uint8Array;

/** Decrypt AES-256-GCM ciphertext produced by any CacheKit SDK. */
export declare function decryptWithTenantKeys(
  ciphertext: Uint8Array,
  aad: Uint8Array,
  tenantKeys: TenantKeys
): Uint8Array;

/** cachekit-core-wasm crate version. */
export declare function version(): string;

/** wasm-bindgen low-level init escape hatch (prefer ensureInitialized). */
export declare function initSync(
  module: { module: BufferSource | WebAssembly.Module } | BufferSource | WebAssembly.Module
): unknown;

/** Instantiate the bundled wasm module (synchronous, idempotent). */
export declare function ensureInitialized(): void;

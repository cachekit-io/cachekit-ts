//! wasm32 bindings for cachekit-core (Cloudflare Workers).
//!
//! Mirrors the NAPI surface in ../cachekit-core-ts so the SDK's
//! `EncryptionManager` and `ByteStorage` consumers work unchanged on Workers:
//! same function names, same TenantKeys pattern (keys derived once, held in
//! Rust/wasm memory, zeroized on free), same counter-nonce encryptor.
//!
//! Security nuance (documented in the SDK): wasm linear memory is a
//! host-readable ArrayBuffer, so "keys stay in Rust memory" is weaker than
//! under NAPI. On Workers, the host is your own isolate, making this roughly
//! JS-heap-equivalent in threat model; zeroize-on-drop (via `free()`) still
//! gives deterministic cleanup.

#![deny(clippy::all)]

use wasm_bindgen::prelude::*;

use cachekit_core::encryption::key_derivation::{
    derive_tenant_keys as core_derive_tenant_keys, TenantKeys as CoreTenantKeys,
};
use cachekit_core::encryption::{derive_domain_key, ZeroKnowledgeEncryptor};
use cachekit_core::ByteStorage as CoreByteStorage;

// Security limits to prevent DoS — identical to the NAPI crate.
const MAX_PLAINTEXT_SIZE: usize = 100 * 1024 * 1024; // 100 MB
const MAX_CIPHERTEXT_SIZE: usize = MAX_PLAINTEXT_SIZE + 1024; // plaintext + nonce + tag overhead
const MAX_AAD_SIZE: usize = 64 * 1024; // 64 KB

fn validate_encryption_input(plaintext_len: usize, aad_len: usize) -> Result<(), JsError> {
    if plaintext_len > MAX_PLAINTEXT_SIZE {
        return Err(JsError::new(&format!(
            "Plaintext exceeds maximum size of {MAX_PLAINTEXT_SIZE} bytes"
        )));
    }
    if aad_len > MAX_AAD_SIZE {
        return Err(JsError::new(&format!(
            "AAD exceeds maximum size of {MAX_AAD_SIZE} bytes"
        )));
    }
    Ok(())
}

fn validate_decryption_input(ciphertext_len: usize, aad_len: usize) -> Result<(), JsError> {
    if ciphertext_len > MAX_CIPHERTEXT_SIZE {
        return Err(JsError::new(&format!(
            "Ciphertext exceeds maximum size of {MAX_CIPHERTEXT_SIZE} bytes"
        )));
    }
    if aad_len > MAX_AAD_SIZE {
        return Err(JsError::new(&format!(
            "AAD exceeds maximum size of {MAX_AAD_SIZE} bytes"
        )));
    }
    Ok(())
}

/// cachekit-core-wasm crate version.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// ByteStorage provides LZ4 compression with xxHash3-64 integrity verification.
///
/// Thin wrapper around cachekit-core's ByteStorage — the full msgpack
/// envelope (compressed_data, checksum, original_size, format), identical
/// bytes to the NAPI binding.
#[wasm_bindgen]
pub struct ByteStorage {
    inner: CoreByteStorage,
}

impl Default for ByteStorage {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl ByteStorage {
    /// Create a new ByteStorage instance.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: CoreByteStorage::new(None),
        }
    }

    /// Pack data with LZ4 compression and xxHash3-64 integrity checksum.
    pub fn pack(&self, data: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner
            .store(data, None)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Unpack data, verifying xxHash3-64 integrity and decompressing LZ4.
    pub fn unpack(&self, packed: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner
            .retrieve(packed)
            .map(|(data, _format)| data)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Validate packed data without extracting.
    pub fn validate(&self, packed: &[u8]) -> bool {
        self.inner.validate(packed)
    }
}

/// Key derivation using HKDF-SHA256 (RFC 5869). Same validation as NAPI.
#[wasm_bindgen(js_name = deriveKey)]
pub fn derive_key(
    master_key: &[u8],
    domain: &str,
    tenant_salt: &str,
) -> Result<Vec<u8>, JsError> {
    if master_key.len() != 32 {
        return Err(JsError::new(&format!(
            "Master key must be 32 bytes, got {}",
            master_key.len()
        )));
    }
    if domain.is_empty() {
        return Err(JsError::new(
            "Domain cannot be empty - domain separation required for security",
        ));
    }
    if tenant_salt.is_empty() {
        return Err(JsError::new(
            "tenant_salt cannot be empty - each tenant must have unique salt",
        ));
    }

    derive_domain_key(master_key, domain, tenant_salt.as_bytes())
        .map(|derived| derived.to_vec())
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Per-tenant derived keys with automatic zeroization.
///
/// Keys are derived once and stay in wasm linear memory — zeroized when the
/// handle is freed (explicitly via `free()`, or by the FinalizationRegistry
/// wasm-bindgen registers). Clone is intentionally NOT implemented.
/// The embedded encryptor is reused for counter-nonce consistency
/// (matches the NAPI binding and Python's EncryptionWrapper pattern).
#[wasm_bindgen]
pub struct TenantKeys {
    inner: CoreTenantKeys,
    encryptor: ZeroKnowledgeEncryptor,
}

#[wasm_bindgen]
impl TenantKeys {
    /// Get the tenant ID these keys were derived for.
    #[wasm_bindgen(getter, js_name = tenantId)]
    pub fn tenant_id(&self) -> String {
        self.inner.tenant_id.clone()
    }

    /// Get the encryption key fingerprint (safe to log/expose).
    #[wasm_bindgen(js_name = encryptionFingerprint)]
    pub fn encryption_fingerprint(&self) -> Vec<u8> {
        self.inner.encryption_fingerprint().to_vec()
    }

    /// Get the current nonce counter value (rotate before 2^32).
    ///
    /// Returned as f64: the counter saturates at 2^32, well inside f64's
    /// exact-integer range, and JS callers expect `number` (not BigInt).
    #[wasm_bindgen(js_name = getNonceCounter)]
    pub fn get_nonce_counter(&self) -> f64 {
        self.encryptor.get_nonce_counter() as f64
    }
}

/// Derive per-tenant keys using HKDF-SHA256.
///
/// Matches Python's `derive_tenant_keys()` and the NAPI binding exactly:
/// encryption_key ("encryption"), authentication_key ("authentication"),
/// cache_key_salt ("cache_keys").
#[wasm_bindgen(js_name = deriveTenantKeys)]
pub fn derive_tenant_keys(master_key: &[u8], tenant_id: &str) -> Result<TenantKeys, JsError> {
    if master_key.len() != 32 {
        return Err(JsError::new(&format!(
            "Master key must be exactly 32 bytes, got {}",
            master_key.len()
        )));
    }
    if tenant_id.is_empty() {
        return Err(JsError::new("tenant_id cannot be empty"));
    }

    let inner = core_derive_tenant_keys(master_key, tenant_id)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let encryptor = ZeroKnowledgeEncryptor::new().map_err(|e| JsError::new(&e.to_string()))?;

    Ok(TenantKeys { inner, encryptor })
}

/// Encrypt plaintext using TenantKeys (keys stay in wasm memory).
///
/// Ciphertext format: [nonce(12)][ciphertext][auth_tag(16)] — byte-identical
/// to the native ring path and the Python/Rust SDKs.
#[wasm_bindgen(js_name = encryptWithTenantKeys)]
pub fn encrypt_with_tenant_keys(
    plaintext: &[u8],
    aad: &[u8],
    tenant_keys: &TenantKeys,
) -> Result<Vec<u8>, JsError> {
    validate_encryption_input(plaintext.len(), aad.len())?;

    tenant_keys
        .encryptor
        .encrypt_aes_gcm(plaintext, &tenant_keys.inner.encryption_key, aad)
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Decrypt ciphertext using TenantKeys (keys stay in wasm memory).
#[wasm_bindgen(js_name = decryptWithTenantKeys)]
pub fn decrypt_with_tenant_keys(
    ciphertext: &[u8],
    aad: &[u8],
    tenant_keys: &TenantKeys,
) -> Result<Vec<u8>, JsError> {
    validate_decryption_input(ciphertext.len(), aad.len())?;

    tenant_keys
        .encryptor
        .decrypt_aes_gcm(ciphertext, &tenant_keys.inner.encryption_key, aad)
        .map_err(|e| JsError::new(&e.to_string()))
}

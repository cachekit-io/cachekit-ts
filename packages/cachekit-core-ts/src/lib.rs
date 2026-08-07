#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

use cachekit_core::encryption::key_derivation::{
    derive_tenant_keys as core_derive_tenant_keys, TenantKeys as CoreTenantKeys,
};
use cachekit_core::encryption::{derive_domain_key, Keyring, ZeroKnowledgeEncryptor};
use cachekit_core::ByteStorage as CoreByteStorage;

// Security limits to prevent DoS
const MAX_PLAINTEXT_SIZE: usize = 100 * 1024 * 1024; // 100 MB
const MAX_CIPHERTEXT_SIZE: usize = MAX_PLAINTEXT_SIZE + 1024; // plaintext + nonce + tag overhead
const MAX_AAD_SIZE: usize = 64 * 1024; // 64 KB

/// Validate plaintext and AAD sizes to prevent DoS.
fn validate_encryption_input(plaintext_len: usize, aad_len: usize) -> Result<()> {
    if plaintext_len > MAX_PLAINTEXT_SIZE {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Plaintext exceeds maximum size of {} bytes",
                MAX_PLAINTEXT_SIZE
            ),
        ));
    }
    if aad_len > MAX_AAD_SIZE {
        return Err(Error::new(
            Status::InvalidArg,
            format!("AAD exceeds maximum size of {} bytes", MAX_AAD_SIZE),
        ));
    }
    Ok(())
}

/// Validate ciphertext and AAD sizes for decryption.
fn validate_decryption_input(ciphertext_len: usize, aad_len: usize) -> Result<()> {
    if ciphertext_len > MAX_CIPHERTEXT_SIZE {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Ciphertext exceeds maximum size of {} bytes",
                MAX_CIPHERTEXT_SIZE
            ),
        ));
    }
    if aad_len > MAX_AAD_SIZE {
        return Err(Error::new(
            Status::InvalidArg,
            format!("AAD exceeds maximum size of {} bytes", MAX_AAD_SIZE),
        ));
    }
    Ok(())
}

/// Version of the cachekit-core-ts package
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// ByteStorage provides LZ4 compression with xxHash3-64 integrity verification.
///
/// This is a thin wrapper around cachekit-core's ByteStorage.
#[napi]
pub struct ByteStorage {
    inner: CoreByteStorage,
}

impl Default for ByteStorage {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl ByteStorage {
    /// Create a new ByteStorage instance.
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: CoreByteStorage::new(None),
        }
    }

    /// Pack data with LZ4 compression and xxHash3-64 integrity checksum.
    ///
    /// # Arguments
    /// * `data` - Raw bytes to pack
    ///
    /// # Returns
    /// Packed bytes containing: [envelope with xxHash3-64 checksum + LZ4 compressed data]
    ///
    /// # Errors
    /// Returns GenericFailure if compression fails
    #[napi]
    pub fn pack(&self, data: Uint8Array) -> Result<Uint8Array> {
        self.inner
            .store(&data, None)
            .map(|envelope| envelope.into())
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }

    /// Unpack data, verifying xxHash3-64 integrity and decompressing LZ4.
    ///
    /// # Arguments
    /// * `packed` - Previously packed bytes from pack()
    ///
    /// # Returns
    /// Original unpacked bytes
    ///
    /// # Errors
    /// Returns GenericFailure if:
    /// - Integrity check fails (data corrupted)
    /// - Decompression fails (invalid format)
    #[napi]
    pub fn unpack(&self, packed: Uint8Array) -> Result<Uint8Array> {
        self.inner
            .retrieve(&packed)
            .map(|(data, _format)| data.into())
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }

    /// Get compression ratio estimate for given data.
    ///
    /// # Arguments
    /// * `data` - Data to estimate compression ratio for
    ///
    /// # Returns
    /// Compression ratio (compressed_size / original_size)
    #[napi]
    pub fn estimate_compression_ratio(&self, data: Uint8Array) -> Result<f64> {
        self.inner
            .estimate_compression(&data)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }

    /// Validate packed data without extracting.
    ///
    /// # Arguments
    /// * `packed` - Previously packed bytes
    ///
    /// # Returns
    /// true if valid, false otherwise
    #[napi]
    pub fn validate(&self, packed: Uint8Array) -> bool {
        self.inner.validate(&packed)
    }
}

/// Key derivation using HKDF-SHA256.
///
/// Derives a 32-byte key from a master key, domain label, and tenant salt.
/// Uses HKDF (RFC 5869) for cryptographically secure derivation.
///
/// # Arguments
/// * `master_key` - 32-byte master encryption key
/// * `domain` - Domain label (e.g., "cachekit:encryption") - cannot be empty
/// * `tenant_salt` - Per-tenant salt for isolation
///
/// # Returns
/// 32-byte derived key
///
/// # Errors
/// Returns InvalidArg if:
/// - master_key is not 32 bytes
/// - domain is empty
/// - tenant_salt is empty
///
/// # Example
/// ```javascript
/// const masterKey = Buffer.from(process.env.MASTER_KEY, 'hex');
/// const derivedKey = deriveKey(masterKey, 'cachekit:encryption', 'tenant-123');
/// ```
#[napi]
pub fn derive_key(
    master_key: Uint8Array,
    domain: String,
    tenant_salt: String,
) -> Result<Uint8Array> {
    if master_key.len() != 32 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Master key must be 32 bytes, got {}", master_key.len()),
        ));
    }

    if domain.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Domain cannot be empty - domain separation required for security",
        ));
    }

    if tenant_salt.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "tenant_salt cannot be empty - each tenant must have unique salt",
        ));
    }

    let key_arr: [u8; 32] = master_key
        .as_ref()
        .try_into()
        .map_err(|_| Error::new(Status::InvalidArg, "Master key must be 32 bytes"))?;

    derive_domain_key(&key_arr, &domain, tenant_salt.as_bytes())
        .map(|derived| derived.to_vec().into())
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
}

/// Per-tenant derived keys with automatic zeroization.
///
/// This wraps cachekit-core's TenantKeys which has `#[derive(ZeroizeOnDrop)]`.
/// Keys are derived once and stay in Rust memory - never copied to JavaScript.
///
/// # Security
/// - Keys are zeroized on drop (via cachekit-core's ZeroizeOnDrop)
/// - Clone is intentionally NOT implemented to prevent key proliferation
/// - Keys never leave Rust memory
/// - Encryptor is reused for nonce consistency (matches Python pattern)
///
/// # Example
/// ```javascript
/// const tenantKeys = deriveTenantKeys(masterKey, 'tenant-123');
/// const ciphertext = encryptWithTenantKeys(plaintext, aad, tenantKeys);
/// const decrypted = decryptWithTenantKeys(ciphertext, aad, tenantKeys);
/// ```
#[napi]
pub struct TenantKeys {
    inner: CoreTenantKeys,
    /// Shared encryptor for consistent nonce tracking across operations.
    /// Matches Python pattern where each EncryptionWrapper has ONE encryptor.
    encryptor: ZeroKnowledgeEncryptor,
    /// Decrypt keyring, present only during a rotation grace window
    /// (previousMasterKeys configured). None keeps the single-key decrypt
    /// path on the pre-derived tenant key. All keyring material zeroizes
    /// on drop inside cachekit-core.
    keyring: Option<Keyring>,
}

#[napi]
impl TenantKeys {
    /// Get the tenant ID these keys were derived for.
    #[napi(getter)]
    pub fn tenant_id(&self) -> String {
        self.inner.tenant_id.clone()
    }

    /// Get the encryption key fingerprint (safe to log/expose).
    #[napi]
    pub fn encryption_fingerprint(&self) -> Uint8Array {
        self.inner.encryption_fingerprint().to_vec().into()
    }

    /// Get the current nonce counter value.
    ///
    /// Monitor this value for key rotation - rotate before reaching 2^32.
    /// This matches Python's ZeroKnowledgeEncryptor.get_nonce_counter().
    #[napi]
    pub fn get_nonce_counter(&self) -> i64 {
        self.encryptor.get_nonce_counter() as i64
    }
}

/// Derive per-tenant keys using HKDF-SHA256.
///
/// This matches Python's `derive_tenant_keys()` exactly, deriving three keys:
/// - encryption_key (domain: "encryption")
/// - authentication_key (domain: "authentication")
/// - cache_key_salt (domain: "cache_keys")
///
/// # Arguments
/// * `master_key` - 32-byte master encryption key
/// * `tenant_id` - Tenant identifier for key isolation
/// * `previous_master_keys` - Optional decrypt-only previous master keys
///   (max 3, each 32 bytes) retained during a key-rotation grace window.
///   Reads attempt keys sequentially, current first, identical AAD per
///   attempt (protocol `spec/encryption.md` → "Key Rotation (Keyring)").
///   Writes always use `master_key`.
///
/// # Returns
/// TenantKeys object with derived keys (stays in Rust memory)
///
/// # Errors
/// Returns InvalidArg if any key has the wrong length, more than 3 previous
/// keys are supplied (rejected, never truncated), or `master_key` also
/// appears in `previous_master_keys` (forward-only rule: a key that ever
/// encrypted is never re-promoted).
///
/// # Example
/// ```javascript
/// const masterKey = Buffer.from(process.env.MASTER_KEY, 'hex');
/// const tenantKeys = deriveTenantKeys(masterKey, 'tenant-123');
/// // During a rotation grace window:
/// const rotating = deriveTenantKeys(newKey, 'tenant-123', [oldKey]);
/// ```
#[napi]
pub fn derive_tenant_keys(
    master_key: Uint8Array,
    tenant_id: String,
    previous_master_keys: Option<Vec<Uint8Array>>,
) -> Result<TenantKeys> {
    if master_key.len() != 32 {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Master key must be exactly 32 bytes, got {}",
                master_key.len()
            ),
        ));
    }

    if tenant_id.is_empty() {
        return Err(Error::new(Status::InvalidArg, "tenant_id cannot be empty"));
    }

    let previous = previous_master_keys.unwrap_or_default();
    for key in &previous {
        if key.len() != 32 {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Previous master key must be exactly 32 bytes, got {}",
                    key.len()
                ),
            ));
        }
    }
    // Keyring only exists during a rotation grace window; None keeps the
    // pre-derived single-key decrypt path. Keyring::new re-validates the
    // cap (3) and the current-key collision — config errors, hence InvalidArg.
    let keyring = if previous.is_empty() {
        None
    } else {
        let refs: Vec<&[u8]> = previous.iter().map(|k| k.as_ref()).collect();
        Some(
            Keyring::new(&master_key, &refs)
                .map_err(|e| Error::new(Status::InvalidArg, e.to_string()))?,
        )
    };

    let inner = core_derive_tenant_keys(&master_key, &tenant_id)
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

    let encryptor = ZeroKnowledgeEncryptor::new()
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

    Ok(TenantKeys {
        inner,
        encryptor,
        keyring,
    })
}

/// Encrypt plaintext using TenantKeys (keys stay in Rust memory).
///
/// This is the recommended API for multi-tenant encryption.
/// Keys are passed by reference and never copied to JavaScript.
/// Uses the encryptor stored in TenantKeys for consistent nonce tracking.
///
/// # Arguments
/// * `plaintext` - Data to encrypt (max 100 MB)
/// * `aad` - Additional Authenticated Data (max 64 KB)
/// * `tenant_keys` - Keys derived from deriveTenantKeys()
///
/// # Returns
/// Ciphertext containing: [nonce][tag][encrypted_data]
#[napi]
pub fn encrypt_with_tenant_keys(
    plaintext: Uint8Array,
    aad: Uint8Array,
    tenant_keys: &TenantKeys,
) -> Result<Uint8Array> {
    validate_encryption_input(plaintext.len(), aad.len())?;

    tenant_keys
        .encryptor
        .encrypt_aes_gcm(&plaintext, &tenant_keys.inner.encryption_key, &aad)
        .map(|ciphertext| ciphertext.into())
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
}

/// Decrypt ciphertext using TenantKeys (keys stay in Rust memory).
///
/// Uses the encryptor stored in TenantKeys for consistency.
///
/// With previous master keys configured (rotation grace window), decryption
/// runs cachekit-core's keyring loop: sequential attempts, current key
/// first, identical AAD every attempt. Only an AES-GCM authentication
/// failure advances to the next key; structural errors are terminal.
///
/// # Arguments
/// * `ciphertext` - Previously encrypted data
/// * `aad` - Must match AAD used during encryption
/// * `tenant_keys` - Keys derived from deriveTenantKeys()
///
/// # Returns
/// Original plaintext
#[napi]
pub fn decrypt_with_tenant_keys(
    ciphertext: Uint8Array,
    aad: Uint8Array,
    tenant_keys: &TenantKeys,
) -> Result<Uint8Array> {
    validate_decryption_input(ciphertext.len(), aad.len())?;

    match &tenant_keys.keyring {
        Some(keyring) => keyring
            .decrypt(
                &tenant_keys.encryptor,
                &ciphertext,
                &tenant_keys.inner.tenant_id,
                &aad,
            )
            .map(|plaintext| plaintext.into())
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string())),
        None => tenant_keys
            .encryptor
            .decrypt_aes_gcm(&ciphertext, &tenant_keys.inner.encryption_key, &aad)
            .map(|plaintext| plaintext.into())
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string())),
    }
}

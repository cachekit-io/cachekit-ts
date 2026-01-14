#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use zeroize::Zeroize;

use cachekit_core::ByteStorage as CoreByteStorage;
use cachekit_core::encryption::{ZeroKnowledgeEncryptor, derive_domain_key};
use cachekit_core::encryption::key_derivation::{
    TenantKeys as CoreTenantKeys,
    derive_tenant_keys as core_derive_tenant_keys,
};

// Security limits to prevent DoS
const MAX_PLAINTEXT_SIZE: usize = 100 * 1024 * 1024; // 100 MB
const MAX_AAD_SIZE: usize = 64 * 1024; // 64 KB

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

/// AES-256-GCM encryption with AAD binding.
///
/// Key is stored at construction time and used for all operations.
/// This is a thin wrapper around cachekit-core's ZeroKnowledgeEncryptor.
///
/// # Security
/// - Key must be exactly 32 bytes (256 bits)
/// - Nonce is auto-generated per encryption (never reuse)
/// - AAD binds ciphertext to context (prevents substitution attacks)
///
/// # Example
/// ```javascript
/// const key = crypto.randomBytes(32);
/// const encryptor = new Encryptor(key);
/// const aad = Buffer.from('cache:my-key');
/// const ciphertext = encryptor.encrypt(plaintext, aad);
/// const decrypted = encryptor.decrypt(ciphertext, aad);
/// ```
#[napi]
pub struct Encryptor {
    inner: ZeroKnowledgeEncryptor,
    key: [u8; 32],
    nonce_counter: std::sync::atomic::AtomicI64,
}

#[napi]
impl Encryptor {
    /// Create a new Encryptor with the given 32-byte key.
    ///
    /// # Arguments
    /// * `key` - Exactly 32 bytes (256 bits) encryption key
    ///
    /// # Errors
    /// Returns InvalidArg if key is not exactly 32 bytes
    #[napi(constructor)]
    pub fn new(key: Uint8Array) -> Result<Self> {
        if key.len() != 32 {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Key must be exactly 32 bytes, got {}", key.len()),
            ));
        }

        let key_arr: [u8; 32] = key.as_ref().try_into()
            .map_err(|_| Error::new(Status::InvalidArg, "Key must be 32 bytes"))?;

        let inner = ZeroKnowledgeEncryptor::new()
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

        Ok(Self {
            inner,
            key: key_arr,
            nonce_counter: std::sync::atomic::AtomicI64::new(0),
        })
    }

    /// Encrypt plaintext with AAD binding.
    ///
    /// # Arguments
    /// * `plaintext` - Data to encrypt (max 100 MB)
    /// * `aad` - Additional Authenticated Data (bound to ciphertext, max 64 KB)
    ///
    /// # Returns
    /// Ciphertext containing: [nonce][tag][encrypted_data]
    ///
    /// # Errors
    /// Returns GenericFailure if encryption fails
    ///
    /// # CRITICAL: Signature is encrypt(plaintext, aad) NOT encrypt(key, plaintext, aad)
    #[napi]
    pub fn encrypt(&self, plaintext: Uint8Array, aad: Uint8Array) -> Result<Uint8Array> {
        // Size limits to prevent DoS
        if plaintext.len() > MAX_PLAINTEXT_SIZE {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Plaintext exceeds maximum size of {} bytes", MAX_PLAINTEXT_SIZE),
            ));
        }
        if aad.len() > MAX_AAD_SIZE {
            return Err(Error::new(
                Status::InvalidArg,
                format!("AAD exceeds maximum size of {} bytes", MAX_AAD_SIZE),
            ));
        }

        self.nonce_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        self.inner
            .encrypt_aes_gcm(&plaintext, &self.key, &aad)
            .map(|ciphertext| ciphertext.into())
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }

    /// Decrypt ciphertext and verify AAD.
    ///
    /// # Arguments
    /// * `ciphertext` - Previously encrypted data
    /// * `aad` - Must match AAD used during encryption
    ///
    /// # Returns
    /// Original plaintext
    ///
    /// # Errors
    /// Returns GenericFailure if:
    /// - Decryption fails
    /// - AAD verification fails (wrong context)
    #[napi]
    pub fn decrypt(&self, ciphertext: Uint8Array, aad: Uint8Array) -> Result<Uint8Array> {
        self.inner
            .decrypt_aes_gcm(&ciphertext, &self.key, &aad)
            .map(|plaintext| plaintext.into())
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }

    /// Get the current nonce counter value.
    ///
    /// Useful for monitoring nonce exhaustion (should rotate key before 2^32).
    #[napi]
    pub fn get_nonce_counter(&self) -> i64 {
        self.nonce_counter.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Securely zeroize key material on drop to prevent memory disclosure.
impl Drop for Encryptor {
    fn drop(&mut self) {
        self.key.zeroize();
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
/// * `tenant_salt` - Per-tenant salt for isolation - REQUIRED for multi-tenant security
///
/// # Returns
/// 32-byte derived key
///
/// # Errors
/// Returns InvalidArg if:
/// - master_key is not 32 bytes
/// - domain is empty
/// - tenant_salt is null/undefined or empty string
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
    tenant_salt: Option<String>,
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

    // Require tenant_salt for multi-tenant isolation
    let salt_str = tenant_salt.ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "tenant_salt is required for multi-tenant key isolation",
        )
    })?;

    if salt_str.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "tenant_salt cannot be empty - each tenant must have unique salt",
        ));
    }

    let key_arr: [u8; 32] = master_key.as_ref().try_into()
        .map_err(|_| Error::new(Status::InvalidArg, "Master key must be 32 bytes"))?;

    derive_domain_key(&key_arr, &domain, salt_str.as_bytes())
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
///
/// # Returns
/// TenantKeys object with derived keys (stays in Rust memory)
///
/// # Example
/// ```javascript
/// const masterKey = Buffer.from(process.env.MASTER_KEY, 'hex');
/// const tenantKeys = deriveTenantKeys(masterKey, 'tenant-123');
/// ```
#[napi]
pub fn derive_tenant_keys(master_key: Uint8Array, tenant_id: String) -> Result<TenantKeys> {
    if master_key.len() < 16 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Master key must be at least 16 bytes, got {}", master_key.len()),
        ));
    }

    if tenant_id.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "tenant_id cannot be empty",
        ));
    }

    let inner = core_derive_tenant_keys(&master_key, &tenant_id)
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

    // Create a shared encryptor for this TenantKeys instance.
    // This matches Python's pattern where each EncryptionWrapper has ONE encryptor
    // that tracks nonce usage across all operations.
    let encryptor = ZeroKnowledgeEncryptor::new()
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

    Ok(TenantKeys { inner, encryptor })
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
    // Size limits to prevent DoS
    if plaintext.len() > MAX_PLAINTEXT_SIZE {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Plaintext exceeds maximum size of {} bytes", MAX_PLAINTEXT_SIZE),
        ));
    }
    if aad.len() > MAX_AAD_SIZE {
        return Err(Error::new(
            Status::InvalidArg,
            format!("AAD exceeds maximum size of {} bytes", MAX_AAD_SIZE),
        ));
    }

    // Reuse the encryptor stored in TenantKeys for consistent nonce tracking.
    // This matches Python's pattern where each EncryptionWrapper has ONE encryptor.
    tenant_keys.encryptor
        .encrypt_aes_gcm(&plaintext, &tenant_keys.inner.encryption_key, &aad)
        .map(|ciphertext| ciphertext.into())
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
}

/// Decrypt ciphertext using TenantKeys (keys stay in Rust memory).
///
/// Uses the encryptor stored in TenantKeys for consistency.
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
    // Reuse the encryptor stored in TenantKeys for consistency.
    tenant_keys.encryptor
        .decrypt_aes_gcm(&ciphertext, &tenant_keys.inner.encryption_key, &aad)
        .map(|plaintext| plaintext.into())
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
}

/// State machine for zero-downtime key rotation.
///
/// During rotation:
/// - New data is encrypted with the new key
/// - Old data can still be decrypted with the old key
/// - After rotation completes, only new key is used
#[napi]
pub struct KeyRotationState {
    current_key: Vec<u8>,
    previous_key: Option<Vec<u8>>,
    is_rotating: bool,
}

#[napi]
impl KeyRotationState {
    /// Create a new KeyRotationState with the current key.
    #[napi(constructor)]
    pub fn new(key: Uint8Array) -> Result<Self> {
        if key.len() != 32 {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Key must be 32 bytes, got {}", key.len()),
            ));
        }

        Ok(Self {
            current_key: key.to_vec(),
            previous_key: None,
            is_rotating: false,
        })
    }

    /// Start rotation to a new key.
    ///
    /// The old key is preserved for decryption during transition.
    #[napi]
    pub fn start_rotation(&mut self, new_key: Uint8Array) -> Result<()> {
        if new_key.len() != 32 {
            return Err(Error::new(
                Status::InvalidArg,
                format!("New key must be 32 bytes, got {}", new_key.len()),
            ));
        }

        self.previous_key = Some(self.current_key.clone());
        self.current_key = new_key.to_vec();
        self.is_rotating = true;
        Ok(())
    }

    /// Complete the rotation, discarding the old key.
    #[napi]
    pub fn complete_rotation(&mut self) {
        self.previous_key = None;
        self.is_rotating = false;
    }

    /// Check if rotation is in progress.
    #[napi]
    pub fn is_rotating(&self) -> bool {
        self.is_rotating
    }

    /// Get the key to use for encryption (always the current key).
    #[napi]
    pub fn encryption_key(&self) -> Uint8Array {
        self.current_key.clone().into()
    }

    /// Get the key to try for decryption.
    /// Returns current key, or previous key if rotation is in progress.
    ///
    /// During rotation, try current key first, then previous key.
    #[napi]
    pub fn decryption_key(&self) -> Uint8Array {
        self.current_key.clone().into()
    }

    /// Get the previous key (if rotation is in progress).
    #[napi]
    pub fn previous_decryption_key(&self) -> Option<Uint8Array> {
        self.previous_key.as_ref().map(|k| k.clone().into())
    }
}

/// Securely zeroize key material on drop to prevent memory disclosure.
impl Drop for KeyRotationState {
    fn drop(&mut self) {
        self.current_key.zeroize();
        if let Some(ref mut prev) = self.previous_key {
            prev.zeroize();
        }
    }
}

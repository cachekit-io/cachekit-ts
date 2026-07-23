import { EncryptionError, ConfigurationError, NonceExhaustedError } from '../errors.js';
import { AAD_VERSION, MIN_MASTER_KEY_BYTES, MIN_MASTER_KEY_HEX_LENGTH } from '../constants.js';

/**
 * Tenant keys handle exposed by a bindings implementation (NAPI or wasm).
 * Keys stay inside the binding's memory (Rust heap under NAPI, wasm linear
 * memory on Workers) — never copied into the JS heap.
 */
export interface EncryptionTenantKeys {
  readonly tenantId: string;
  encryptionFingerprint(): Uint8Array;
  /** Get the current nonce counter from the Rust encryptor (for monitoring) */
  getNonceCounter(): number;
  /**
   * Deterministic zeroize-and-release (wasm bindings). NAPI handles zeroize
   * via GC finalizer instead and don't expose this.
   */
  free?(): void;
}

/**
 * The cachekit-core binding surface EncryptionManagerCore drives. Implemented
 * by @cachekit-io/cachekit-core-ts (NAPI, Node) and
 * @cachekit-io/cachekit-core-wasm (wasm32, Cloudflare Workers).
 *
 * Error contract: when the encryptor's nonce counter is exhausted,
 * encryptWithTenantKeys MUST throw an Error whose message contains
 * "Nonce counter exhausted" (cachekit-core's EncryptionError Display) —
 * encrypt() classifies that substring into NonceExhaustedError so rotation
 * alerting works. Both bindings inherit the string from the same core crate;
 * a core wording change must update this contract and the classifier below.
 */
export interface EncryptionBindings {
  deriveTenantKeys(masterKey: Uint8Array, tenantId: string): EncryptionTenantKeys;
  encryptWithTenantKeys(
    plaintext: Uint8Array,
    aad: Uint8Array,
    tenantKeys: EncryptionTenantKeys
  ): Uint8Array;
  decryptWithTenantKeys(
    ciphertext: Uint8Array,
    aad: Uint8Array,
    tenantKeys: EncryptionTenantKeys
  ): Uint8Array;
}

/**
 * High-level encryption manager over injected cachekit-core bindings.
 *
 * Platform entries subclass this with their bindings loader — see
 * `EncryptionManager` (Node/NAPI) and the Workers entrypoint (wasm). All
 * protocol-critical logic (AAD v0x03 construction, key validation, error
 * mapping) lives here, once.
 *
 * Features:
 * - AAD v0x03 format with cache_key binding (prevents ciphertext substitution)
 * - HKDF key derivation for per-tenant isolation
 * - Nonce counter tracking for key rotation monitoring
 */
export class EncryptionManagerCore {
  private tenantKeys: EncryptionTenantKeys | null = null;
  private native: EncryptionBindings | null = null;
  private disposed = false;
  private initPromise: Promise<void> | null = null;
  // Note: Nonce tracking is done in Rust via getNonceCounter().
  // The Rust encryptor throws NonceCounterExhausted when the limit is reached.

  /**
   * Create an encryption manager core.
   *
   * SECURITY WARNING: Master key is stored in JavaScript heap memory and cannot
   * be securely zeroized due to string immutability. Mitigations:
   * - Run in isolated processes with restricted ptrace access
   * - Disable core dumps (ulimit -c 0)
   * - Use encrypted swap
   * - Rotate master keys periodically (recommended: 24-48 hours)
   *
   * @param masterKey - Hex-encoded master key (min 32 bytes = 64 hex chars)
   * @param tenantId - Optional tenant ID for key derivation isolation
   * @param loadBindings - Platform bindings loader (NAPI or wasm)
   * @throws {ConfigurationError} if masterKey is invalid
   */
  constructor(
    private readonly masterKey: string,
    private readonly tenantId: string | undefined,
    private readonly loadBindings: () => Promise<EncryptionBindings>
  ) {
    // Validate master key format
    if (!/^[0-9a-fA-F]+$/.test(masterKey)) {
      throw new ConfigurationError('Master key must be hex-encoded');
    }
    if (masterKey.length !== MIN_MASTER_KEY_HEX_LENGTH) {
      throw new ConfigurationError(
        `Master key must be exactly ${MIN_MASTER_KEY_BYTES} bytes (${MIN_MASTER_KEY_HEX_LENGTH} hex characters), got ${masterKey.length} hex characters`
      );
    }
  }

  /**
   * Initialize the bindings (lazy loading).
   *
   * Uses the TenantKeys pattern from cachekit-core - keys stay in binding
   * memory and are zeroized when the manager is disposed.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.tenantKeys) return;
    if (this.disposed) {
      throw new EncryptionError('EncryptionManager has been disposed');
    }

    // Memoize the in-flight init: concurrent first uses (Promise.all on a
    // fresh manager) must derive exactly ONE TenantKeys handle — a losing
    // duplicate would hold live key material with nothing left to free it.
    // Reset on failure so a later call can retry.
    this.initPromise ??= this.doInitialize().catch((error) => {
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      this.native = await this.loadBindings();

      // Decode hex master key to bytes
      const masterKeyBytes = this.hexToBytes(this.masterKey);

      // Derive tenant keys (uses cachekit-core's derive_tenant_keys with domain "encryption")
      // Keys stay in binding memory - never copied to the JavaScript heap
      const effectiveTenantId = this.tenantId ?? 'default';
      const tenantKeys = this.native.deriveTenantKeys(masterKeyBytes, effectiveTenantId);
      if (this.disposed) {
        // dispose() ran while init was in flight — zeroize immediately
        // instead of parking live key material on a disposed manager.
        tenantKeys.free?.();
        throw new EncryptionError('EncryptionManager has been disposed');
      }
      this.tenantKeys = tenantKeys;
    } catch (error) {
      if (error instanceof ConfigurationError || error instanceof EncryptionError) {
        throw error;
      }
      throw new EncryptionError(
        `Failed to initialize encryption: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error instanceof Error ? error : undefined }
      );
    }
  }

  /**
   * Encrypt data with AAD binding to cache key.
   *
   * Uses TenantKeys pattern - keys never leave binding memory.
   * Nonce exhaustion is detected by the Rust encryptor (at u32::MAX = 2^32).
   *
   * @param data - Plaintext data to encrypt
   * @param cacheKey - Cache key to bind in AAD (prevents ciphertext substitution)
   * @returns Encrypted ciphertext
   * @throws {NonceExhaustedError} if nonce counter reaches 2^32 (rotate key)
   * @throws {EncryptionError} if encryption fails
   */
  async encrypt(data: Uint8Array, cacheKey: string, compressed = false): Promise<Uint8Array> {
    await this.ensureInitialized();

    try {
      const aad = this.buildAAD(cacheKey, 'msgpack', compressed);
      return this.native!.encryptWithTenantKeys(data, aad, this.tenantKeys!);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Detect nonce exhaustion from Rust error message
      if (
        message.includes('Nonce counter exhausted') ||
        message.includes('NonceCounterExhausted')
      ) {
        throw new NonceExhaustedError(`Nonce counter exhausted. Key rotation required.`, {
          cause: error instanceof Error ? error : undefined,
        });
      }
      throw new EncryptionError(`Encryption failed: ${message}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Decrypt data and verify AAD binding.
   *
   * Uses TenantKeys pattern - keys never leave binding memory.
   *
   * @param ciphertext - Encrypted data
   * @param cacheKey - Cache key that was bound during encryption
   * @returns Decrypted plaintext
   * @throws {EncryptionError} if decryption or AAD verification fails
   */
  async decrypt(ciphertext: Uint8Array, cacheKey: string, compressed = false): Promise<Uint8Array> {
    await this.ensureInitialized();

    try {
      const aad = this.buildAAD(cacheKey, 'msgpack', compressed);
      return this.native!.decryptWithTenantKeys(ciphertext, aad, this.tenantKeys!);
    } catch (error) {
      throw new EncryptionError(
        `Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error instanceof Error ? error : undefined }
      );
    }
  }

  /**
   * Get the current nonce counter from the Rust encryptor.
   *
   * Monitor this value - rotate key before reaching 2^32.
   * This directly reflects the Rust encryptor's nonce counter,
   * matching Python's ZeroKnowledgeEncryptor.get_nonce_counter().
   */
  async getEncryptionCount(): Promise<number> {
    if (!this.tenantKeys) return 0;
    return this.tenantKeys.getNonceCounter();
  }

  /**
   * Get the encryption key fingerprint (safe to log/expose).
   */
  async getKeyFingerprint(): Promise<Uint8Array | null> {
    if (!this.tenantKeys) return null;
    return this.tenantKeys.encryptionFingerprint();
  }

  /**
   * Dispose of the encryption manager and zeroize keys.
   *
   * NAPI: releasing the reference triggers ZeroizeOnDrop via the GC finalizer.
   * wasm: free() zeroizes deterministically, right now.
   */
  dispose(): void {
    this.disposed = true;
    this.tenantKeys?.free?.();
    this.tenantKeys = null;
    this.native = null;
  }

  /**
   * Build Additional Authenticated Data (AAD) for AES-GCM.
   *
   * Protocol v1.0.1 format (Section 5.6.2):
   * [version_byte(0x03)][len1(4)][tenant_id][len2(4)][cache_key][len3(4)][format][len4(4)][compressed]
   *
   * - All lengths are 4-byte big-endian uint32
   * - format and compressed are UTF-8 encoded strings
   * - This matches Python's encryption_wrapper.py exactly
   *
   * AAD binding prevents ciphertext substitution attacks by cryptographically
   * binding the encryption to specific tenant/key pairs.
   *
   * @param cacheKey - Cache key to bind in AAD
   * @param format - Serialization format (default: "msgpack")
   * @param compressed - Whether data is compressed (default: false)
   * @returns Serialized AAD buffer for AES-GCM operations
   */
  private buildAAD(cacheKey: string, format = 'msgpack', compressed = false): Uint8Array {
    const encoder = new TextEncoder();

    // Encode all components as UTF-8 (matches Python exactly)
    const components = [
      encoder.encode(this.tenantId ?? ''),
      encoder.encode(cacheKey),
      encoder.encode(format),
      encoder.encode(compressed ? 'True' : 'False'), // Python str(bool) format
    ];

    // Calculate total length: version byte + (4-byte length + data) for each component
    const totalLength = 1 + components.reduce((sum, c) => sum + 4 + c.length, 0);
    const aad = new Uint8Array(totalLength);
    const view = new DataView(aad.buffer);

    let offset = 0;

    // Version byte (0x03)
    aad[offset++] = AAD_VERSION;

    // Each component: 4-byte big-endian length + data
    for (const component of components) {
      view.setUint32(offset, component.length, false); // false = big-endian
      offset += 4;
      aad.set(component, offset);
      offset += component.length;
    }

    return aad;
  }

  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
}

import { EncryptionError, ConfigurationError, NonceExhaustedError } from '../errors.js';
import { AAD_VERSION, MIN_MASTER_KEY_BYTES, MIN_MASTER_KEY_HEX_LENGTH } from '../constants.js';

// Type definitions for native bindings (actual import happens dynamically)
interface NativeTenantKeys {
  readonly tenantId: string;
  encryptionFingerprint(): Uint8Array;
  /** Get the current nonce counter from the Rust encryptor (for monitoring) */
  getNonceCounter(): number;
}

interface NativeBindings {
  // TenantKeys pattern (recommended - keys stay in Rust memory)
  TenantKeys: new () => NativeTenantKeys;
  deriveTenantKeys(masterKey: Uint8Array, tenantId: string): NativeTenantKeys;
  encryptWithTenantKeys(plaintext: Uint8Array, aad: Uint8Array, tenantKeys: NativeTenantKeys): Uint8Array;
  decryptWithTenantKeys(ciphertext: Uint8Array, aad: Uint8Array, tenantKeys: NativeTenantKeys): Uint8Array;
}

/**
 * High-level encryption manager wrapping native cachekit-core-ts bindings.
 *
 * Features:
 * - AAD v0x03 format with cache_key binding (prevents ciphertext substitution)
 * - HKDF key derivation for per-tenant isolation
 * - Nonce counter tracking for key rotation monitoring
 *
 * @example
 * ```typescript
 * const manager = new EncryptionManager(process.env.CACHEKIT_MASTER_KEY!, 'tenant-123');
 * const ciphertext = manager.encrypt(data, 'cache:my-key');
 * const plaintext = manager.decrypt(ciphertext, 'cache:my-key');
 * manager.dispose(); // Clean up when done
 * ```
 */
export class EncryptionManager {
  private tenantKeys: NativeTenantKeys | null = null;
  private native: NativeBindings | null = null;
  private disposed = false;
  // Note: Nonce tracking is now done in Rust via TenantKeys.getNonceCounter()
  // The Rust encryptor throws NonceCounterExhausted when limit is reached.

  /**
   * Create an EncryptionManager.
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
   * @throws {ConfigurationError} if masterKey is invalid
   */
  constructor(
    private readonly masterKey: string,
    private readonly tenantId?: string
  ) {
    // Validate master key format
    if (!/^[0-9a-fA-F]+$/.test(masterKey)) {
      throw new ConfigurationError('Master key must be hex-encoded');
    }
    if (masterKey.length < MIN_MASTER_KEY_HEX_LENGTH) {
      throw new ConfigurationError(
        `Master key must be at least ${MIN_MASTER_KEY_BYTES} bytes (${MIN_MASTER_KEY_HEX_LENGTH} hex characters)`
      );
    }
  }

  /**
   * Initialize the native bindings (lazy loading).
   *
   * Uses the TenantKeys pattern from cachekit-core - keys stay in Rust memory
   * and are automatically zeroized when the manager is disposed.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.tenantKeys) return;
    if (this.disposed) {
      throw new EncryptionError('EncryptionManager has been disposed');
    }

    try {
      // Dynamic import to handle native module loading
      this.native = (await import('@cachekit-io/cachekit-core-ts')) as unknown as NativeBindings;

      // Decode hex master key to bytes
      const masterKeyBytes = this.hexToBytes(this.masterKey);

      // Derive tenant keys (uses cachekit-core's derive_tenant_keys with domain "encryption")
      // Keys stay in Rust memory - never copied to JavaScript heap
      const effectiveTenantId = this.tenantId ?? 'default';
      this.tenantKeys = this.native.deriveTenantKeys(masterKeyBytes, effectiveTenantId);
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
   * Uses TenantKeys pattern - keys never leave Rust memory.
   * Nonce exhaustion is detected by the Rust encryptor (at u32::MAX = 2^32).
   *
   * @param data - Plaintext data to encrypt
   * @param cacheKey - Cache key to bind in AAD (prevents ciphertext substitution)
   * @returns Encrypted ciphertext
   * @throws {NonceExhaustedError} if nonce counter reaches 2^32 (rotate key)
   * @throws {EncryptionError} if encryption fails
   */
  async encrypt(data: Uint8Array, cacheKey: string): Promise<Uint8Array> {
    await this.ensureInitialized();

    try {
      const aad = this.buildAAD(cacheKey);
      return this.native!.encryptWithTenantKeys(data, aad, this.tenantKeys!);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Detect nonce exhaustion from Rust error message
      if (message.includes('Nonce counter exhausted') || message.includes('NonceCounterExhausted')) {
        throw new NonceExhaustedError(
          `Nonce counter exhausted. Key rotation required.`,
          { cause: error instanceof Error ? error : undefined }
        );
      }
      throw new EncryptionError(
        `Encryption failed: ${message}`,
        { cause: error instanceof Error ? error : undefined }
      );
    }
  }

  /**
   * Decrypt data and verify AAD binding.
   *
   * Uses TenantKeys pattern - keys never leave Rust memory.
   *
   * @param ciphertext - Encrypted data
   * @param cacheKey - Cache key that was bound during encryption
   * @returns Decrypted plaintext
   * @throws {EncryptionError} if decryption or AAD verification fails
   */
  async decrypt(ciphertext: Uint8Array, cacheKey: string): Promise<Uint8Array> {
    await this.ensureInitialized();

    try {
      const aad = this.buildAAD(cacheKey);
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
   * Keys are automatically zeroized via cachekit-core's ZeroizeOnDrop.
   */
  dispose(): void {
    this.disposed = true;
    this.tenantKeys = null;  // Releases reference, triggers ZeroizeOnDrop in Rust
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
      encoder.encode(compressed ? 'True' : 'False'),  // Python str(bool) format
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
      view.setUint32(offset, component.length, false);  // false = big-endian
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

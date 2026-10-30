import { EncryptionError, ConfigurationError, NonceExhaustedError } from '../errors.js';
import {
  AAD_VERSION,
  MAX_AAD_SIZE,
  MAX_PREVIOUS_MASTER_KEYS,
  MASTER_KEY_BYTES,
  MASTER_KEY_HEX_LENGTH,
} from '../constants.js';

const utf8 = new TextEncoder();

/** One v0x03 AAD component: a 4-byte big-endian length, then the bytes. */
function aadComponent(text: string): Uint8Array {
  const bytes = utf8.encode(text);
  const component = new Uint8Array(4 + bytes.length);
  new DataView(component.buffer).setUint32(0, bytes.length, false);
  component.set(bytes, 4);
  return component;
}

/**
 * Whether a binding returned a Promise. The NAPI bindings return plain values,
 * and awaiting one would still cost a microtask hop on every Node operation.
 */
function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as { then?: unknown }).then === 'function';
}

/** Classify an encrypt failure: nonce exhaustion, or any other failure. */
function encryptionFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const cause = error instanceof Error ? error : undefined;
  // Detect nonce exhaustion from the core's error message
  if (message.includes('Nonce counter exhausted') || message.includes('NonceCounterExhausted')) {
    // Guidance (forward-only rotation + runbook link) lives once, in the
    // NonceExhaustedError default message.
    return new NonceExhaustedError(undefined, { cause });
  }
  return new EncryptionError(`Encryption failed: ${message}`, { cause });
}

function decryptionFailure(error: unknown): Error {
  return new EncryptionError(
    `Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    { cause: error instanceof Error ? error : undefined }
  );
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Tenant keys handle exposed by a bindings implementation. Under NAPI the
 * keys stay in the Rust heap, never copied into the JS heap. On Workers they
 * are non-extractable WebCrypto CryptoKeys, derived by wasm cachekit-core.
 */
export interface EncryptionTenantKeys {
  readonly tenantId: string;
  encryptionFingerprint(): Uint8Array;
  /** Get the current nonce counter from the encryptor (for monitoring) */
  getNonceCounter(): number;
  /**
   * Keyring entries actually built at derivation (1 current key +
   * decrypt-only previous keys). Optional in the type because older binding
   * binaries predate it — the manager treats its absence, when
   * previousMasterKeys are configured, as version skew and refuses to init
   * rather than silently decrypting with the current key only.
   */
  keyringEntryCount?(): number;
  /**
   * cachekit-core's AES hardware detection (informational). Optional: older
   * binding binaries predate it, and the Workers bindings cannot tell; the
   * manager reports `null` (unknown) for both.
   */
  hardwareAccelerationEnabled?(): boolean;
  /**
   * Deterministic release (Workers bindings). NAPI handles zeroize via GC
   * finalizer instead and don't expose this.
   */
  free?(): void;
}

/**
 * The cachekit-core binding surface EncryptionManagerCore drives. Implemented
 * by @cachekit-io/cachekit-core-ts (NAPI, Node, synchronous) and by
 * src/workers/webcrypto.ts (Cloudflare Workers: WebCrypto AES-GCM on keys
 * derived by @cachekit-io/cachekit-core-wasm, asynchronous). Each method may
 * return its result or a Promise of it; the manager awaits either.
 *
 * Error contract: when the encryptor's nonce counter is exhausted,
 * encryptWithTenantKeys MUST throw an Error whose message contains
 * "Nonce counter exhausted" (cachekit-core's EncryptionError Display) —
 * encrypt() classifies that substring into NonceExhaustedError so rotation
 * alerting works. Both bindings inherit the string from the same core crate;
 * a core wording change must update this contract and the classifier below.
 */
export interface EncryptionBindings {
  /**
   * `previousMasterKeys` (max 3, each 32 bytes) are decrypt-only keys for a
   * rotation grace window. The binding builds its decrypt keyring once, here.
   * It must be done with `masterKey` and `previousMasterKeys` by the time it
   * returns (a Promise or not): the manager zero-fills them after awaiting it.
   */
  deriveTenantKeys(
    masterKey: Uint8Array,
    tenantId: string,
    previousMasterKeys?: Uint8Array[]
  ): EncryptionTenantKeys | Promise<EncryptionTenantKeys>;
  encryptWithTenantKeys(
    plaintext: Uint8Array,
    aad: Uint8Array,
    tenantKeys: EncryptionTenantKeys
  ): Uint8Array | Promise<Uint8Array>;
  decryptWithTenantKeys(
    ciphertext: Uint8Array,
    aad: Uint8Array,
    tenantKeys: EncryptionTenantKeys
  ): Uint8Array | Promise<Uint8Array>;
}

/**
 * Validate a hex-encoded master key. Identical rules for the current key and
 * every previousMasterKeys entry — one validator, so they cannot drift.
 */
function validateKeyHex(key: string, label: string): void {
  if (!/^[0-9a-fA-F]+$/.test(key)) {
    throw new ConfigurationError(`${label} must be hex-encoded`);
  }
  if (key.length !== MASTER_KEY_HEX_LENGTH) {
    throw new ConfigurationError(
      `${label} must be exactly ${MASTER_KEY_BYTES} bytes (${MASTER_KEY_HEX_LENGTH} hex characters), got ${key.length} hex characters`
    );
  }
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
  /** Single source of truth for tenant_id — read by both HKDF derivation and AAD construction. */
  private readonly effectiveTenantId: string;
  // The AAD's parts other than the cache key, encoded once (see buildAAD):
  // the version byte and tenant id before the key, and the format and
  // compressed flag after it, one tail per flag value.
  private readonly aadHead: Uint8Array;
  private readonly aadTailCompressed: Uint8Array;
  private readonly aadTailUncompressed: Uint8Array;
  // Note: Nonce tracking is done by the bindings' encryptor via getNonceCounter().
  // The encryptor throws "Nonce counter exhausted" when the limit is reached.

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
   * Keyring exposure is all-keys exposure: during a rotation grace window
   * this process holds the current AND previous master keys — treat exposure
   * of the keyring configuration as exposure of every key in it.
   *
   * @param masterKey - Hex-encoded master key (exactly 32 bytes = 64 hex chars)
   * @param tenantId - Optional tenant ID for key derivation isolation
   * @param loadBindings - Platform bindings loader (NAPI or wasm)
   * @param previousMasterKeys - Decrypt-only previous master keys (max 3,
   *   same hex format as masterKey) retained during a key-rotation grace
   *   window. Reads attempt keys sequentially, current first; writes always
   *   use masterKey. Rotation is forward-only: masterKey must not appear
   *   here — a key that ever encrypted is never re-promoted.
   * @throws {ConfigurationError} if any key is invalid, tenantId is set but
   *   not a string or is empty, more than 3 previous keys are configured (rejected, never
   *   truncated), or masterKey appears in previousMasterKeys
   */
  constructor(
    private readonly masterKey: string,
    tenantId: string | undefined,
    private readonly loadBindings: () => Promise<EncryptionBindings>,
    private readonly previousMasterKeys: readonly string[] = []
  ) {
    validateKeyHex(masterKey, 'Master key');
    // Absent means the default tenant; any other non-string value, null
    // included, is a configuration error.
    if (tenantId !== undefined && typeof tenantId !== 'string') {
      throw new ConfigurationError(
        `tenantId must be a string, got ${tenantId === null ? 'null' : typeof tenantId}`
      );
    }
    // The native key derivation rejects an empty tenant id; fail here, at
    // construction, rather than at the first operation.
    if (tenantId === '') {
      throw new ConfigurationError('tenantId must not be empty; omit it for the default tenant');
    }
    this.effectiveTenantId = tenantId ?? 'default';
    this.aadHead = concatBytes(Uint8Array.of(AAD_VERSION), aadComponent(this.effectiveTenantId));
    // Python str(bool) format for the compressed flag.
    this.aadTailCompressed = concatBytes(aadComponent('msgpack'), aadComponent('True'));
    this.aadTailUncompressed = concatBytes(aadComponent('msgpack'), aadComponent('False'));
    if (previousMasterKeys.length > MAX_PREVIOUS_MASTER_KEYS) {
      throw new ConfigurationError(
        `previousMasterKeys accepts at most ${MAX_PREVIOUS_MASTER_KEYS} keys, got ${previousMasterKeys.length} — drop retired keys explicitly, the list is never truncated`
      );
    }
    // Case-insensitive comparisons throughout: hex case differences encode
    // the same key bytes.
    const current = masterKey.toLowerCase();
    const seen = new Set<string>();
    previousMasterKeys.forEach((key, index) => {
      validateKeyHex(key, `Previous master key ${index + 1}`);
      const canonical = key.toLowerCase();
      // Forward-only rule (protocol decisions/key-rotation.md): a key that
      // ever occupied the encrypting slot is never re-promoted, because that
      // would resume a used, unknowable AES-GCM nonce budget.
      if (canonical === current) {
        throw new ConfigurationError(
          'masterKey must not appear in previousMasterKeys — rotation is forward-only to a new key; a retired key is never re-promoted'
        );
      }
      // Duplicates are config errors too: they silently burn keyring slots
      // (cap of 3) and double the decrypt attempts for old entries.
      if (seen.has(canonical)) {
        throw new ConfigurationError(
          `previousMasterKeys entry ${index + 1} duplicates an earlier entry — each decrypt-only key may appear once`
        );
      }
      seen.add(canonical);
    });
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
      const previousKeyBytes = this.previousMasterKeys.map((key) => this.hexToBytes(key));

      // Derive tenant keys (uses cachekit-core's derive_tenant_keys with domain "encryption").
      // Previous keys build the decrypt keyring once, here. The decoded byte
      // buffers are wiped in the finally below once the binding has consumed
      // them (its Promise, if any, settled) — on error paths too (the hex
      // config strings remain on the manager for init retry, per the
      // documented masterKey pattern).
      let tenantKeys: EncryptionTenantKeys;
      try {
        tenantKeys = await this.native.deriveTenantKeys(
          masterKeyBytes,
          this.effectiveTenantId,
          previousKeyBytes.length > 0 ? previousKeyBytes : undefined
        );
      } finally {
        masterKeyBytes.fill(0);
        for (const bytes of previousKeyBytes) bytes.fill(0);
      }

      // Attest the keyring survived the FFI boundary. NAPI silently ignores
      // extra arguments, so a version-skewed native binary that predates
      // previousMasterKeys would build a single-key handle and every
      // pre-rotation entry would silently degrade to a miss.
      // Absence of keyringEntryCount on the handle is itself the skew signal.
      if (previousKeyBytes.length > 0) {
        const built = tenantKeys.keyringEntryCount?.() ?? 1;
        if (built !== 1 + previousKeyBytes.length) {
          tenantKeys.free?.();
          throw new ConfigurationError(
            `previousMasterKeys configured (${previousKeyBytes.length} keys) but the native bindings ` +
              `built a keyring with ${built} entr${built === 1 ? 'y' : 'ies'} — ` +
              'native module version skew; reinstall dependencies so the bindings match the SDK version'
          );
        }
      }
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
   * Nonce exhaustion is detected by the bindings' encryptor (at counter 2^32 - 1).
   *
   * @param data - Plaintext data to encrypt
   * @param cacheKey - Cache key to bind in AAD (prevents ciphertext substitution)
   * @returns Encrypted ciphertext
   * @throws {NonceExhaustedError} if nonce counter reaches 2^32 (rotate key)
   * @throws {EncryptionError} if encryption fails
   */
  async encrypt(data: Uint8Array, cacheKey: string, compressed = false): Promise<Uint8Array> {
    await this.ensureInitialized();

    let result: Uint8Array | Promise<Uint8Array>;
    try {
      const aad = this.buildAAD(cacheKey, compressed);
      result = this.native!.encryptWithTenantKeys(data, aad, this.tenantKeys!);
    } catch (error) {
      throw encryptionFailure(error);
    }
    // A Promise's rejection is classified the same way. Its mapping is chained,
    // not awaited, so this function keeps a single await: an await inside the
    // try measurably slowed every synchronous NAPI call too.
    return isThenable(result)
      ? Promise.resolve(result).catch((error: unknown) => {
          throw encryptionFailure(error);
        })
      : result;
  }

  /**
   * Decrypt data and verify AAD binding.
   *
   * Uses TenantKeys pattern - keys never leave binding memory.
   *
   * With previousMasterKeys configured, the binding runs cachekit-core's
   * keyring loop (natively under NAPI, in JS on Workers): sequential
   * attempts, current key first, the
   * identical AAD rebuilt for every attempt (ts entries carry no per-entry
   * key identity — protocol spec/encryption.md "Key Rotation (Keyring)").
   *
   * @param ciphertext - Encrypted data
   * @param cacheKey - Cache key that was bound during encryption
   * @returns Decrypted plaintext
   * @throws {EncryptionError} if decryption or AAD verification fails
   */
  async decrypt(ciphertext: Uint8Array, cacheKey: string, compressed = false): Promise<Uint8Array> {
    await this.ensureInitialized();

    let result: Uint8Array | Promise<Uint8Array>;
    try {
      const aad = this.buildAAD(cacheKey, compressed);
      result = this.native!.decryptWithTenantKeys(ciphertext, aad, this.tenantKeys!);
    } catch (error) {
      throw decryptionFailure(error);
    }
    return isThenable(result)
      ? Promise.resolve(result).catch((error: unknown) => {
          throw decryptionFailure(error);
        })
      : result;
  }

  /**
   * Get the current nonce counter from the bindings' encryptor.
   *
   * Monitor this value - rotate key before reaching 2^32.
   * This directly reflects the encryptor's nonce counter,
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
   * Whether AES-256-GCM is hardware-accelerated on this host, per
   * cachekit-core's detection (informational — see the README). Initialises
   * the bindings if needed, so it answers at startup. `null` = unknown: the
   * installed binding predates the accessor, or the manager runs on Workers,
   * where the isolate cannot see whether WebCrypto uses AES instructions.
   *
   * @throws {EncryptionError} if the manager is disposed or bindings fail to load
   */
  async isHardwareAccelerated(): Promise<boolean | null> {
    await this.ensureInitialized();
    // ensureInitialized() returns early on an already-initialised manager, so
    // dispose() can land while this call is suspended at the await. encrypt()
    // and decrypt() convert the resulting null read inside their catch; this
    // path has none, so it checks explicitly rather than trusting a `!`.
    if (this.disposed || !this.tenantKeys) {
      throw new EncryptionError('EncryptionManager has been disposed');
    }
    return this.tenantKeys.hardwareAccelerationEnabled?.() ?? null;
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
   * Reject a cache key whose AAD would exceed MAX_AAD_SIZE, which both native
   * bindings refuse to encrypt or decrypt under. Synchronous and needs no key
   * material, so the cache can run it before the reliability executor: an
   * over-limit key fails the same way on every attempt, so retrying it is
   * pointless and counting it would let a handful of long keys open the
   * circuit breaker for every key on the cache.
   *
   * Counts with buildAAD's own length function, so the check cannot drift
   * from the AAD it guards. Most keys need no encoding: UTF-8 takes at most 3
   * bytes per UTF-16 unit (a lone surrogate becomes the 3-byte U+FFFD), so a
   * key whose AAD fits at 3 bytes per unit fits whatever it holds. A key
   * longer than MAX_AAD_SIZE UTF-16 units is rejected unencoded too: UTF-8
   * never takes fewer bytes than UTF-16 units, so it is over the limit
   * whatever it holds. Only a key between the two is encoded and measured.
   *
   * @throws {ConfigurationError} if the AAD for `cacheKey` exceeds MAX_AAD_SIZE
   */
  validateKey(cacheKey: string, compressed = false): void {
    if (this.aadLength(cacheKey.length * 3, compressed) <= MAX_AAD_SIZE) return;
    const aadAtLeast =
      cacheKey.length > MAX_AAD_SIZE
        ? cacheKey.length
        : this.aadLength(utf8.encode(cacheKey).length, compressed);
    if (aadAtLeast <= MAX_AAD_SIZE) return;
    throw new ConfigurationError(
      `Cache key too long for an encrypted cache: its AAD is at least ${aadAtLeast} bytes, over ` +
        `the ${MAX_AAD_SIZE}-byte limit. The AAD carries the full key passed to the ` +
        'backend, its keyPrefix included (counted in UTF-8 bytes), plus the tenant id; shorten or hash the ' +
        'key (for wrap(), shorten the namespace).'
    );
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
   * Only the cache key is encoded per call; the other parts are encoded once,
   * in the constructor. The format is always "msgpack": the manager encrypts
   * only MessagePack payloads.
   *
   * @param cacheKey - Cache key to bind in AAD
   * @param compressed - Whether data is compressed
   * @returns Serialized AAD buffer for AES-GCM operations
   */
  private buildAAD(cacheKey: string, compressed: boolean): Uint8Array {
    const key = utf8.encode(cacheKey);
    const aad = new Uint8Array(this.aadLength(key.length, compressed));
    let offset = 0;
    aad.set(this.aadHead, offset);
    offset += this.aadHead.length;
    new DataView(aad.buffer).setUint32(offset, key.length, false);
    offset += 4;
    aad.set(key, offset);
    offset += key.length;
    aad.set(compressed ? this.aadTailCompressed : this.aadTailUncompressed, offset);
    return aad;
  }

  /** Length in bytes of the AAD for a cache key of `keyBytes` UTF-8 bytes. */
  private aadLength(keyBytes: number, compressed: boolean): number {
    const tail = compressed ? this.aadTailCompressed : this.aadTailUncompressed;
    return this.aadHead.length + 4 + keyBytes + tail.length;
  }

  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
}

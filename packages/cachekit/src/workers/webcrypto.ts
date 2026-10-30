/**
 * WebCrypto AES-256-GCM bindings for the Workers EncryptionManager.
 *
 * Split of work with wasm cachekit-core:
 * - cachekit-core (wasm) derives every key (HKDF-SHA256), computes the key
 *   fingerprint and enforces the tenant-id bounds, at init only.
 * - This file runs AES-256-GCM through `crypto.subtle`, which workerd
 *   executes natively; wasm32 has no AES instructions, so the software AES
 *   and GHASH in the wasm build cost far more per byte.
 *
 * It reproduces the rest of the wasm binding's encrypt/decrypt contract
 * exactly, because ciphertext must stay byte-identical across SDKs:
 * - counter nonces: the encryptor's 8-byte instance id (big-endian), then a
 *   4-byte big-endian counter from 0. The counter value is reserved in one
 *   synchronous step before any await, is never rolled back, and fails at
 *   2^32−1 (cachekit-core `generate_nonce`).
 * - instance ids: one counter per isolate, seeded once with 8 random bytes,
 *   giving each encryptor the next value, wrapping mod 2^64.
 * - wire format: nonce(12) ‖ ciphertext ‖ tag(16).
 * - the keyring decrypt loop: current key first, then each decrypt-only key
 *   in order, identical AAD each time; only an authentication failure moves
 *   on (cachekit-core `Keyring::decrypt`).
 * - the binding's input limits, checked before `crypto.subtle` is reached.
 */

import type { EncryptionBindings, EncryptionTenantKeys } from '../encryption/manager-core.js';
import { MAX_AAD_SIZE } from '../constants.js';

/** The two cachekit-core-wasm exports this adapter derives keys through. */
export interface KeyDerivationCore {
  deriveTenantKeys(
    masterKey: Uint8Array,
    tenantId: string
  ): { encryptionFingerprint(): Uint8Array; free(): void };
  deriveKey(masterKey: Uint8Array, domain: string, tenantSalt: string): Uint8Array;
}

// The wasm binding's limits (cachekit-core-wasm src/lib.rs) and cachekit-core's
// minimum ciphertext, nonce(12) + tag(16).
const MAX_PLAINTEXT_SIZE = 100 * 1024 * 1024;
const MAX_CIPHERTEXT_SIZE = MAX_PLAINTEXT_SIZE + 1024;
const NONCE_BYTES = 12;
const MIN_CIPHERTEXT_SIZE = NONCE_BYTES + 16;
/** Counter values at or above this fail: cachekit-core checks `counter >= u32::MAX`. */
const NONCE_COUNTER_LIMIT = 0xffffffff;

// Messages carry cachekit-core's Display strings. EncryptionManagerCore
// classifies "Nonce counter exhausted" into NonceExhaustedError.
const NONCE_EXHAUSTED = 'Nonce counter exhausted - key rotation required';
const AUTHENTICATION_FAILED = 'Authentication verification failed';

// WebCrypto's BufferSource excludes SharedArrayBuffer views, which the
// manager never passes; one that arrived would reject, as an EncryptionError.
type Bytes = Uint8Array<ArrayBuffer>;

let instanceCounter: bigint | undefined;

/**
 * The next encryptor instance id. Seeded on first use, not at import: Workers
 * refuse randomness in global scope.
 */
function nextInstanceId(): bigint {
  if (instanceCounter === undefined) {
    const seed = crypto.getRandomValues(new Uint8Array(8));
    instanceCounter = new DataView(seed.buffer).getBigUint64(0, false);
  }
  const id = instanceCounter;
  instanceCounter = BigInt.asUintN(64, id + 1n);
  return id;
}

/**
 * Test seam: set the isolate's instance-id counter, or clear it so the next
 * manager reseeds from `crypto.getRandomValues`.
 *
 * @internal
 */
export function setInstanceCounterForTesting(seed?: bigint): void {
  instanceCounter = seed === undefined ? undefined : BigInt.asUintN(64, seed);
}

/**
 * One manager's keys: the current key (encrypt and decrypt) first, then the
 * decrypt-only previous keys, all non-extractable CryptoKeys.
 */
export class WebCryptoTenantKeys implements EncryptionTenantKeys {
  /**
   * The next counter value an encrypt reserves. Advanced by every encrypt
   * that passes the size checks, including one that then fails.
   *
   * @internal
   */
  nonceCounter = 0;
  private keys: readonly CryptoKey[] | null;

  constructor(
    readonly tenantId: string,
    readonly instanceId: bigint,
    private readonly fingerprint: Uint8Array,
    keys: readonly CryptoKey[]
  ) {
    this.keys = keys;
  }

  encryptionFingerprint(): Uint8Array {
    return this.fingerprint.slice();
  }

  getNonceCounter(): number {
    return this.nonceCounter;
  }

  keyringEntryCount(): number {
    return this.keys?.length ?? 0;
  }

  // No hardwareAccelerationEnabled: an isolate cannot see whether the host's
  // WebCrypto uses AES instructions, so the manager reports null (unknown).

  /** Drop the CryptoKeys. They are not extractable, so the GC reclaims them. */
  free(): void {
    this.keys = null;
  }

  async encrypt(plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    if (plaintext.length > MAX_PLAINTEXT_SIZE) {
      throw new Error(`Plaintext exceeds maximum size of ${MAX_PLAINTEXT_SIZE} bytes`);
    }
    checkAad(aad);
    const key = this.liveKeys()[0];
    // Reserve the counter value before the first await: concurrent encrypts
    // on one manager must never share a nonce.
    const counter = this.nonceCounter++;
    if (counter >= NONCE_COUNTER_LIMIT) throw new Error(NONCE_EXHAUSTED);
    const nonce = new Uint8Array(NONCE_BYTES);
    const view = new DataView(nonce.buffer);
    view.setBigUint64(0, this.instanceId, false);
    view.setUint32(8, counter, false);

    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad as Bytes, tagLength: 128 },
      key,
      plaintext as Bytes
    );
    const out = new Uint8Array(NONCE_BYTES + sealed.byteLength);
    out.set(nonce);
    out.set(new Uint8Array(sealed), NONCE_BYTES);
    return out;
  }

  async decrypt(ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    if (ciphertext.length > MAX_CIPHERTEXT_SIZE) {
      throw new Error(`Ciphertext exceeds maximum size of ${MAX_CIPHERTEXT_SIZE} bytes`);
    }
    checkAad(aad);
    if (ciphertext.length < MIN_CIPHERTEXT_SIZE) {
      throw new Error('Invalid ciphertext format: Ciphertext too short');
    }
    const keys = this.liveKeys();
    const params = {
      name: 'AES-GCM',
      iv: ciphertext.subarray(0, NONCE_BYTES) as Bytes,
      additionalData: aad as Bytes,
      tagLength: 128,
    };
    const sealed = ciphertext.subarray(NONCE_BYTES) as Bytes;
    for (const key of keys) {
      try {
        return new Uint8Array(await crypto.subtle.decrypt(params, key, sealed));
      } catch (error) {
        // OperationError is WebCrypto's authentication failure: the wrong-key
        // signal. Anything else would fail the same way under every key.
        // Checked by name: a DOMException need not be an Error instance.
        if ((error as { name?: unknown } | null)?.name !== 'OperationError') throw error;
      }
    }
    throw new Error(AUTHENTICATION_FAILED);
  }

  private liveKeys(): readonly CryptoKey[] {
    if (this.keys === null) throw new Error('Tenant keys have been freed');
    return this.keys;
  }
}

function checkAad(aad: Uint8Array): void {
  if (aad.length > MAX_AAD_SIZE) {
    throw new Error(`AAD exceeds maximum size of ${MAX_AAD_SIZE} bytes`);
  }
}

/**
 * Derive one manager's keys. Every wasm call runs before the first await, so
 * all of them have returned before the caller can zero-fill the master-key
 * bytes: deriveKey checks only the key's length, and would silently derive
 * from an all-zero key.
 */
async function deriveTenantKeys(
  core: KeyDerivationCore,
  masterKey: Uint8Array,
  tenantId: string,
  previousMasterKeys: readonly Uint8Array[]
): Promise<WebCryptoTenantKeys> {
  // deriveTenantKeys enforces the tenant bounds and yields the fingerprint.
  // Its handle holds the raw derived keys, so it is freed (zeroized) at once.
  const handle = core.deriveTenantKeys(masterKey, tenantId);
  let fingerprint: Uint8Array;
  try {
    fingerprint = handle.encryptionFingerprint();
  } finally {
    handle.free();
  }

  const derived: Uint8Array[] = [];
  try {
    for (const master of [masterKey, ...previousMasterKeys]) {
      derived.push(core.deriveKey(master, 'encryption', tenantId));
    }
    const instanceId = nextInstanceId();
    const keys = await Promise.all(
      derived.map((bytes, index) =>
        crypto.subtle.importKey(
          'raw',
          bytes as Bytes,
          { name: 'AES-GCM' },
          false,
          index === 0 ? ['encrypt', 'decrypt'] : ['decrypt']
        )
      )
    );
    return new WebCryptoTenantKeys(tenantId, instanceId, fingerprint, keys);
  } finally {
    for (const bytes of derived) bytes.fill(0);
  }
}

/**
 * EncryptionBindings that encrypt and decrypt through `crypto.subtle`, on keys
 * cachekit-core derives. `core` is the initialised cachekit-core-wasm module.
 */
export function webCryptoEncryptionBindings(core: KeyDerivationCore): EncryptionBindings {
  return {
    deriveTenantKeys: (masterKey, tenantId, previousMasterKeys) =>
      deriveTenantKeys(core, masterKey, tenantId, previousMasterKeys ?? []),
    encryptWithTenantKeys: (plaintext, aad, tenantKeys) =>
      (tenantKeys as WebCryptoTenantKeys).encrypt(plaintext, aad),
    decryptWithTenantKeys: (ciphertext, aad, tenantKeys) =>
      (tenantKeys as WebCryptoTenantKeys).decrypt(ciphertext, aad),
  };
}

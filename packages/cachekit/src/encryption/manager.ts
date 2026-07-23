import { EncryptionManagerCore, type EncryptionBindings } from './manager-core.js';
import type { TenantKeys as NapiTenantKeys } from '@cachekit-io/cachekit-core-ts';

/**
 * NAPI bindings adapter (lazy-loaded). Typed member-by-member so tsc
 * enforces the EncryptionBindings contract against the NAPI d.ts — only the
 * TenantKeys handle parameter needs a narrowing cast (the manager passes
 * back exactly the handles this adapter's deriveTenantKeys returned).
 */
async function loadNapiBindings(): Promise<EncryptionBindings> {
  // Dynamic import to handle native module loading
  const napi = await import('@cachekit-io/cachekit-core-ts');
  return {
    deriveTenantKeys: napi.deriveTenantKeys,
    encryptWithTenantKeys: (plaintext, aad, tenantKeys) =>
      napi.encryptWithTenantKeys(plaintext, aad, tenantKeys as NapiTenantKeys),
    decryptWithTenantKeys: (ciphertext, aad, tenantKeys) =>
      napi.decryptWithTenantKeys(ciphertext, aad, tenantKeys as NapiTenantKeys),
  };
}

/**
 * High-level encryption manager wrapping native cachekit-core-ts bindings
 * (Node/NAPI). All protocol logic lives in {@link EncryptionManagerCore};
 * this shim only supplies the NAPI bindings loader, so the Workers entry can
 * supply the wasm loader without pulling the native module into its bundle.
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
export class EncryptionManager extends EncryptionManagerCore {
  /**
   * Create an EncryptionManager backed by the NAPI bindings (lazy-loaded).
   *
   * @param masterKey - Hex-encoded master key (min 32 bytes = 64 hex chars)
   * @param tenantId - Optional tenant ID for key derivation isolation
   * @throws {ConfigurationError} if masterKey is invalid
   */
  constructor(masterKey: string, tenantId?: string) {
    super(masterKey, tenantId, loadNapiBindings);
  }
}

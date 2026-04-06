/**
 * Real Crypto Integration Tests
 *
 * These tests use REAL AES-256-GCM encryption via the Rust FFI bindings.
 * NO MOCKS. Verifies actual cryptographic operations work end-to-end.
 *
 * Gap 1 Fix: testing-skeptic-validator identified mock theatre in manager.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  deriveTenantKeys,
  encryptWithTenantKeys,
  decryptWithTenantKeys,
  TenantKeys,
} from '@cachekit-io/cachekit-core-ts';
import { AAD_VERSION, MIN_MASTER_KEY_BYTES } from '../../src/constants.js';

// Test master key (32 bytes for AES-256)
const TEST_MASTER_KEY = new Uint8Array(32).fill(0x61); // 'a' repeated
const TEST_TENANT_ID = 'integration-test-tenant';

/**
 * Build AAD exactly as manager.ts does - copied here to avoid module mocking
 */
function buildAAD(
  tenantId: string,
  cacheKey: string,
  format = 'msgpack',
  compressed = false
): Uint8Array {
  const encoder = new TextEncoder();

  const components = [
    encoder.encode(tenantId),
    encoder.encode(cacheKey),
    encoder.encode(format),
    encoder.encode(compressed ? 'True' : 'False'),
  ];

  const totalLength = 1 + components.reduce((sum, c) => sum + 4 + c.length, 0);
  const aad = new Uint8Array(totalLength);
  const view = new DataView(aad.buffer);

  let offset = 0;
  aad[offset++] = AAD_VERSION;

  for (const component of components) {
    view.setUint32(offset, component.length, false);
    offset += 4;
    aad.set(component, offset);
    offset += component.length;
  }

  return aad;
}

describe('Real Crypto Integration (No Mocks)', () => {
  let tenantKeys: TenantKeys;

  beforeAll(() => {
    // Derive real keys using Rust FFI
    tenantKeys = deriveTenantKeys(TEST_MASTER_KEY, TEST_TENANT_ID);
  });

  describe('TenantKeys derivation', () => {
    it('derives keys from master key and tenant ID', () => {
      expect(tenantKeys).toBeDefined();
      expect(tenantKeys.tenantId).toBe(TEST_TENANT_ID);
    });

    it('produces 16-byte encryption fingerprint', () => {
      const fingerprint = tenantKeys.encryptionFingerprint();
      expect(fingerprint).toBeInstanceOf(Uint8Array);
      expect(fingerprint.length).toBe(16);
    });

    it('starts with nonce counter at 0', () => {
      // Fresh tenant keys should start at 0
      const freshKeys = deriveTenantKeys(TEST_MASTER_KEY, 'fresh-tenant');
      expect(freshKeys.getNonceCounter()).toBe(0);
    });

    it('produces different keys for different tenants', () => {
      const keys1 = deriveTenantKeys(TEST_MASTER_KEY, 'tenant-1');
      const keys2 = deriveTenantKeys(TEST_MASTER_KEY, 'tenant-2');

      const fp1 = keys1.encryptionFingerprint();
      const fp2 = keys2.encryptionFingerprint();

      // Different tenants = different fingerprints (key isolation)
      expect(Array.from(fp1)).not.toEqual(Array.from(fp2));
    });
  });

  describe('AES-256-GCM encrypt/decrypt round-trip', () => {
    it('encrypts and decrypts with TenantKeys API', () => {
      const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const cacheKey = 'test:cache:key';
      const aad = buildAAD(TEST_TENANT_ID, cacheKey);

      // Encrypt using real Rust crypto
      const ciphertext = encryptWithTenantKeys(plaintext, aad, tenantKeys);

      // Ciphertext should be larger (nonce + tag + encrypted data)
      // AES-GCM: 12-byte nonce + 16-byte tag + plaintext length
      expect(ciphertext.length).toBe(12 + 16 + plaintext.length);

      // Decrypt using real Rust crypto
      const decrypted = decryptWithTenantKeys(ciphertext, aad, tenantKeys);

      expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
    });

    it('encrypts same plaintext to different ciphertext (nonce uniqueness)', () => {
      const plaintext = new Uint8Array([42, 42, 42, 42]);
      const aad = buildAAD(TEST_TENANT_ID, 'nonce-test');

      // Create fresh keys to reset nonce counter
      const freshKeys = deriveTenantKeys(TEST_MASTER_KEY, 'nonce-test-tenant');

      const ct1 = encryptWithTenantKeys(plaintext, aad, freshKeys);
      const ct2 = encryptWithTenantKeys(plaintext, aad, freshKeys);

      // Nonces must be unique, so ciphertexts must differ
      expect(Array.from(ct1)).not.toEqual(Array.from(ct2));
    });

    it('increments nonce counter on each encryption', () => {
      const freshKeys = deriveTenantKeys(TEST_MASTER_KEY, 'counter-test');
      const plaintext = new Uint8Array([1, 2, 3]);
      const aad = buildAAD('counter-test', 'key');

      expect(freshKeys.getNonceCounter()).toBe(0);

      encryptWithTenantKeys(plaintext, aad, freshKeys);
      expect(freshKeys.getNonceCounter()).toBe(1);

      encryptWithTenantKeys(plaintext, aad, freshKeys);
      expect(freshKeys.getNonceCounter()).toBe(2);

      encryptWithTenantKeys(plaintext, aad, freshKeys);
      expect(freshKeys.getNonceCounter()).toBe(3);
    });

    it('decryption fails with wrong AAD (cache key mismatch)', () => {
      const plaintext = new Uint8Array([10, 20, 30]);
      const aadEncrypt = buildAAD(TEST_TENANT_ID, 'correct-key');
      const aadDecrypt = buildAAD(TEST_TENANT_ID, 'wrong-key');

      const ciphertext = encryptWithTenantKeys(plaintext, aadEncrypt, tenantKeys);

      // Should throw - AAD mismatch causes authentication failure
      expect(() => {
        decryptWithTenantKeys(ciphertext, aadDecrypt, tenantKeys);
      }).toThrow();
    });

    it('decryption fails with wrong tenant (key isolation)', () => {
      const plaintext = new Uint8Array([99, 88, 77]);
      const aad = buildAAD(TEST_TENANT_ID, 'tenant-isolation-test');

      const ciphertext = encryptWithTenantKeys(plaintext, aad, tenantKeys);

      // Try to decrypt with different tenant's keys
      const wrongTenantKeys = deriveTenantKeys(TEST_MASTER_KEY, 'wrong-tenant');

      expect(() => {
        decryptWithTenantKeys(ciphertext, aad, wrongTenantKeys);
      }).toThrow();
    });

    it('handles empty plaintext', () => {
      const emptyPlaintext = new Uint8Array(0);
      const aad = buildAAD(TEST_TENANT_ID, 'empty-test');

      const ciphertext = encryptWithTenantKeys(emptyPlaintext, aad, tenantKeys);
      const decrypted = decryptWithTenantKeys(ciphertext, aad, tenantKeys);

      expect(decrypted.length).toBe(0);
    });

    it('handles large plaintext (1MB)', () => {
      const largePlaintext = new Uint8Array(1024 * 1024);
      // Fill with pattern for verification
      for (let i = 0; i < largePlaintext.length; i++) {
        largePlaintext[i] = i % 256;
      }

      const aad = buildAAD(TEST_TENANT_ID, 'large-test');

      const ciphertext = encryptWithTenantKeys(largePlaintext, aad, tenantKeys);
      const decrypted = decryptWithTenantKeys(ciphertext, aad, tenantKeys);

      expect(decrypted.length).toBe(largePlaintext.length);
      // Verify first and last bytes
      expect(decrypted[0]).toBe(0);
      expect(decrypted[1023]).toBe(1023 % 256);
      expect(decrypted[1024 * 1024 - 1]).toBe((1024 * 1024 - 1) % 256);
    });
  });

  describe('Ciphertext structure (AES-GCM format)', () => {
    it('produces ciphertext with [nonce(12)][tag(16)][encrypted_data] format', () => {
      const plaintext = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
      const aad = buildAAD(TEST_TENANT_ID, 'structure-test');

      const ciphertext = encryptWithTenantKeys(plaintext, aad, tenantKeys);

      // Total: 12 (nonce) + 16 (tag) + 4 (plaintext)
      expect(ciphertext.length).toBe(12 + 16 + 4);
    });

    it('different encryptions produce different nonces', () => {
      const plaintext = new Uint8Array([1]);
      const aad = buildAAD(TEST_TENANT_ID, 'nonce-diff-test');
      const freshKeys = deriveTenantKeys(TEST_MASTER_KEY, 'nonce-diff-tenant');

      const ct1 = encryptWithTenantKeys(plaintext, aad, freshKeys);
      const ct2 = encryptWithTenantKeys(plaintext, aad, freshKeys);

      // Extract nonces (first 12 bytes)
      const nonce1 = ct1.slice(0, 12);
      const nonce2 = ct2.slice(0, 12);

      expect(Array.from(nonce1)).not.toEqual(Array.from(nonce2));
    });
  });

  describe('Special characters in cache keys', () => {
    it('handles cache keys with @ symbol', () => {
      const plaintext = new Uint8Array([1, 2, 3]);
      const aad = buildAAD(TEST_TENANT_ID, 'user@example.com');

      const ciphertext = encryptWithTenantKeys(plaintext, aad, tenantKeys);
      const decrypted = decryptWithTenantKeys(ciphertext, aad, tenantKeys);

      expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
    });

    it('handles cache keys with special characters', () => {
      const specialKeys = [
        'key:with:colons',
        'key/with/slashes',
        'key#with#hashes',
        'key$with$dollars',
        'key%with%percent',
        'key&with&ampersand',
        'key+with+plus',
        'key=with=equals',
        'unicode:\u4E2D\u6587',
        'emoji:\u{1F600}',
      ];

      const plaintext = new Uint8Array([42]);

      for (const key of specialKeys) {
        const aad = buildAAD(TEST_TENANT_ID, key);
        const ciphertext = encryptWithTenantKeys(plaintext, aad, tenantKeys);
        const decrypted = decryptWithTenantKeys(ciphertext, aad, tenantKeys);
        expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
      }
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { EncryptionManager } from './manager.js';
import { ConfigurationError, EncryptionError } from '../errors.js';

// Mock TenantKeys class with nonce counter (matches Rust implementation)
class MockTenantKeys {
  readonly tenantId: string;
  private nonceCounter = 0; // Track nonce usage like Rust encryptor

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  encryptionFingerprint(): Uint8Array {
    return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  }

  getNonceCounter(): number {
    return this.nonceCounter;
  }

  // Called internally by mock encrypt function
  incrementNonce(): void {
    this.nonceCounter++;
  }
}

// Mock the native bindings with TenantKeys pattern
vi.mock('@cachekit-io/cachekit-core-ts', () => ({
  TenantKeys: MockTenantKeys,
  deriveTenantKeys: (masterKey: Uint8Array, tenantId: string) => {
    if (masterKey.length < 16) throw new Error('Master key must be at least 16 bytes');
    if (!tenantId) throw new Error('tenant_id cannot be empty');
    return new MockTenantKeys(tenantId);
  },
  encryptWithTenantKeys: (
    plaintext: Uint8Array,
    aad: Uint8Array,
    tenantKeys: MockTenantKeys
  ): Uint8Array => {
    // Increment nonce counter like Rust encryptor does
    tenantKeys.incrementNonce();
    // Simple mock: prepend full AAD + plaintext
    const result = new Uint8Array(aad.length + plaintext.length);
    result.set(aad, 0);
    result.set(plaintext, aad.length);
    return result;
  },
  decryptWithTenantKeys: (
    ciphertext: Uint8Array,
    aad: Uint8Array,
    _tenantKeys: MockTenantKeys
  ): Uint8Array => {
    // Verify AAD matches completely
    if (ciphertext.length < aad.length) {
      throw new Error('AAD mismatch - ciphertext too short');
    }
    for (let i = 0; i < aad.length; i++) {
      if (ciphertext[i] !== aad[i]) {
        throw new Error('AAD mismatch');
      }
    }
    return ciphertext.slice(aad.length);
  },
}));

describe('EncryptionManager', () => {
  const validKey = 'a'.repeat(64); // 32 bytes in hex

  describe('constructor validation', () => {
    it('rejects non-hex master key', () => {
      expect(() => new EncryptionManager('not-hex-key')).toThrow(ConfigurationError);
    });

    it('rejects short master key', () => {
      expect(() => new EncryptionManager('aabb')).toThrow(ConfigurationError);
    });

    it('accepts valid hex key', () => {
      expect(() => new EncryptionManager(validKey)).not.toThrow();
    });
  });

  describe('encrypt/decrypt', () => {
    it('round-trips data', async () => {
      const manager = new EncryptionManager(validKey, 'test-tenant');
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const cacheKey = 'test:key';

      const encrypted = await manager.encrypt(data, cacheKey);
      const decrypted = await manager.decrypt(encrypted, cacheKey);

      expect(decrypted).toEqual(data);
      manager.dispose();
    });

    it('fails with wrong cache key', async () => {
      const manager = new EncryptionManager(validKey, 'test-tenant');
      const data = new Uint8Array([1, 2, 3]);

      const encrypted = await manager.encrypt(data, 'key1');

      await expect(manager.decrypt(encrypted, 'key2')).rejects.toThrow(EncryptionError);
      manager.dispose();
    });
  });

  describe('encryption count', () => {
    it('increments with each encryption', async () => {
      const manager = new EncryptionManager(validKey, 'test-tenant');

      await manager.encrypt(new Uint8Array([1]), 'key');
      expect(await manager.getEncryptionCount()).toBe(1);

      await manager.encrypt(new Uint8Array([2]), 'key');
      expect(await manager.getEncryptionCount()).toBe(2);

      manager.dispose();
    });
  });

  describe('dispose', () => {
    it('prevents further operations', async () => {
      const manager = new EncryptionManager(validKey, 'test-tenant');
      await manager.encrypt(new Uint8Array([1]), 'key'); // Initialize

      manager.dispose();

      await expect(manager.encrypt(new Uint8Array([1]), 'key')).rejects.toThrow(EncryptionError);
    });
  });

  describe('key fingerprint', () => {
    it('returns fingerprint after initialization', async () => {
      const manager = new EncryptionManager(validKey, 'test-tenant');
      await manager.encrypt(new Uint8Array([1]), 'key'); // Initialize

      const fingerprint = await manager.getKeyFingerprint();
      expect(fingerprint).toBeInstanceOf(Uint8Array);
      expect(fingerprint!.length).toBe(16);

      manager.dispose();
    });

    it('returns null before initialization', async () => {
      const manager = new EncryptionManager(validKey, 'test-tenant');

      const fingerprint = await manager.getKeyFingerprint();
      expect(fingerprint).toBeNull();

      manager.dispose();
    });
  });
});

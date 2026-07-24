/**
 * Encryption Protocol Vectors — Workers lane (LAB-595)
 *
 * Byte-verifies the wasm32 cachekit-core bindings and the Workers
 * EncryptionManager against protocol/test-vectors/encryption.json (Python
 * ground truth; vendored in ./fixtures/ — re-copy from the protocol repo on
 * spec change). Runs inside real workerd via @cloudflare/vitest-pool-workers,
 * so wasm instantiation itself is under test.
 *
 * Three layers:
 * 1. Raw wasm bindings decrypt EVERY ground-truth vector using the vector's
 *    own aad_hex (covers arrow/orjson/original_type AADs the TS SDK never
 *    builds itself).
 * 2. The Workers EncryptionManager decrypts the msgpack vectors from
 *    (cacheKey, compressed) alone — AES-GCM authentication makes a
 *    successful decrypt a cryptographic proof its AAD construction matches
 *    the ground-truth aad_hex byte-for-byte.
 * 3. Fingerprint, AAD literal equality, round-trips, counter-nonce
 *    monotonicity, and tamper rejection.
 */

import { describe, it, expect } from 'vitest';
import {
  ensureInitialized,
  deriveTenantKeys,
  encryptWithTenantKeys,
  decryptWithTenantKeys,
} from '@cachekit-io/cachekit-core-wasm';
import { EncryptionManager, ByteStorage } from '../../src/workers/runtime.js';
import { EncryptionError } from '../../src/errors.js';
import { AAD_VERSION } from '../../src/constants.js';
import fixture from './fixtures/encryption.json';

interface EncryptionVector {
  name: string;
  plaintext_hex: string;
  cache_key: string;
  format: string;
  compressed: boolean;
  original_type?: string;
  aad_hex: string;
  ciphertext_hex: string;
}

const vectors = fixture.vectors as EncryptionVector[];
const masterKeyHex = fixture.master_key_hex as string;
const tenantId = fixture.tenant_id as string;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Reference AAD builder straight from the spec (protocol v1.0.1 §5.6.2):
 * [version(0x03)] then 4-byte-BE-length-prefixed tenant_id, cache_key,
 * format, compressed ("True"/"False"), and optionally original_type.
 * Used to literal-check the fixture's aad_hex — the SDK's own builder is
 * verified cryptographically in the EncryptionManager layer below.
 */
function buildReferenceAAD(vector: EncryptionVector): Uint8Array {
  const encoder = new TextEncoder();
  const components = [
    encoder.encode(tenantId),
    encoder.encode(vector.cache_key),
    encoder.encode(vector.format),
    encoder.encode(vector.compressed ? 'True' : 'False'),
  ];
  if (vector.original_type !== undefined) {
    components.push(encoder.encode(vector.original_type));
  }
  const total = 1 + components.reduce((sum, c) => sum + 4 + c.length, 0);
  const aad = new Uint8Array(total);
  const view = new DataView(aad.buffer);
  let offset = 0;
  aad[offset++] = AAD_VERSION;
  for (const c of components) {
    view.setUint32(offset, c.length, false);
    offset += 4;
    aad.set(c, offset);
    offset += c.length;
  }
  return aad;
}

describe('encryption vectors — raw wasm bindings', () => {
  it('derived key fingerprint matches Python ground truth', () => {
    ensureInitialized();
    const tk = deriveTenantKeys(hexToBytes(masterKeyHex), tenantId);
    try {
      expect(bytesToHex(tk.encryptionFingerprint())).toBe(fixture.derived_key_fingerprint_hex);
      expect(tk.tenantId).toBe(tenantId);
    } finally {
      tk.free();
    }
  });

  it.each(vectors.map((v) => [v.name, v] as const))(
    'decrypts ground-truth vector %s',
    (_name, vector) => {
      ensureInitialized();
      const tk = deriveTenantKeys(hexToBytes(masterKeyHex), tenantId);
      try {
        const plaintext = decryptWithTenantKeys(
          hexToBytes(vector.ciphertext_hex),
          hexToBytes(vector.aad_hex),
          tk
        );
        expect(bytesToHex(plaintext)).toBe(vector.plaintext_hex);
      } finally {
        tk.free();
      }
    }
  );

  it.each(vectors.map((v) => [v.name, v] as const))(
    'fixture aad_hex for %s matches the spec AAD construction',
    (_name, vector) => {
      expect(bytesToHex(buildReferenceAAD(vector))).toBe(vector.aad_hex);
    }
  );

  it('round-trips with counter nonces (monotonic, no reuse)', () => {
    ensureInitialized();
    const tk = deriveTenantKeys(hexToBytes(masterKeyHex), tenantId);
    try {
      const aad = hexToBytes(vectors[0].aad_hex);
      const plaintext = hexToBytes(vectors[0].plaintext_hex);

      expect(tk.getNonceCounter()).toBe(0);
      const ct1 = encryptWithTenantKeys(plaintext, aad, tk);
      expect(tk.getNonceCounter()).toBe(1);
      const ct2 = encryptWithTenantKeys(plaintext, aad, tk);
      expect(tk.getNonceCounter()).toBe(2);

      // Same plaintext, different nonces → different ciphertexts
      expect(bytesToHex(ct1)).not.toBe(bytesToHex(ct2));
      // Nonce is the first 12 bytes of the wire format
      expect(bytesToHex(ct1.slice(0, 12))).not.toBe(bytesToHex(ct2.slice(0, 12)));

      expect(bytesToHex(decryptWithTenantKeys(ct1, aad, tk))).toBe(vectors[0].plaintext_hex);
      expect(bytesToHex(decryptWithTenantKeys(ct2, aad, tk))).toBe(vectors[0].plaintext_hex);
    } finally {
      tk.free();
    }
  });

  it('rejects tampered ciphertext and mismatched AAD', () => {
    ensureInitialized();
    const tk = deriveTenantKeys(hexToBytes(masterKeyHex), tenantId);
    try {
      const vector = vectors[0];
      const ciphertext = hexToBytes(vector.ciphertext_hex);
      const aad = hexToBytes(vector.aad_hex);

      const tampered = ciphertext.slice();
      tampered[tampered.length - 1] ^= 0x01; // flip a tag bit
      expect(() => decryptWithTenantKeys(tampered, aad, tk)).toThrow();

      const wrongAad = aad.slice();
      wrongAad[wrongAad.length - 1] ^= 0x01;
      expect(() => decryptWithTenantKeys(ciphertext, wrongAad, tk)).toThrow();
    } finally {
      tk.free();
    }
  });
});

describe('encryption vectors — Workers EncryptionManager', () => {
  // The manager builds AAD from (tenantId, cacheKey, 'msgpack', compressed):
  // exactly the vectors without a Python-serializer original_type extension.
  const managerVectors = vectors.filter(
    (v) => v.format === 'msgpack' && v.original_type === undefined
  );

  it('covers all msgpack vectors without original_type', () => {
    expect(managerVectors.length).toBeGreaterThanOrEqual(3);
  });

  it.each(managerVectors.map((v) => [v.name, v] as const))(
    'decrypts %s from (cacheKey, compressed) alone — proves AAD construction',
    async (_name, vector) => {
      const manager = new EncryptionManager(masterKeyHex, tenantId);
      try {
        const plaintext = await manager.decrypt(
          hexToBytes(vector.ciphertext_hex),
          vector.cache_key,
          vector.compressed
        );
        expect(bytesToHex(plaintext)).toBe(vector.plaintext_hex);
      } finally {
        manager.dispose();
      }
    }
  );

  it('reports the ground-truth key fingerprint after initialization', async () => {
    const manager = new EncryptionManager(masterKeyHex, tenantId);
    try {
      const vector = managerVectors[0];
      await manager.decrypt(hexToBytes(vector.ciphertext_hex), vector.cache_key, vector.compressed);
      const fingerprint = await manager.getKeyFingerprint();
      expect(fingerprint).not.toBeNull();
      expect(bytesToHex(fingerprint!)).toBe(fixture.derived_key_fingerprint_hex);
    } finally {
      manager.dispose();
    }
  });

  it('round-trips encrypt → decrypt and tracks the nonce counter', async () => {
    const manager = new EncryptionManager(masterKeyHex, tenantId);
    try {
      const data = new TextEncoder().encode('workers round-trip payload');
      expect(await manager.getEncryptionCount()).toBe(0);

      const ciphertext = await manager.encrypt(data, 'ns:workers:rt', false);
      expect(await manager.getEncryptionCount()).toBe(1);

      const plaintext = await manager.decrypt(ciphertext, 'ns:workers:rt', false);
      expect(plaintext).toEqual(data);
    } finally {
      manager.dispose();
    }
  });

  it('fails decryption when the cache key differs (AAD binding)', async () => {
    const manager = new EncryptionManager(masterKeyHex, tenantId);
    try {
      const ciphertext = await manager.encrypt(new Uint8Array([1, 2, 3]), 'ns:right-key', false);
      await expect(manager.decrypt(ciphertext, 'ns:wrong-key', false)).rejects.toThrow(
        EncryptionError
      );
    } finally {
      manager.dispose();
    }
  });

  it('rejects use after dispose', async () => {
    const manager = new EncryptionManager(masterKeyHex, tenantId);
    manager.dispose();
    await expect(manager.encrypt(new Uint8Array([1]), 'ns:k', false)).rejects.toThrow(
      EncryptionError
    );
  });
});

describe('encryption + envelope composition (wasm end-to-end)', () => {
  it('pack → encrypt → decrypt → unpack round-trips with compressed AAD flag', async () => {
    const manager = new EncryptionManager(masterKeyHex, tenantId);
    const storage = new ByteStorage();
    try {
      const data = new TextEncoder().encode('envelope+encryption '.repeat(64));
      const packed = storage.pack(data);
      const ciphertext = await manager.encrypt(packed, 'ns:composed', true);
      const unpacked = storage.unpack(await manager.decrypt(ciphertext, 'ns:composed', true));
      expect(unpacked).toEqual(data);
    } finally {
      manager.dispose();
      storage.free();
    }
  });
});

/**
 * AAD Format Protocol Tests
 *
 * These tests verify that the AAD (Additional Authenticated Data) format
 * matches the Python SDK exactly, ensuring cross-SDK interoperability.
 *
 * Protocol Spec: strategy/saas-protocol-v1.0.md Section 5.6.2
 * Format: [version_byte(0x03)][len1(4)][tenant_id][len2(4)][cache_key][len3(4)][format][len4(4)][compressed]
 */

import { describe, it, expect } from 'vitest';
import { AAD_VERSION } from '../../src/constants.js';

/**
 * Build AAD exactly as Python does (copied from manager.ts for testing)
 * This is the reference implementation for cross-SDK compatibility.
 */
function buildAAD(
  tenantId: string,
  cacheKey: string,
  format = 'msgpack',
  compressed = false
): Uint8Array {
  const encoder = new TextEncoder();

  // Encode all components as UTF-8 (matches Python exactly)
  const components = [
    encoder.encode(tenantId),
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

/**
 * Parse AAD to verify format (debugging helper)
 */
function parseAAD(aad: Uint8Array): {
  version: number;
  tenantId: string;
  cacheKey: string;
  format: string;
  compressed: string;
} {
  const decoder = new TextDecoder();
  const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);

  let offset = 0;
  const version = aad[offset++];

  const components: string[] = [];
  while (offset < aad.length) {
    const length = view.getUint32(offset, false); // big-endian
    offset += 4;
    const component = decoder.decode(aad.slice(offset, offset + length));
    components.push(component);
    offset += length;
  }

  return {
    version,
    tenantId: components[0] ?? '',
    cacheKey: components[1] ?? '',
    format: components[2] ?? '',
    compressed: components[3] ?? '',
  };
}

describe('AAD v0x03 Protocol Compatibility', () => {
  it('uses version byte 0x03', () => {
    expect(AAD_VERSION).toBe(0x03);
  });

  it('builds AAD with correct structure', () => {
    const aad = buildAAD('tenant-123', 'cache:users:42', 'msgpack', false);

    // Parse it back
    const parsed = parseAAD(aad);

    expect(parsed.version).toBe(0x03);
    expect(parsed.tenantId).toBe('tenant-123');
    expect(parsed.cacheKey).toBe('cache:users:42');
    expect(parsed.format).toBe('msgpack');
    expect(parsed.compressed).toBe('False'); // Python str(False) format
  });

  it('uses Python str(bool) format for compressed', () => {
    const aadFalse = buildAAD('t', 'k', 'msgpack', false);
    const aadTrue = buildAAD('t', 'k', 'msgpack', true);

    expect(parseAAD(aadFalse).compressed).toBe('False'); // Not 'false'
    expect(parseAAD(aadTrue).compressed).toBe('True'); // Not 'true'
  });

  it('uses 4-byte big-endian length prefixes', () => {
    const aad = buildAAD('AB', 'CD', 'EF', false);
    const view = new DataView(aad.buffer);

    // After version byte (offset 0), first length at offset 1
    expect(view.getUint32(1, false)).toBe(2); // 'AB' = 2 bytes

    // After 'AB' (offset 1 + 4 + 2 = 7), second length
    expect(view.getUint32(7, false)).toBe(2); // 'CD' = 2 bytes
  });

  /**
   * Test vector generated from Python:
   *
   * >>> wrapper = EncryptionWrapper(master_key=b"a" * 32, tenant_id="test")
   * >>> meta = SerializationMetadata(serialization_format=SerializationFormat.MSGPACK, compressed=False)
   * >>> aad = wrapper._create_aad(meta, "mykey")
   * >>> aad.hex()
   * '03000000047465737400000005 6d796b657900000007 6d73677061636b00000005 46616c7365'
   *
   * Breakdown:
   * - 03: version byte
   * - 00000004: length 4 (big-endian)
   * - 74657374: "test" in UTF-8
   * - 00000005: length 5
   * - 6d796b6579: "mykey" in UTF-8
   * - 00000007: length 7
   * - 6d73677061636b: "msgpack" in UTF-8
   * - 00000005: length 5
   * - 46616c7365: "False" in UTF-8
   */
  it('matches Python test vector', () => {
    const aad = buildAAD('test', 'mykey', 'msgpack', false);

    // Expected bytes from Python (spaces removed for comparison)
    const expectedHex =
      '03000000047465737400000005' + '6d796b657900000007' + '6d73677061636b00000005' + '46616c7365';

    const actualHex = Array.from(aad)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    expect(actualHex).toBe(expectedHex);
  });

  it('handles empty tenant_id correctly', () => {
    const aad = buildAAD('', 'key', 'msgpack', false);
    const parsed = parseAAD(aad);

    expect(parsed.tenantId).toBe('');
  });

  it('handles unicode characters correctly', () => {
    const aad = buildAAD('tenant-\u{1F600}', 'cache:\u4E2D\u6587', 'msgpack', false);
    const parsed = parseAAD(aad);

    expect(parsed.tenantId).toBe('tenant-\u{1F600}');
    expect(parsed.cacheKey).toBe('cache:\u4E2D\u6587');
  });

  it('produces different AAD for different cache keys (substitution attack prevention)', () => {
    const aad1 = buildAAD('tenant', 'users:1', 'msgpack', false);
    const aad2 = buildAAD('tenant', 'users:2', 'msgpack', false);

    // Must be different - this is what prevents ciphertext substitution
    expect(aad1).not.toEqual(aad2);
  });

  it('produces different AAD for different tenants (isolation guarantee)', () => {
    const aad1 = buildAAD('tenant-a', 'key', 'msgpack', false);
    const aad2 = buildAAD('tenant-b', 'key', 'msgpack', false);

    expect(aad1).not.toEqual(aad2);
  });
});

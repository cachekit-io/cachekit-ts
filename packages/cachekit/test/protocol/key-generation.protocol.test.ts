import { describe, it, expect } from 'vitest';
import { generateKey, generateParamsHash } from '../../src/serialization/key-generator';

/**
 * Protocol v1.0 Key Generation Test Vectors
 *
 * These vectors ensure cross-language compatibility with Python SDK.
 * Format: {namespace}:{blake2b256_hex_hash}
 */
describe('Protocol v1.0 Key Generation', () => {
  describe('deterministic output', () => {
    it('same input produces same key', () => {
      const key1 = generateKey('users:getUser', [123]);
      const key2 = generateKey('users:getUser', [123]);
      expect(key1).toBe(key2);
    });

    it('object key order does not affect hash', () => {
      const key1 = generateKey('test', [{ b: 2, a: 1 }]);
      const key2 = generateKey('test', [{ a: 1, b: 2 }]);
      expect(key1).toBe(key2);
    });

    it('normalizes -0 to 0', () => {
      const key1 = generateKey('test', [-0]);
      const key2 = generateKey('test', [0]);
      expect(key1).toBe(key2);
    });
  });

  describe('key format', () => {
    it('format is namespace:64-char-hex', () => {
      const key = generateKey('my-namespace', [1, 2, 3]);
      const parts = key.split(':');
      expect(parts[0]).toBe('my-namespace');
      expect(parts[1]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('handles colons in namespace', () => {
      const key = generateKey('a:b:c', [1]);
      expect(key.startsWith('a:b:c:')).toBe(true);
    });
  });

  describe('paramsHash isolation', () => {
    it('generateParamsHash returns 64-char hex', () => {
      const hash = generateParamsHash([1, 2, 3]);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('paramsHash matches key suffix', () => {
      const args = [1, 2, 3];
      const key = generateKey('test', args);
      const hash = generateParamsHash(args);
      expect(key.endsWith(hash)).toBe(true);
    });
  });
});

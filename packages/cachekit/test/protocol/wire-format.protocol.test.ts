import { describe, it, expect } from 'vitest';
import { ByteStorage } from '@cachekit-io/cachekit-core-ts';

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
 * Protocol v1.0 Wire Format (ByteStorage Envelope) Tests
 *
 * Verifies LZ4 compression + xxHash3-64 integrity wrapping via the Rust NAPI binding.
 * The envelope format is a MessagePack array: [compressed_data, checksum, original_size, format].
 */
describe('Protocol v1.0 Wire Format (ByteStorage)', () => {
  const bs = new ByteStorage();

  describe('pack/unpack round-trip', () => {
    it('round-trips empty data', () => {
      const data = new Uint8Array(0);
      const packed = bs.pack(data);
      const unpacked = bs.unpack(packed);
      expect(unpacked).toEqual(data);
    });

    it('round-trips small data', () => {
      const data = new TextEncoder().encode('hello world');
      const packed = bs.pack(data);
      const unpacked = bs.unpack(packed);
      expect(unpacked).toEqual(data);
    });

    it('round-trips large compressible data', () => {
      const data = new TextEncoder().encode('abcdefgh'.repeat(10000));
      const packed = bs.pack(data);
      const unpacked = bs.unpack(packed);
      expect(unpacked).toEqual(data);
    });

    it('round-trips binary data', () => {
      const data = new Uint8Array(256);
      for (let i = 0; i < 256; i++) data[i] = i;
      const packed = bs.pack(data);
      const unpacked = bs.unpack(packed);
      expect(unpacked).toEqual(data);
    });
  });

  describe('compression effectiveness', () => {
    it('compresses repetitive data', () => {
      const data = new TextEncoder().encode('hello '.repeat(1000));
      const packed = bs.pack(data);
      expect(packed.length).toBeLessThan(data.length);
    });

    it('handles incompressible data without growth explosion', () => {
      // Random-ish data that won't compress
      const data = new Uint8Array(1000);
      for (let i = 0; i < data.length; i++) data[i] = (i * 131 + 17) & 0xff;
      const packed = bs.pack(data);
      // Envelope has overhead, but shouldn't be more than 2x
      expect(packed.length).toBeLessThan(data.length * 2);
      // Verify round-trip still works
      expect(bs.unpack(packed)).toEqual(data);
    });
  });

  describe('integrity verification', () => {
    it('rejects corrupted packed data', () => {
      const data = new TextEncoder().encode('integrity test');
      const packed = bs.pack(data);

      // Corrupt a byte in the middle of the packed data
      const corrupted = new Uint8Array(packed);
      corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;

      expect(() => bs.unpack(corrupted)).toThrow();
    });

    it('rejects truncated packed data', () => {
      const data = new TextEncoder().encode('truncation test');
      const packed = bs.pack(data);

      const truncated = packed.slice(0, packed.length - 5);
      expect(() => bs.unpack(truncated)).toThrow();
    });

    it('rejects garbage input', () => {
      const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      expect(() => bs.unpack(garbage)).toThrow();
    });
  });

  describe('validate()', () => {
    it('returns true for valid packed data', () => {
      const data = new TextEncoder().encode('validate test');
      const packed = bs.pack(data);
      expect(bs.validate(packed)).toBe(true);
    });

    it('returns false for corrupted data', () => {
      const data = new TextEncoder().encode('validate test');
      const packed = bs.pack(data);
      const corrupted = new Uint8Array(packed);
      corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
      expect(bs.validate(corrupted)).toBe(false);
    });

    it('returns false for garbage input', () => {
      expect(bs.validate(new Uint8Array([0xde, 0xad]))).toBe(false);
    });
  });

  describe('compression ratio estimation', () => {
    it('estimates compression ratio for compressible data', () => {
      const data = new TextEncoder().encode('compress me '.repeat(500));
      const ratio = bs.estimateCompressionRatio(data);
      // Ratio is original/compressed, so > 1 for compressible data
      expect(ratio).toBeGreaterThan(1);
    });
  });

  describe('canonical cross-SDK fixture', () => {
    // Generated from Python: ByteStorage("msgpack").store(b"Hello, CacheKit!", "msgpack")
    // Verified byte-for-byte identical output from both Python and TypeScript NAPI.
    const CANONICAL_INPUT_HEX = '48656c6c6f2c2043616368654b697421'; // "Hello, CacheKit!"
    const CANONICAL_PACKED_HEX =
      '94dc0012ccf00148656c6c6f2c2043616368654b69742198796ecced283c5d69cc8d10a76d73677061636b';

    it('pack produces canonical envelope byte-for-byte', () => {
      const input = hexToBytes(CANONICAL_INPUT_HEX);
      const packed = bs.pack(input);
      expect(bytesToHex(packed)).toBe(CANONICAL_PACKED_HEX);
    });

    it('unpack recovers original payload from canonical envelope', () => {
      const packed = hexToBytes(CANONICAL_PACKED_HEX);
      const unpacked = bs.unpack(packed);
      expect(bytesToHex(unpacked)).toBe(CANONICAL_INPUT_HEX);
    });

    it('Python-generated envelope unpacks correctly in TypeScript', () => {
      // This is the critical cross-SDK interop assertion:
      // Python packed this → TypeScript must unpack it identically
      const pythonPacked = hexToBytes(CANONICAL_PACKED_HEX);
      const result = bs.unpack(pythonPacked);
      expect(bytesToHex(result)).toBe(CANONICAL_INPUT_HEX);
    });
  });
});

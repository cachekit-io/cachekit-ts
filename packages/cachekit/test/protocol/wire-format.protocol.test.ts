import { describe, it, expect } from 'vitest';
import { decode } from '@msgpack/msgpack';
import { ByteStorage } from '@cachekit-io/cachekit-core-ts';
import { readEnvelopeHeader } from '../../src/serialization/envelope.js';
// Single vendored copy of protocol/test-vectors/wire-format.json (see the
// workers lane header for the re-copy rule); this lane runs the same vectors
// through the NAPI binding so both bindings are held to identical bytes.
import fixture from '../workers/fixtures/wire-format.json' with { type: 'json' };

interface WireVector {
  name: string;
  description: string;
  input_hex: string;
  envelope_hex: string;
  format: string;
  /** "bin" on protocol 1.1 vectors; absent on legacy array-of-integers vectors. */
  envelope_encoding?: string;
}

const vectors = fixture.vectors as WireVector[];
const binVectors = vectors.filter((v) => v.envelope_encoding === 'bin');
const legacyVectors = vectors.filter((v) => v.envelope_encoding === undefined);

// The envelope is a 4-element fixarray (0x94), so byte 1 is the msgpack
// marker of compressed_data. This returns the one marker a conforming
// (shortest-form) writer emits for that length — bin8 / bin16 / bin32 —
// derived, never a tolerated set, so a wider-than-needed header fails.
function expectedBinMarker(compressedLength: number): number {
  if (compressedLength <= 0xff) return 0xc4;
  if (compressedLength <= 0xffff) return 0xc5;
  return 0xc6;
}

// Envelope element [0]. bin decodes to Uint8Array; a legacy array-of-integers
// envelope would decode to number[] and is rejected here.
function compressedData(envelope: Uint8Array): Uint8Array {
  const [compressed] = decode(envelope) as unknown[];
  if (!(compressed instanceof Uint8Array)) throw new Error('compressed_data is not msgpack bin');
  return compressed;
}

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
 * Protocol v1.1 Wire Format (ByteStorage Envelope) Tests
 *
 * Verifies LZ4 compression + xxHash3-64 integrity wrapping via the Rust NAPI binding.
 * The envelope format is a MessagePack array: [compressed_data, checksum, original_size, format].
 * Since protocol 1.1 (cachekit-core 0.4.0) fresh packs encode compressed_data as msgpack
 * bin; legacy array-of-integers envelopes stay readable forever (dual-read).
 */
describe('Protocol v1.1 Wire Format (ByteStorage)', () => {
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
    const CANONICAL_INPUT_HEX = '48656c6c6f2c2043616368654b697421'; // "Hello, CacheKit!"
    // Protocol 1.1 (core 0.4.0): compressed_data as msgpack bin.
    const CANONICAL_PACKED_HEX =
      '94c412f00148656c6c6f2c2043616368654b69742198796ecced283c5d69cc8d10a76d73677061636b';
    // Pre-0.4.0 encoding of the same envelope (array-of-integers, generated
    // from Python: ByteStorage("msgpack").store(b"Hello, CacheKit!", "msgpack")).
    // Kept forever: protocol 1.1 is dual-read.
    const LEGACY_PACKED_HEX =
      '94dc0012ccf00148656c6c6f2c2043616368654b69742198796ecced283c5d69cc8d10a76d73677061636b';

    it('pack produces canonical bin envelope byte-for-byte', () => {
      const input = hexToBytes(CANONICAL_INPUT_HEX);
      const packed = bs.pack(input);
      expect(bytesToHex(packed)).toBe(CANONICAL_PACKED_HEX);
    });

    it('unpack recovers original payload from canonical envelope', () => {
      const packed = hexToBytes(CANONICAL_PACKED_HEX);
      const unpacked = bs.unpack(packed);
      expect(bytesToHex(unpacked)).toBe(CANONICAL_INPUT_HEX);
    });

    it('legacy (pre-0.4.0) envelope unpacks correctly', () => {
      // The critical mixed-version assertion: values packed by any pre-bin
      // writer must keep decoding identically.
      const legacyPacked = hexToBytes(LEGACY_PACKED_HEX);
      const result = bs.unpack(legacyPacked);
      expect(bytesToHex(result)).toBe(CANONICAL_INPUT_HEX);
    });
  });

  describe('protocol wire-format.json vectors', () => {
    it('vendors fixture 1.1.1: seven legacy vectors, seven bin twins, bin8 and bin16 pinned', () => {
      expect(fixture.version).toBe('1.1.1');
      expect(legacyVectors).toHaveLength(7);
      expect(binVectors).toHaveLength(7);
      expect(new Set(binVectors.map((v) => hexToBytes(v.envelope_hex)[1]))).toEqual(
        new Set([0xc4, 0xc5])
      );
    });

    it.each(binVectors.map((v) => [v.name, v] as const))(
      'pinned bin envelope %s carries the width its compressed_data length demands',
      (_name, vector) => {
        const envelope = hexToBytes(vector.envelope_hex);
        expect(envelope[0]).toBe(0x94);
        expect(envelope[1]).toBe(expectedBinMarker(compressedData(envelope).length));
      }
    );

    it.each(binVectors.map((v) => [v.name, v] as const))(
      'pack emits the protocol 1.1 bin envelope byte-for-byte (%s)',
      (_name, vector) => {
        const packed = bs.pack(hexToBytes(vector.input_hex));
        expect(bytesToHex(packed)).toBe(vector.envelope_hex);
      }
    );

    it.each(vectors.map((v) => [v.name, v] as const))(
      'unpacks ground-truth envelope %s',
      (_name, vector) => {
        const unpacked = bs.unpack(hexToBytes(vector.envelope_hex));
        expect(bytesToHex(unpacked)).toBe(vector.input_hex);
      }
    );

    it('decodes every legacy (pre-bin) envelope', () => {
      expect(legacyVectors.length).toBeGreaterThan(0);
      for (const vector of legacyVectors) {
        expect(bytesToHex(bs.unpack(hexToBytes(vector.envelope_hex)))).toBe(vector.input_hex);
      }
    });

    it('pack marks compressed_data as msgpack bin for arbitrary payloads', () => {
      // Not in the vector set: one bin8-sized and one bin16-sized payload. The
      // large one repeats every 256 bytes, so LZ4 shrinks it to ~270 B — just
      // over the bin8 limit; the explicit marker keeps that claim tested.
      const small = new TextEncoder().encode('fresh bin-emit check');
      const large = new Uint8Array(1000);
      for (let i = 0; i < large.length; i++) large[i] = (i * 131 + 17) & 0xff;
      const cases = [
        [small, 0xc4],
        [large, 0xc5],
      ] as const;
      for (const [payload, marker] of cases) {
        const packed = bs.pack(payload);
        expect(packed[0]).toBe(0x94); // fixarray(4) envelope
        expect(packed[1]).toBe(marker);
        expect(packed[1]).toBe(expectedBinMarker(compressedData(packed).length));
        expect(bs.unpack(packed)).toEqual(payload);
      }
    });
  });

  // The SDK reads original_size itself so it can refuse an oversized envelope
  // before unpack allocates it. It must agree with core on every conforming
  // envelope — both encodings — or a legitimate entry would stop reading.
  describe('readEnvelopeHeader (pre-unpack header read)', () => {
    const declared = (bytes: Uint8Array) => readEnvelopeHeader(bytes)?.declaredSize ?? null;

    it.each(vectors.map((v) => [v.name, v] as const))(
      'reads original_size from ground-truth envelope %s',
      (_name, vector) => {
        expect(declared(hexToBytes(vector.envelope_hex))).toBe(vector.input_hex.length / 2);
      }
    );

    it('reads original_size and compressed length from fresh packs across every uint width', () => {
      for (const size of [0, 1, 127, 128, 255, 256, 65535, 65536, 200_000]) {
        const payload = new Uint8Array(size);
        for (let i = 0; i < size; i++) payload[i] = (i * 131 + 17) & 0xff;
        const packed = bs.pack(payload);
        const header = readEnvelopeHeader(packed);
        expect(header?.declaredSize).toBe(size);
        // envelopeVerdict refuses anything past lz4_flex's worst case; the
        // real writer must stay inside it, even on incompressible input.
        expect(header!.compressedLength).toBeGreaterThan(0);
        expect(header!.compressedLength).toBeLessThanOrEqual(20 + Math.floor((size * 110) / 100));
      }
    });

    it('returns null for every truncation, and for trailing bytes', () => {
      const packed = bs.pack(new TextEncoder().encode('truncation walk'));
      for (let len = 0; len < packed.length; len++) {
        expect(declared(packed.subarray(0, len))).toBeNull();
      }
      expect(declared(packed)).toBe(15);
      const padded = new Uint8Array(packed.length + 1);
      padded.set(packed);
      expect(declared(padded)).toBeNull();
    });

    it('requires format to be a short UTF-8 str or bin, as core decodes it', () => {
      // [bin(0), [8 x 0], 0, <format>]: only the format slot varies.
      const head = [0x94, 0xc4, 0x00, 0x98, 0, 0, 0, 0, 0, 0, 0, 0, 0x00];
      const withFormat = (tail: number[]) => declared(new Uint8Array([...head, ...tail]));
      const text = (n: number) => Array.from({ length: n }, () => 0x61);

      expect(withFormat([0xa1, 0x61])).toBe(0); // fixstr
      expect(withFormat([0xd9, 64, ...text(64)])).toBe(0); // str8 at the cap
      expect(withFormat([0xc4, 1, 0x61])).toBe(0); // bin: serde's String takes it
      expect(withFormat([0xd9, 65, ...text(65)])).toBeNull(); // over the cap
      expect(withFormat([0xa1, 0xff])).toBeNull(); // invalid UTF-8
      for (const tail of [[0x00], [0xc0], [0xcb, 0, 0, 0, 0, 0, 0, 0, 0], [0x81, 0xa1, 0x61, 1]]) {
        expect(withFormat(tail)).toBeNull(); // int, nil, float, map
      }
    });

    it('returns null for shapes no conforming writer emits', () => {
      const cases: number[][] = [
        [], // empty
        [0x93, 0xc4, 0x00, 0x98, 0, 0, 0, 0, 0, 0, 0, 0, 0x00], // 3-tuple
        [0x94, 0xa1, 0x41, 0x98, 0, 0, 0, 0, 0, 0, 0, 0, 0x00], // [0] is a str
        [0x94, 0xc4, 0x00, 0x97, 0, 0, 0, 0, 0, 0, 0, 0x00], // 7-byte checksum
        [0x94, 0xc4, 0x00, 0x98, 0, 0, 0, 0, 0, 0, 0, 0xcd, 0x01, 0x00, 0x00], // checksum byte > 0xff
        [0x94, 0xc4, 0x00, 0x98, 0, 0, 0, 0, 0, 0, 0, 0, 0xd2, 0, 0, 0, 1], // int32 size
        [0x94, 0xc4, 0x00, 0x98, 0, 0, 0, 0, 0, 0, 0, 0, 0xcf, 0, 0, 0, 0, 0, 0, 0, 1], // uint64 size
        [0x94, 0xc4, 0x05, 0x00], // bin length runs past the end
        [0x94, 0x91, 0xcd, 0x01, 0x00, 0x98, 0, 0, 0, 0, 0, 0, 0, 0, 0x00], // legacy byte > 0xff
      ];
      for (const bytes of cases) {
        expect(readEnvelopeHeader(new Uint8Array(bytes))).toBeNull();
      }
    });

    it('reads through a subarray view (non-zero byteOffset)', () => {
      const packed = bs.pack(new TextEncoder().encode('offset'));
      const padded = new Uint8Array(packed.length + 7);
      padded.set(packed, 7);
      expect(declared(padded.subarray(7))).toBe(6);
    });
  });
});

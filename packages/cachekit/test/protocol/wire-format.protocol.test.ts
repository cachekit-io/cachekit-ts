import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { ByteStorage } from '@cachekit-io/cachekit-core-ts';
import { createCache } from '../../src/index.js';
import { envelopeVerdict, readEnvelopeHeader } from '../../src/serialization/envelope.js';
import { decodeInteropValue } from '../../src/serialization/interop.js';
// Single vendored copy of protocol/test-vectors/wire-format.json (see the
// FIXTURE_SHA256 docblock below for the re-vendor rule); this lane runs the
// same vectors through the NAPI binding so both bindings are held to identical bytes.
import {
  REJECT_EXPECTATIONS,
  binVectors,
  bytesToHex,
  compressedData,
  construct,
  constructedDataLength,
  constructedVectors,
  expectRevived,
  expectSpecError,
  expectUnrevived,
  expectedBinMarker,
  firstMismatch,
  fixture,
  hexToBytes,
  legacyVectors,
  payloadRejectVectors,
  readRejection,
  readValue,
  rejectVectors,
  storedReadConfig,
  temporalSentinelVectors,
  vectors,
} from '../fixtures/wire-vectors.js';

/**
 * sha256 of test-vectors/wire-format.json (fixture version 1.4.0).
 * Provenance: cachekit-io/protocol @ 4b8fddb2 (the merge of cachekit-io/protocol#171). Re-vendoring means copying the
 * file byte-for-byte from a named protocol revision, then changing together:
 * the version and revision in this docblock, the FIXTURE_SHA256 value below,
 * the version/count guard in the "protocol wire-format.json vectors" suite,
 * the constructed-vector name guards in both lanes (here and
 * test/workers/wire-format.workers.test.ts), and the reject-vector set,
 * REJECT_EXPECTATIONS in test/fixtures/wire-vectors.ts.
 */
const FIXTURE_SHA256 = '2f6818903a552a7c09414c1e5c02caf21fa92dcd56ccff5634c8257038e7575c'; // pragma: allowlist secret

// Raw bytes of the same file the JSON import above parses: the pin covers
// every byte (legacy vectors and the limits block included), not a re-serialisation.
const rawFixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'workers', 'fixtures', 'wire-format.json')
);

// LAB-7084: pack/unpack return a plain Uint8Array (not a Buffer) that owns its
// whole ArrayBuffer: no pool slab, no offset view.
function expectOwnedCopy(bytes: Uint8Array): void {
  expect(bytes.constructor).toBe(Uint8Array);
  expect(bytes.byteOffset).toBe(0);
  expect(bytes.byteLength).toBe(bytes.buffer.byteLength);
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
      expectOwnedCopy(packed);
    });

    it('unpack recovers original payload from canonical envelope', () => {
      const packed = hexToBytes(CANONICAL_PACKED_HEX);
      const unpacked = bs.unpack(packed);
      expect(bytesToHex(unpacked)).toBe(CANONICAL_INPUT_HEX);
      expectOwnedCopy(unpacked);
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
    it('fixture is the pinned upstream file, unedited since vendoring', () => {
      expect(
        createHash('sha256').update(rawFixture).digest('hex'),
        'fixture differs from the pinned protocol revision; if intentional, follow the re-vendor list in the FIXTURE_SHA256 docblock'
      ).toBe(FIXTURE_SHA256);
    });

    it('vendors fixture 1.4.0: nine legacy vectors, nine bin twins, bin8 and bin16 pinned', () => {
      expect(fixture.version).toBe('1.4.0');
      expect(legacyVectors).toHaveLength(9);
      expect(binVectors).toHaveLength(9);
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

    it('carries the ratio-wrap and the bin16 -> bin32 edge constructed vectors', () => {
      expect(constructedVectors.map((v) => v.name)).toEqual([
        'envelope_ratio_product_wraps_32_bits',
        'envelope_bin16_max',
        'envelope_bin32_min',
        'envelope_legacy_array32_min',
      ]);
    });

    // The ratio-wrap envelope's compressed_data is the first length at which
    // 1000 * compressed_size overflows 32 bits; a reader that multiplies in
    // 32-bit width rejects it. This NAPI build is 64-bit, so a pointer-width
    // reader passes here too: only the Workers lane proves wasm32. The other
    // three sit either side of the bin16 -> bin32 edge, one in the legacy
    // array32 encoding. The SDK's own header gate must admit each one too.
    it.each(constructedVectors.map((v) => [v.name, v] as const))(
      'unpacks constructed envelope %s to its constructed input',
      (_name, vector) => {
        const envelope = construct(vector.envelope_construction);
        const input = construct(vector.input_construction);
        expect(envelope.length).toBe(vector.envelope_size);
        expect(input.length).toBe(vector.original_size);
        expect(constructedDataLength(envelope, vector.envelope_encoding)).toBe(
          vector.compressed_size
        );
        expect(envelopeVerdict(envelope, fixture.limits.max_uncompressed_size)).toBe('unpack');
        expect(firstMismatch(bs.unpack(envelope), input)).toBe(-1);
      }
    );

    it('carries the fourteen reject vectors', () => {
      expect(rejectVectors.map((v) => v.name)).toEqual(Object.keys(REJECT_EXPECTATIONS));
    });

    // Through the SDK's compression-on read, as a stored entry: the header
    // checks in envelopeVerdict, then core's unpack.
    it.each(rejectVectors.map((v) => [v.name, v] as const))(
      'refuses reject vector %s on the envelope read path with the error the spec names',
      async (name, vector) => {
        const error = await readRejection(
          createCache(storedReadConfig(hexToBytes(vector.envelope_hex)))
        );
        expectSpecError(error, name);
      }
    );

    it('carries the two payload reject vectors', () => {
      expect(payloadRejectVectors.map((v) => v.name)).toEqual([
        'payload_array32_max_claim_alone',
        'payload_nested_array16_each_header_fits_sum_overclaims',
      ]);
    });

    // The envelope is sound, so the refusal can only come from the payload
    // decode's structural guard, which must reject before materialising.
    it.each(payloadRejectVectors.map((v) => [v.name, v] as const))(
      'refuses payload reject vector %s with the payload pre-scan error',
      async (_name, vector) => {
        const envelope = hexToBytes(vector.envelope_hex);
        expect(bytesToHex(bs.unpack(envelope))).toBe(vector.input_hex);
        const error = await readRejection(createCache(storedReadConfig(envelope)));
        expect(error.message).toMatch(/\(decode pre-scan\)$/);
      }
    );

    // WIRE-20 asks every SDK to revive all three maps. This SDK revives none
    // on the default path, and only __datetime__ in interop mode; how a
    // JavaScript reader should revive a date or a time is an open question,
    // so those are held as expected failures, not changed here.
    it('carries the three temporal sentinel vectors', () => {
      expect(temporalSentinelVectors.map((v) => v.revives_to.type)).toEqual([
        'datetime',
        'date',
        'time',
      ]);
    });

    it.each(temporalSentinelVectors.map((v) => [v.name, v] as const))(
      'default read path: %s is returned as its map (expected failure, WIRE-20)',
      async (_name, vector) => {
        const stored = bs.pack(hexToBytes(vector.payload_hex));
        expectUnrevived(await readValue(createCache(storedReadConfig(stored))), vector);
      }
    );

    it.each(temporalSentinelVectors.map((v) => [v.name, v] as const))(
      'interop reader: %s',
      (_name, vector) => {
        const value = decodeInteropValue(hexToBytes(vector.payload_hex));
        if (vector.revives_to.type === 'datetime') return expectRevived(value, vector);
        expectUnrevived(value, vector);
      }
    );

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
    const declared = (bytes: Uint8Array) => {
      const header = readEnvelopeHeader(bytes);
      return header === null || header === 'slots-overclaim' ? null : header.declaredSize;
    };

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
        if (header === null || header === 'slots-overclaim') {
          throw new Error(`no header read from a fresh pack of ${size} B: ${header}`);
        }
        expect(header.declaredSize).toBe(size);
        // envelopeVerdict refuses anything past lz4_flex's worst case; the
        // real writer must stay inside it, even on incompressible input.
        expect(header.compressedLength).toBeGreaterThan(0);
        expect(header.compressedLength).toBeLessThanOrEqual(20 + Math.floor((size * 110) / 100));
      }
    });

    it('refuses every truncation, and returns null for trailing bytes', () => {
      // A truncation is null or, once its headers over-claim, 'slots-overclaim'.
      const packed = bs.pack(new TextEncoder().encode('truncation walk'));
      for (let len = 0; len < packed.length; len++) {
        expect([null, 'slots-overclaim']).toContain(readEnvelopeHeader(packed.subarray(0, len)));
      }
      expect(declared(packed)).toBe(15);
      const padded = new Uint8Array(packed.length + 1);
      padded.set(packed);
      expect(readEnvelopeHeader(padded)).toBeNull();
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
        [0x94, 0xc6, 0, 0, 0, 4, 0, 0, 0], // bin32 length runs past the end, within the slot sum
        [0x94, 0x91, 0xcd, 0x01, 0x00, 0x98, 0, 0, 0, 0, 0, 0, 0, 0, 0x00], // legacy byte > 0xff
      ];
      for (const bytes of cases) {
        expect(readEnvelopeHeader(new Uint8Array(bytes))).toBeNull();
      }
    });

    it("returns 'slots-overclaim' at the first header that takes the slot sum past the input length minus one", () => {
      const overclaim = rejectVectors.find((v) => v.name === 'reject_envelope_slots_overclaim')!;
      const bytes = hexToBytes(overclaim.envelope_hex);
      expect(bytes.length).toBe(42);
      expect(readEnvelopeHeader(bytes)).toBe('slots-overclaim'); // 4 + 38 > 41, at the bin8
      // One more byte backs the 42 slots, so the walk passes the bin8 and refuses
      // element 1's type instead.
      const backed = new Uint8Array(43);
      backed.set(bytes);
      expect(readEnvelopeHeader(backed)).toBeNull();

      const cases: number[][] = [
        [0x94, 0xc4, 0x00], // outer: 4 > 2
        [0x94, 0xc4, 0x05, 0, 0, 0], // bin8: 9 > 5
        [0x94, 0xdc, 0xff, 0xff, 0x00], // legacy array16: 65539 > 4
        [0x94, 0xc4, 0x00, 0x98, 0, 0, 0, 0, 0], // checksum: 12 > 8
        [0x94, 0xc4, 0x00, 0x98, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0xdb, 0, 0, 0xff, 0xff], // format str32: 65547 > 17
      ];
      for (const c of cases) {
        expect(readEnvelopeHeader(new Uint8Array(c))).toBe('slots-overclaim');
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

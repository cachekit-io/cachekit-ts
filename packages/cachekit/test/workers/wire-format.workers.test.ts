/**
 * Wire Format (ByteStorage envelope) — Workers lane (LAB-595)
 *
 * Verifies the wasm-backed ByteStorage against
 * protocol/test-vectors/wire-format.json (vendored in ./fixtures/ and
 * sha256-pinned by the Node lane, test/protocol/wire-format.protocol.test.ts):
 * decodes every ground-truth envelope and the constructed 32-bit ratio-wrap
 * envelope, round-trips, validates, rejects corruption, and refuses every
 * reject vector on the envelope read path — inside real workerd, on the
 * wasm32 build.
 */

import { describe, it, expect } from 'vitest';
import { decode } from '@msgpack/msgpack';
import { createCache } from '../../src/workers/index.js';
import { ByteStorage } from '../../src/workers/runtime.js';
import {
  REJECT_EXPECTATIONS,
  binVectors,
  bytesToHex,
  compressedData,
  construct,
  constructedVectors,
  expectRejectedOnRead,
  expectedBinMarker,
  firstMismatch,
  hexToBytes,
  legacyVectors,
  rejectReadConfig,
  rejectVectors,
  vectors,
} from '../fixtures/wire-vectors.js';

describe('wire-format vectors (wasm ByteStorage)', () => {
  const storage = new ByteStorage();

  it.each(vectors.map((v) => [v.name, v] as const))(
    'unpacks ground-truth envelope %s',
    (_name, vector) => {
      const unpacked = storage.unpack(hexToBytes(vector.envelope_hex));
      expect(bytesToHex(unpacked)).toBe(vector.input_hex);
    }
  );

  it.each(vectors.map((v) => [v.name, v] as const))(
    'validates ground-truth envelope %s',
    (_name, vector) => {
      expect(storage.validate(hexToBytes(vector.envelope_hex))).toBe(true);
    }
  );

  it.each(vectors.map((v) => [v.name, v] as const))(
    'round-trips vector input %s through pack/unpack',
    (_name, vector) => {
      const input = hexToBytes(vector.input_hex);
      expect(storage.unpack(storage.pack(input))).toEqual(input);
    }
  );

  // Protocol 1.1 (core 0.4.0): fresh packs emit compressed_data as msgpack
  // bin. Byte-equality against the *_bin ground-truth vectors proves both the
  // bin emit and byte-identity with every other SDK (the NAPI lane asserts
  // the same vectors).
  it.each(binVectors.map((v) => [v.name, v] as const))(
    'pack emits the protocol 1.1 bin envelope byte-for-byte (%s)',
    (_name, vector) => {
      const packed = storage.pack(hexToBytes(vector.input_hex));
      expect(bytesToHex(packed)).toBe(vector.envelope_hex);
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
      const packed = storage.pack(payload);
      expect(packed[0]).toBe(0x94); // fixarray(4) envelope
      expect(packed[1]).toBe(marker);
      expect(packed[1]).toBe(expectedBinMarker(compressedData(packed).length));
      expect(storage.unpack(packed)).toEqual(payload);
    }
  });

  // Permanent legacy read (protocol 1.1 dual-read): pre-0.4.0 array-of-
  // integers envelopes must keep decoding forever.
  it('decodes every legacy (pre-bin) envelope', () => {
    expect(legacyVectors.length).toBeGreaterThan(0);
    for (const vector of legacyVectors) {
      expect(bytesToHex(storage.unpack(hexToBytes(vector.envelope_hex)))).toBe(vector.input_hex);
    }
  });

  it('carries the 32-bit ratio-wrap constructed vector', () => {
    expect(constructedVectors.map((v) => v.name)).toEqual(['envelope_ratio_product_wraps_32_bits']);
  });

  // The wasm32 target this lane exists for: compressed_data is the first
  // length at which 1000 * compressed_size overflows 32 bits, so a reader that
  // multiplies in 32-bit (or pointer) width rejects this envelope as a ratio
  // bomb. A pass on a 64-bit host proves nothing about wasm32.
  it.each(constructedVectors.map((v) => [v.name, v] as const))(
    'unpacks constructed envelope %s to its constructed input',
    (_name, vector) => {
      const envelope = construct(vector.envelope_construction);
      const input = construct(vector.input_construction);
      expect(envelope.length).toBe(vector.envelope_size);
      expect(input.length).toBe(vector.original_size);
      expect(compressedData(envelope).length).toBe(vector.compressed_size);
      expect(firstMismatch(storage.unpack(envelope), input)).toBe(-1);
    }
  );

  it('carries the six reject vectors', () => {
    expect(rejectVectors.map((v) => v.name)).toEqual(Object.keys(REJECT_EXPECTATIONS));
  });

  // Through the Workers entry's compression-on read, as a stored entry: the
  // header checks in envelopeVerdict, then the wasm unpack.
  it.each(rejectVectors.map((v) => [v.name, v] as const))(
    'refuses reject vector %s on the envelope read path with the error the spec names',
    async (name, vector) => {
      const cache = createCache(rejectReadConfig(hexToBytes(vector.envelope_hex)));
      await expectRejectedOnRead(cache, name);
    }
  );

  it('rejects corrupted envelopes', () => {
    const packed = storage.pack(new TextEncoder().encode('integrity check payload'));
    const corrupted = packed.slice();
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    expect(() => storage.unpack(corrupted)).toThrow();
    expect(storage.validate(corrupted)).toBe(false);
  });

  it('round-trips large compressible data', () => {
    const data = new TextEncoder().encode('abcdefgh'.repeat(10000));
    const packed = storage.pack(data);
    expect(packed.length).toBeLessThan(data.length);
    expect(storage.unpack(packed)).toEqual(data);
  });
});

// The vendored vectors stop at 1 KB, but xxh3 runs its scramble step only on
// longer inputs, and under simd128 that step is xxhash-rust's hand-written
// wasm SIMD path (LAB-7083). Pin it to an independent xxh3 (python-xxhash,
// C reference): a same-build round-trip cannot catch a wrong checksum.
describe('xxh3 checksum above 1 KB (independent reference)', () => {
  it('4 KB envelope carries the reference xxh3_64 digest', () => {
    const data = Uint8Array.from({ length: 4096 }, (_, i) => (i * 131 + (i >> 7)) & 0xff);
    const [, checksum] = decode(new ByteStorage().pack(data)) as [unknown, ArrayLike<number>];
    expect(bytesToHex(Uint8Array.from(checksum))).toBe('b1d101cdbe66c94d'); // pragma: allowlist secret
  });
});

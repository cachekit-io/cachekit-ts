/**
 * Wire Format (ByteStorage envelope) — Workers lane (LAB-595)
 *
 * Verifies the wasm-backed ByteStorage against
 * protocol/test-vectors/wire-format.json (vendored in ./fixtures/ — re-copy
 * from the protocol repo on spec change): decodes every ground-truth
 * envelope, round-trips, validates, and rejects corruption — inside real
 * workerd.
 */

import { describe, it, expect } from 'vitest';
import { ByteStorage } from '../../src/workers/runtime.js';
import fixture from './fixtures/wire-format.json';

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

// msgpack bin format markers: bin8 / bin16 / bin32. The envelope is a
// 4-element fixarray (0x94), so byte 1 is the first byte of compressed_data.
const MSGPACK_BIN_MARKERS = [0xc4, 0xc5, 0xc6];

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
    // Not in the vector set: one bin8-sized and one bin16-sized payload.
    const small = new TextEncoder().encode('fresh bin-emit check');
    const large = new Uint8Array(1000);
    for (let i = 0; i < large.length; i++) large[i] = (i * 131 + 17) & 0xff; // incompressible
    for (const payload of [small, large]) {
      const packed = storage.pack(payload);
      expect(packed[0]).toBe(0x94); // fixarray(4) envelope
      expect(MSGPACK_BIN_MARKERS).toContain(packed[1]);
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

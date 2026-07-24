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
}

const vectors = fixture.vectors as WireVector[];

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

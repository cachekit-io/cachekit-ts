import { describe, it, expect } from 'vitest';
import { ByteStorage } from '@cachekit-io/cachekit-core-ts';
import { envelopeVerdict, looksLikeEnvelope } from './envelope.js';
import { ValueTooLargeError } from '../errors.js';
import { forgedEnvelope } from '../../test/fixtures/forged-envelope.js';

const MiB = 1024 * 1024;
const MAX = 10 * MiB;

describe('looksLikeEnvelope', () => {
  // Only fixarray(4): which [0] encodings count is readEnvelopeHeader's call.
  it('accepts fixarray(4) followed by any second byte', () => {
    for (let marker = 0; marker <= 0xff; marker++) {
      expect(looksLikeEnvelope(new Uint8Array([0x94, marker, 0x00]))).toBe(true);
    }
  });

  it('rejects inputs of 2 bytes or fewer, and any first byte but fixarray(4)', () => {
    expect(looksLikeEnvelope(new Uint8Array([]))).toBe(false);
    expect(looksLikeEnvelope(new Uint8Array([0x94]))).toBe(false);
    expect(looksLikeEnvelope(new Uint8Array([0x94, 0x9e]))).toBe(false);
    for (const first of [0x93, 0x95, 0xdc, 0x84]) {
      expect(looksLikeEnvelope(new Uint8Array([first, 0x9e, 0x00]))).toBe(false);
      expect(looksLikeEnvelope(new Uint8Array([first, 0xc4, 0x00]))).toBe(false);
    }
  });
});

describe('envelopeVerdict', () => {
  const bs = new ByteStorage();

  it('admits real envelopes up to the ceiling', () => {
    for (const size of [0, 1, 4096, MAX]) {
      expect(envelopeVerdict(bs.pack(new Uint8Array(size)), MAX)).toBe('unpack');
    }
  });

  it('throws for an envelope core would allocate for that declares more than the ceiling', () => {
    expect(() => envelopeVerdict(forgedEnvelope(MAX + 1), MAX)).toThrow(ValueTooLargeError);
    expect(envelopeVerdict(forgedEnvelope(MAX + 1), MAX + 1)).toBe('unpack');
  });

  it('names each check core would reject on before allocating the output', () => {
    // Plain user values can take these shapes; throwing would make them
    // unreadable on a compression-off cache for no protection.
    expect(envelopeVerdict(forgedEnvelope(12_000_000, 3), MAX)).toBe('over-ratio'); // > 1000:1
    expect(envelopeVerdict(forgedEnvelope(600 * MiB, 700_000), MAX)).toBe('over-size-cap'); // > 512 MiB
    expect(envelopeVerdict(forgedEnvelope(0, 0), MAX)).toBe('zero-length'); // empty payload
  });

  it('checks the size cap, then zero length, then the ratio (Retrieve Flow order)', () => {
    // Each forged envelope also fails every later check.
    expect(envelopeVerdict(forgedEnvelope(512 * MiB + 1, 0), MAX)).toBe('over-size-cap');
    expect(envelopeVerdict(forgedEnvelope(5, 0), MAX)).toBe('zero-length');
    // Exactly 1000:1 and exactly 512 MiB are inside core's caps.
    expect(envelopeVerdict(forgedEnvelope(1_000_000, 1000), MAX)).toBe('unpack');
    expect(envelopeVerdict(forgedEnvelope(1_000_001, 1000), MAX)).toBe('over-ratio');
    expect(() => envelopeVerdict(forgedEnvelope(512 * MiB), MAX)).toThrow(ValueTooLargeError);
  });

  it("is 'not-envelope' when the compressed payload exceeds lz4's worst case for the declared size", () => {
    // A small declared size must not smuggle a large payload into unpack's copy.
    expect(envelopeVerdict(forgedEnvelope(1, 21), MAX)).toBe('unpack');
    expect(envelopeVerdict(forgedEnvelope(1, 22), MAX)).toBe('not-envelope');
    expect(envelopeVerdict(forgedEnvelope(1, 4 * MiB), MAX)).toBe('not-envelope');
  });

  it('throws for input too long to be an envelope within the ceiling', () => {
    const max = 1000;
    const limit = 2 * (20 + 1100) + 256;
    expect(() => envelopeVerdict(new Uint8Array(limit + 1), max)).toThrow(ValueTooLargeError);
    expect(envelopeVerdict(new Uint8Array(limit), max)).toBe('not-envelope');
  });

  it("is 'not-envelope' for bytes that are not an envelope at all", () => {
    expect(envelopeVerdict(new Uint8Array([0x81, 0xa1, 0x61, 0x01]), MAX)).toBe('not-envelope');
  });

  it("is 'slots-overclaim' when the length headers declare more slots than the input can back", () => {
    // [fixarray(4), bin8(38)] then 39 bytes (38 bin + element 1): 42 slots in 42 bytes (WIRE-9).
    const bytes = new Uint8Array([0x94, 0xc4, 38, ...new Uint8Array(39)]);
    expect(envelopeVerdict(bytes, MAX)).toBe('slots-overclaim');
    // Any outer header but a 4-element array stays 'not-envelope', however much it declares.
    expect(envelopeVerdict(new Uint8Array([0xdc, 0xff, 0xff]), MAX)).toBe('not-envelope');
    expect(envelopeVerdict(new Uint8Array([0x93, 0xc4, 0xff]), MAX)).toBe('not-envelope');
  });
});

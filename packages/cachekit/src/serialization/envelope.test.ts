import { describe, it, expect } from 'vitest';
import { ByteStorage } from '@cachekit-io/cachekit-core-ts';
import { envelopeVerdict } from './envelope.js';
import { ValueTooLargeError } from '../errors.js';
import { forgedEnvelope } from '../../test/fixtures/forged-envelope.js';

const MiB = 1024 * 1024;
const MAX = 10 * MiB;

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

  it("is 'not-envelope' where core would reject before allocating the output", () => {
    // Plain user values can take this shape; throwing would make them
    // unreadable on a compression-off cache for no protection.
    expect(envelopeVerdict(forgedEnvelope(12_000_000, 3), MAX)).toBe('not-envelope'); // > 1000:1
    expect(envelopeVerdict(forgedEnvelope(600 * MiB, 700_000), MAX)).toBe('not-envelope'); // > 512 MiB
    expect(envelopeVerdict(forgedEnvelope(0, 0), MAX)).toBe('not-envelope'); // empty payload
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
});

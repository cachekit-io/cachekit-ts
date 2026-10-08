/**
 * The vendored protocol/test-vectors/wire-format.json, typed, plus the byte
 * helpers both wire-format lanes use: the NAPI lane
 * (test/protocol/wire-format.protocol.test.ts, which sha256-pins the file) and
 * the Workers lane (test/workers/wire-format.workers.test.ts). Plain TS with no
 * node:* imports, so workerd can load it.
 */

import { expect } from 'vitest';
import { decode } from '@msgpack/msgpack';
import type { Backend } from '../../src/backends/types.js';
import fixture from '../workers/fixtures/wire-format.json' with { type: 'json' };

export { fixture };

export interface WireVector {
  name: string;
  description: string;
  input_hex: string;
  envelope_hex: string;
  format: string;
  /** "bin" on protocol 1.1 vectors; absent on legacy array-of-integers vectors. */
  envelope_encoding?: string;
}

interface Segment {
  hex: string;
  count: number;
}

/** Too large to pin as hex: bytes are given as repeated-segment lists. */
export interface ConstructedVector {
  name: string;
  /** "bin", or "int-array" for a legacy array-of-integers envelope. */
  envelope_encoding: string;
  original_size: number;
  compressed_size: number;
  envelope_size: number;
  envelope_construction: Segment[];
  input_construction: Segment[];
}

/** An envelope with one Retrieve Flow check broken; every reader must refuse it. */
export interface RejectVector {
  name: string;
  description: string;
  reject_step: number;
  envelope_hex: string;
  original_size: number;
  compressed_size: number;
}

/**
 * An envelope every Retrieve Flow check accepts, whose payload is a
 * decode-bounds.json reject document: the payload decode must refuse it.
 */
export interface PayloadRejectVector {
  name: string;
  derived_from: string;
  envelope_hex: string;
  input_hex: string;
}

/** A temporal sentinel map as an auto-mode payload, and what it revives to. */
export interface TemporalSentinelVector {
  name: string;
  payload_hex: string;
  revives_to: { type: 'datetime' | 'date' | 'time'; iso: string };
}

// Annotated, not cast: `pnpm type-check:tests` then checks every entry of the
// JSON import against the interface, where a cast lets a short entry through.
export const vectors: WireVector[] = fixture.vectors;
export const binVectors = vectors.filter((v) => v.envelope_encoding === 'bin');
export const legacyVectors = vectors.filter((v) => v.envelope_encoding === undefined);
export const constructedVectors: ConstructedVector[] = fixture.constructed_vectors;
export const rejectVectors: RejectVector[] = fixture.reject_vectors;
export const payloadRejectVectors: PayloadRejectVector[] = fixture.payload_reject_vectors;
export const temporalSentinelVectors =
  fixture.temporal_sentinel_vectors as TemporalSentinelVector[];

/**
 * What reading each reject vector through the SDK's envelope read path must
 * raise: the "An SDK test asserts" column of the Reject vectors table in the
 * protocol's spec/wire-format.md. `never` is set where the table rules an
 * error out. The keys are the vector set both lanes pin.
 *
 * The SDK's typed decode is readEnvelopeHeader: a shape no conforming writer
 * emits (wrong arity, a checksum of other than 8 bytes, a legacy element over
 * 255, a uint64 size) is "not an envelope core would accept", refused before
 * unpack.
 *
 * `gap` marks a vector whose named error the SDK does not raise yet: the read
 * must still refuse it with `gap.raises`, and the spec's assertion is held as
 * an expected failure naming `gap.rule` (see expectedFailure).
 *
 * The allocation bound the table also asks of the size-cap and ratio vectors
 * is not asserted here: like cachekit-py, this SDK asserts it once core's
 * allocation probe runs on the core version it pins.
 */
export const REJECT_EXPECTATIONS: Record<
  string,
  { raises: RegExp; never?: RegExp; gap?: { rule: string; raises: RegExp } }
> = {
  reject_original_size_over_cap: { raises: /size cap/ },
  // A uint64 original_size is a shape no conforming writer emits, so the
  // header read refuses it: the table's "step-2 error from a range-checked
  // decode into a narrower type".
  reject_original_size_wraps_u32: {
    raises: /not an envelope core would accept/,
    never: /size validation|integrity/,
  },
  reject_zero_length_compressed_data: { raises: /zero-length compressed_data/ },
  reject_ratio_bomb: { raises: /compression ratio cap/ },
  // Core's length check (SizeValidation), not its checksum check.
  reject_decompressed_length_mismatch: { raises: /size validation failed/, never: /integrity/ },
  reject_checksum_mismatch: { raises: /integrity check failed/ },
  reject_envelope_arity_5: { raises: /not an envelope core would accept/ },
  reject_envelope_arity_3: { raises: /not an envelope core would accept/ },
  reject_checksum_nine_elements: { raises: /not an envelope core would accept/ },
  reject_checksum_seven_elements: { raises: /not an envelope core would accept/ },
  reject_legacy_element_above_255: { raises: /not an envelope core would accept/ },
  // The table asks for the pre-scan's own error. readEnvelopeHeader checks
  // each header against the bytes after it, so it takes the 38-byte bin and
  // then refuses element 1 as the wrong type: still before unpack, but a
  // type error, not the slot-sum error WIRE-9 names. Core never sees these
  // bytes, so moving to a core release with an envelope pre-scan does not
  // change this; only a slot-sum check in readEnvelopeHeader does.
  reject_envelope_slots_overclaim: {
    raises: /pre-scan/,
    gap: { rule: 'WIRE-9', raises: /not an envelope core would accept/ },
  },
  reject_original_size_sign_bit: {
    raises: /not an envelope core would accept/,
    never: /size validation|integrity|alloc/,
  },
  reject_ratio_float32_rounds: { raises: /compression ratio cap/ },
};

/**
 * The spec's assertion for a known gap: it must FAIL today. When it starts to
 * pass, the gap has closed, and this fails until the call becomes a plain
 * assertion and protocol's sdk-feature-matrix.md records the fix.
 */
export function expectedFailure(rule: string, assertion: () => void): void {
  expect(
    assertion,
    `${rule} now holds: make this a plain assertion and update sdk-feature-matrix.md`
  ).toThrow();
}

/**
 * Config for a compression-on cache whose backend returns `stored` for every
 * key (an entry another writer left), with nothing absorbing the read's error.
 */
export function storedReadConfig(stored: Uint8Array) {
  const backend: Backend = {
    get: async () => stored,
    set: async () => {},
    delete: async () => false,
    exists: async () => true,
    close: async () => {},
  };
  return {
    backend,
    l1: { enabled: false },
    reliability: { degradation: false, retry: { maxAttempts: 1 } },
  };
}

/**
 * Reads `cache` (built from storedReadConfig), which must refuse the entry,
 * and returns the error. Closes the cache.
 */
export async function readRejection(cache: {
  get(key: string): Promise<unknown>;
  close(): Promise<void>;
}): Promise<Error> {
  const error = await cache.get('wire:reject').then(
    () => new Error('read accepted the vector'),
    (e: unknown) => e
  );
  await cache.close();
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toBe('read accepted the vector');
  return error as Error;
}

/** Reads `cache` (built from storedReadConfig) and returns the value. Closes the cache. */
export async function readValue(cache: {
  get(key: string): Promise<unknown>;
  close(): Promise<void>;
}): Promise<unknown> {
  try {
    return await cache.get('wire:value');
  } finally {
    await cache.close();
  }
}

/** The error REJECT_EXPECTATIONS names for reject vector `name`. */
export function expectSpecError(error: Error, name: string): void {
  const { raises, never } = REJECT_EXPECTATIONS[name];
  expect(error.message).toMatch(raises);
  if (never) expect(error.message).not.toMatch(never);
}

/**
 * What the spec asks of each temporal sentinel: revival to the SDK's temporal
 * type, never the raw map. JavaScript has a datetime type (Date) only, so for
 * a date or a time this asserts just "not the map".
 */
export function expectRevived(value: unknown, vector: TemporalSentinelVector): void {
  const { type, iso } = vector.revives_to;
  if (type === 'datetime') {
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).getTime()).toBe(Date.parse(iso));
    return;
  }
  expect(value).not.toEqual({ [`__${type}__`]: true, value: iso });
}

// The envelope is a 4-element fixarray (0x94), so byte 1 is the msgpack
// marker of compressed_data. This returns the one marker a conforming
// (shortest-form) writer emits for that length — bin8 / bin16 / bin32 —
// derived, never a tolerated set, so a wider-than-needed header fails.
export function expectedBinMarker(compressedLength: number): number {
  if (compressedLength <= 0xff) return 0xc4;
  if (compressedLength <= 0xffff) return 0xc5;
  return 0xc6;
}

// Envelope element [0]. bin decodes to Uint8Array; a legacy array-of-integers
// envelope would decode to number[] and is rejected here.
export function compressedData(envelope: Uint8Array): Uint8Array {
  const [compressed] = decode(envelope) as unknown[];
  if (!(compressed instanceof Uint8Array)) throw new Error('compressed_data is not msgpack bin');
  return compressed;
}

// Length of a constructed envelope's element [0]: its bin bytes, or the
// element count of a legacy array of integers.
export function constructedDataLength(envelope: Uint8Array, encoding: string): number {
  if (encoding === 'bin') return compressedData(envelope).length;
  const [data] = decode(envelope) as [unknown[]];
  return data.length;
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// The fixture's construction_note: repeat each segment's hex `count` times and
// concatenate the segments in order.
export function construct(segments: Segment[]): Uint8Array {
  const units = segments.map((s) => [hexToBytes(s.hex), s.count] as const);
  const out = new Uint8Array(units.reduce((n, [unit, count]) => n + unit.length * count, 0));
  let offset = 0;
  for (const [unit, count] of units) {
    for (let i = 0; i < count; i++, offset += unit.length) out.set(unit, offset);
  }
  return out;
}

// Index of the first differing byte, or -1. A multi-MB toEqual diff is
// unreadable; this names where the output went wrong.
export function firstMismatch(actual: Uint8Array, expected: Uint8Array): number {
  const n = Math.min(actual.length, expected.length);
  for (let i = 0; i < n; i++) if (actual[i] !== expected[i]) return i;
  return actual.length === expected.length ? -1 : n;
}

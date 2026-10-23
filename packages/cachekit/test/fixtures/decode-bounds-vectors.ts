/**
 * The vendored protocol/test-vectors/decode-bounds.json, typed, plus the
 * envelope pre-scan assertions both ByteStorage lanes use: the NAPI lane
 * (test/protocol/decode-bounds.protocol.test.ts, which sha256-pins the file)
 * and the Workers lane (test/workers/decode-bounds.workers.test.ts). Plain TS
 * with no node:* imports, so workerd can load it.
 */

import { expect } from 'vitest';
import fixture from '../protocol/fixtures/decode-bounds.json' with { type: 'json' };
import { construct } from './wire-vectors.js';

export interface Vector {
  name: string;
  construction: { repeat_hex: string; count: number; suffix_hex: string };
  input_hex: string;
  nesting_depth: number;
  declared_slots: number;
  reject_reasons?: string[];
}

interface VectorFile {
  spec: string;
  reject_vectors: Vector[];
  accept_vectors: Vector[];
}

// Annotated, not cast: `pnpm type-check:tests` then checks every entry of the
// JSON import against the interface, where a cast lets a short entry through.
export const vectors: VectorFile = fixture;

/** Bytes either side of a built input; see build(). */
const GUARD = 8;

/**
 * field_notes.construction: input = fromhex(repeat_hex) * count + fromhex(suffix_hex).
 *
 * Returned as a view at a non-zero offset into a larger buffer, as a pooled
 * Node Buffer or a network read arrives, with the reserved marker 0xc1 on both
 * sides: a decoder that ignores byteOffset, or reads past byteLength, sees
 * bytes that are not the input.
 */
export function build(v: Vector): Uint8Array {
  const input = construct([
    { hex: v.construction.repeat_hex, count: v.construction.count },
    { hex: v.construction.suffix_hex, count: 1 },
  ]);
  const padded = new Uint8Array(input.length + 2 * GUARD).fill(0xc1);
  padded.set(input, GUARD);
  return padded.subarray(GUARD, GUARD + input.length);
}

/**
 * How both `unpack` bindings surface a cachekit-core envelope decode failure:
 * `ByteStorageError::DeserializationFailed`'s display. A pre-scan rejection
 * then carries the pre-scan's own tag, then the reason.
 */
const DESERIALIZATION_FAILED = 'deserialization failed: ';
const PRE_SCAN_TAG = 'decode pre-scan: ';
const ENVELOPE_PRE_SCAN = `${DESERIALIZATION_FAILED}${PRE_SCAN_TAG}`;

/**
 * The error a reject vector must raise at `unpack`, matched from its start: a
 * typed-decode error can echo attacker bytes mid-message, so only a prefix
 * match is unforgeable.
 *
 * The prefix alone is not enough. The pre-scan's own end-of-input rejection
 * carries it too, so with the slot check deleted the overclaim-only vectors it
 * guards still fail with the prefix, once the walk runs out of input.
 * Depth-only and overclaim-only vectors therefore pin their rule's reason, as
 * cachekit-core's own tests/decode_bounds_vectors.rs does: overclaim-only ones
 * the byte or slot budget, depth-only ones (structurally complete, so nothing
 * else can reject them) the depth bound itself, which is cachekit-core's, not
 * this package's.
 */
function envelopeRejection(v: Vector): RegExp {
  switch (v.reject_reasons?.join()) {
    case 'depth':
      return new RegExp(`^${ENVELOPE_PRE_SCAN}nests deeper than 100 levels$`);
    case 'overclaim':
      return new RegExp(`^${ENVELOPE_PRE_SCAN}declares more `);
    default:
      // A vector that breaks several rules can trip any of them first. An
      // incomplete-only vector fits the spec's slot budget but not core's
      // stricter running one, so core rejects it there rather than at end of
      // input. Either is the pre-scan, so only the prefix is pinned.
      return new RegExp(`^${ENVELOPE_PRE_SCAN}`);
  }
}

export function expectEnvelopePreScanRejects(
  unpack: (bytes: Uint8Array) => unknown,
  v: Vector
): void {
  expect(() => unpack(build(v))).toThrow(envelopeRejection(v));
}

/**
 * An accept vector is not an envelope, so the typed decode after the pre-scan
 * refuses it, and that refusal is required: an error that is not core's
 * decode failure (a wasm trap, say) would otherwise pass for "past the
 * pre-scan" without showing the pre-scan ran to completion.
 */
export function expectEnvelopePreScanAccepts(
  unpack: (bytes: Uint8Array) => unknown,
  v: Vector
): void {
  expect(() => unpack(build(v))).toThrow(
    new RegExp(`^${DESERIALIZATION_FAILED}(?!${PRE_SCAN_TAG})`)
  );
}

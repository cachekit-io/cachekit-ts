/**
 * The vendored protocol/test-vectors/decode-bounds.json, typed, plus the
 * envelope pre-scan assertions both ByteStorage lanes use: the NAPI lane
 * (test/protocol/decode-bounds.protocol.test.ts, which sha256-pins the file)
 * and the Workers lane (test/workers/decode-bounds.workers.test.ts). Plain TS
 * with no node:* imports, so workerd can load it.
 */

import { expect } from 'vitest';
import fixture from '../protocol/fixtures/decode-bounds.json' with { type: 'json' };
import { assertFixture, table, type ObjectShape } from './fixture-shape.js';
import { hexToBytes } from './wire-vectors.js';

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

const VECTOR_SHAPE: ObjectShape = {
  name: 'string',
  construction: { repeat_hex: 'string', count: 'number', suffix_hex: 'string' },
  input_hex: 'string',
  nesting_depth: 'number',
  declared_slots: 'number',
  reject_reasons: [table('string'), 'undefined'],
};

function assertVectorFile(value: unknown): asserts value is VectorFile {
  assertFixture(
    value,
    { spec: 'string', reject_vectors: table(VECTOR_SHAPE), accept_vectors: table(VECTOR_SHAPE) },
    'decode-bounds.json'
  );
}

const parsed: unknown = fixture;
assertVectorFile(parsed);
export const vectors: VectorFile = parsed;

/** field_notes.construction: input = fromhex(repeat_hex) * count + fromhex(suffix_hex). */
export function build(v: Vector): Uint8Array {
  const unit = hexToBytes(v.construction.repeat_hex);
  const suffix = hexToBytes(v.construction.suffix_hex);
  const bytes = new Uint8Array(unit.length * v.construction.count + suffix.length);
  for (let i = 0; i < v.construction.count; i++) bytes.set(unit, i * unit.length);
  bytes.set(suffix, unit.length * v.construction.count);
  return bytes;
}

/**
 * How both `unpack` bindings surface a cachekit-core envelope pre-scan
 * rejection: `ByteStorageError::DeserializationFailed`'s display, then the
 * pre-scan's own tag, then the reason.
 */
const ENVELOPE_PRE_SCAN = 'deserialization failed: decode pre-scan: ';

/** cachekit-core's nesting bound for the envelope decode (not this package's). */
const ENVELOPE_MAX_DEPTH = 100;

/**
 * The error a reject vector must raise at `unpack`, matched from its start: a
 * typed-decode error can echo attacker bytes mid-message, so only a prefix
 * match is unforgeable.
 *
 * The prefix alone is not enough. The pre-scan's own end-of-input rejection
 * carries it too, so with the slot check deleted every overclaim-only vector
 * still fails with the prefix, once the walk runs out of input. Vectors that
 * break one rule alone therefore pin that rule's reason, as cachekit-core's
 * own tests/decode_bounds_vectors.rs does: overclaim-only ones the byte or slot
 * budget, depth-only ones (structurally complete, so nothing else can reject
 * them) the depth bound itself.
 */
function envelopeRejection(v: Vector): RegExp {
  switch (v.reject_reasons?.join()) {
    case 'depth':
      return new RegExp(`^${ENVELOPE_PRE_SCAN}nests deeper than ${ENVELOPE_MAX_DEPTH} levels$`);
    case 'overclaim':
      return new RegExp(`^${ENVELOPE_PRE_SCAN}declares more `);
    default:
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
 * may still refuse it; the pre-scan itself must not.
 */
export function expectEnvelopePreScanAccepts(
  unpack: (bytes: Uint8Array) => unknown,
  v: Vector
): void {
  let message = '';
  try {
    unpack(build(v));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).not.toContain('decode pre-scan: ');
}

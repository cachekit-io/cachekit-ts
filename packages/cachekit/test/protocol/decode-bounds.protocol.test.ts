/**
 * Decode Bounds Protocol Tests
 *
 * Executes protocol/test-vectors/decode-bounds.json (vendored in ./fixtures/,
 * sha256-pinned below) against every untrusted MessagePack decode site in this
 * package: the auto-mode serializer, the interop/v1 value decoder and the
 * invalidation-event decoder. Spec: protocol/spec/interop-mode.md#decode-bounds
 * (LAB-2503); the bounds themselves are `assertDecodeDepth` (LAB-2487). The
 * ByteStorage envelope is decoded in Rust (cachekit-core, reached via NAPI /
 * wasm) and is verified against the same vectors there, not here (LAB-3479).
 *
 * Provenance: cachekit-io/protocol#59 @ b75adac4. Re-vendor: copy
 * test-vectors/decode-bounds.json byte-for-byte from protocol main (the
 * fixtures dir is prettier-ignored and CRLF-proofed for exactly this reason)
 * and update FIXTURE_SHA256 + the counts in the first test.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { MessagePackSerializer } from '../../src/serialization/serializer.js';
import { decodeInteropValue } from '../../src/serialization/interop.js';
import { deserializeEvent } from '../../src/invalidation/event.js';
import { MAX_INVALIDATION_EVENT_DEPTH } from '../../src/constants.js';
import { SerializationError } from '../../src/errors.js';

/** sha256 of test-vectors/decode-bounds.json at the provenance above. */
const FIXTURE_SHA256 = '75c1204e6f58f5220581d3e40e75a68f2df605b4e3c817107b0c690cd7da5cd4'; // pragma: allowlist secret

interface Vector {
  name: string;
  construction: { repeat_hex: string; count: number; suffix_hex: string };
  input_hex: string;
  nesting_depth: number;
}

interface VectorFile {
  spec: string;
  reject_vectors: Vector[];
  accept_vectors: Vector[];
}

const raw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'decode-bounds.json')
);
const vectors = JSON.parse(raw.toString('utf8')) as VectorFile;

/** field_notes.construction: input = fromhex(repeat_hex) * count + fromhex(suffix_hex). */
function build(v: Vector): Buffer {
  const unit = Buffer.from(v.construction.repeat_hex, 'hex');
  return Buffer.concat([
    Buffer.alloc(unit.length * v.construction.count, unit),
    Buffer.from(v.construction.suffix_hex, 'hex'),
  ]);
}

const serializer = new MessagePackSerializer();

/**
 * The error class alone is a false green: with the pre-scan deleted, the
 * decoder still throws (wrapped as SerializationError) when it runs out of
 * input — after allocating ~33 MB for nested_array16_depth_2048, the exact
 * amplification LAB-2487 closed. Only assertDecodeDepth's message proves the
 * rejection happened before any allocation.
 */
const PRE_SCAN = /\(decode pre-scan\)$/;

/** Every untrusted decode entry point, with the message its rejection must carry. */
const sites: [string, (bytes: Uint8Array) => unknown, RegExp][] = [
  ['MessagePackSerializer.decode', (b) => serializer.decode(b), PRE_SCAN],
  ['decodeInteropValue', (b) => decodeInteropValue(b), PRE_SCAN],
  // Events are size-capped ahead of the pre-scan, so the 5–6 KB vectors are
  // rejected there instead — earlier still, and equally allocation-free.
  [
    'deserializeEvent',
    (b) => deserializeEvent(b),
    /^Invalidation event size \d+ exceeds max|\(decode pre-scan\)$/,
  ],
];

describe('Protocol decode-bounds vectors (spec/interop-mode.md#decode-bounds)', () => {
  it('fixture is the pinned upstream file, unedited', () => {
    expect(
      createHash('sha256').update(raw).digest('hex'),
      'fixture differs from the pinned protocol revision; if intentional, refresh FIXTURE_SHA256 AND the counts'
    ).toBe(FIXTURE_SHA256);
    expect(vectors.spec).toBe('spec/interop-mode.md#decode-bounds');
    expect(vectors.reject_vectors).toHaveLength(13);
    expect(vectors.accept_vectors).toHaveLength(2);
  });

  it('every construction reproduces its input_hex', () => {
    for (const v of [...vectors.reject_vectors, ...vectors.accept_vectors]) {
      expect(build(v).toString('hex'), v.name).toBe(v.input_hex);
    }
  });

  describe.each(sites)('%s', (_site, decode, rejection) => {
    it.each(vectors.reject_vectors)('rejects $name from the pre-scan', (v) => {
      const run = (): unknown => decode(build(v));
      expect(run).toThrow(SerializationError);
      expect(run).toThrow(rejection);
    });
  });

  describe('accept vectors', () => {
    it.each(vectors.accept_vectors)('MessagePackSerializer.decode accepts $name', (v) => {
      expect(() => serializer.decode(build(v))).not.toThrow();
    });

    it.each(vectors.accept_vectors)('decodeInteropValue accepts $name', (v) => {
      expect(() => decodeInteropValue(build(v))).not.toThrow();
    });

    /**
     * An invalidation event is a flat map of scalars, so deserializeEvent's
     * depth cap (MAX_INVALIDATION_EVENT_DEPTH) is tighter than the spec's >= 32
     * floor for general values: an accept vector nested deeper than that MUST be
     * rejected there — fail-closed, SerializationError, never an abort. A
     * shallower one is still not a valid event, so it may decode to a garbage
     * event or be rejected — again only with SerializationError.
     */
    it.each(vectors.accept_vectors)(
      'deserializeEvent on $name (depth $nesting_depth) decodes or fails closed',
      (v) => {
        const run = (): unknown => deserializeEvent(build(v));
        if (v.nesting_depth > MAX_INVALIDATION_EVENT_DEPTH) {
          expect(run).toThrow(SerializationError);
          return;
        }
        try {
          run();
        } catch (e) {
          expect(e).toBeInstanceOf(SerializationError);
        }
      }
    );
  });
});

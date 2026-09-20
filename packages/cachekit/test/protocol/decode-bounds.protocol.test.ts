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
 * Provenance: cachekit-io/protocol#59 @ b75adac4 (the revision that last
 * touched the fixture). The same sha256 is pinned by cachekit-py's
 * tests/unit/protocol/test_decode_bounds.py, so a drift between the two SDKs
 * shows up as a hash mismatch on whichever re-vendors second.
 *
 * Re-vendor: copy test-vectors/decode-bounds.json byte-for-byte from the
 * protocol revision you then name in `Provenance` above (the fixtures dir is
 * prettier-ignored, pre-commit-ignored and CRLF-proofed for exactly this
 * reason), then update all four coupled edits: the Provenance line,
 * FIXTURE_SHA256, the counts in the first test, and EXPECTED.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { MessagePackSerializer } from '../../src/serialization/serializer.js';
import { decodeInteropValue } from '../../src/serialization/interop.js';
import { deserializeEvent } from '../../src/invalidation/event.js';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_INVALIDATION_EVENT_SIZE,
  MAX_INVALIDATION_EVENT_DEPTH,
} from '../../src/constants.js';
import { SerializationError } from '../../src/errors.js';

/** sha256 of test-vectors/decode-bounds.json at the provenance above. */
const FIXTURE_SHA256 = '75c1204e6f58f5220581d3e40e75a68f2df605b4e3c817107b0c690cd7da5cd4'; // pragma: allowlist secret

interface Vector {
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

/** What each accept vector must decode to on the value paths (keyed by name; a
 * re-vendored accept vector fails the pin test until it is added here). */
const EXPECTED: Record<string, unknown> = {
  nested_fixarray_depth_32: Array.from({ length: 32 }).reduce<unknown>((inner) => [inner], null),
  array16_256_backed_nils: new Array<null>(256).fill(null),
};

interface Site {
  name: string;
  decode: (bytes: Uint8Array) => unknown;
  /** maxDepth this site passes to assertDecodeDepth. */
  maxDepth: number;
  /** Byte ceiling applied ahead of the pre-scan, if the site has one. */
  sizeCap?: number;
}

/** Every untrusted decode entry point in this package. */
const sites: Site[] = [
  {
    name: 'MessagePackSerializer.decode',
    decode: (b) => serializer.decode(b),
    maxDepth: DEFAULT_MAX_DEPTH,
  },
  { name: 'decodeInteropValue', decode: (b) => decodeInteropValue(b), maxDepth: DEFAULT_MAX_DEPTH },
  {
    name: 'deserializeEvent',
    decode: (b) => deserializeEvent(b),
    maxDepth: MAX_INVALIDATION_EVENT_DEPTH,
    sizeCap: DEFAULT_MAX_INVALIDATION_EVENT_SIZE,
  },
];

/**
 * The exact guard each vector must trip at each site — never an alternation.
 *
 * The error class alone is a false green: with the pre-scan deleted, the
 * decoder still throws (wrapped as SerializationError) when it runs out of
 * input — after allocating ~33 MB for nested_array16_depth_2048, the exact
 * amplification LAB-2487 closed. Only assertDecodeDepth's message proves the
 * rejection happened before any allocation.
 *
 * Naming the guard per vector rather than accepting "any pre-scan message"
 * matters just as much: most depth-tagged vectors over-claim too, so a blanket
 * regex stays green when the depth check alone is removed and the structural
 * walk catches them as truncated instead. Events are size-capped ahead of the
 * pre-scan, so the 5-6 KB vectors are rejected there — earlier still, and
 * equally allocation-free.
 */
function expectedRejection(v: Vector, site: Site): RegExp {
  const inputLen = v.input_hex.length / 2;
  if (site.sizeCap !== undefined && inputLen > site.sizeCap) {
    return new RegExp(`^Invalidation event size ${inputLen} exceeds max ${site.sizeCap}$`);
  }
  if (v.nesting_depth > site.maxDepth) {
    return new RegExp(`^Max depth of ${site.maxDepth} exceeded \\(decode pre-scan\\)$`);
  }
  return /^Truncated MessagePack at byte \d+ \(decode pre-scan\)$/;
}

describe('Protocol decode-bounds vectors (spec/interop-mode.md#decode-bounds)', () => {
  it('fixture is the pinned upstream file, unedited since vendoring', () => {
    expect(
      createHash('sha256').update(raw).digest('hex'),
      'fixture differs from the pinned protocol revision; if intentional, refresh FIXTURE_SHA256 AND the counts'
    ).toBe(FIXTURE_SHA256);
    expect(vectors.spec).toBe('spec/interop-mode.md#decode-bounds');
    expect(vectors.reject_vectors).toHaveLength(13);
    expect(vectors.accept_vectors).toHaveLength(2);
    expect(vectors.accept_vectors.map((v) => v.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  /**
   * The bounds the vector set cannot isolate on its own. rules.depth requires
   * the bound be >= 32 and <= 1024, but every depth-tagged vector nests >= 1100
   * and all but one also over-claim — so the ceiling is unreachable from the
   * vectors alone and a widened bound would otherwise stay green.
   */
  it('site bounds satisfy rules.depth and stay least-privilege', () => {
    expect(DEFAULT_MAX_DEPTH).toBeGreaterThanOrEqual(32);
    expect(DEFAULT_MAX_DEPTH).toBeLessThanOrEqual(1024);
    // Deliberately below the rules.depth floor of 32: an invalidation event is a
    // flat map of scalars, so depth 3 is least privilege, not a decode bug. The
    // fixture's `scope` still names invalidation events, so the deviation is
    // tracked as LAB-4032 rather than silently blessed here — pinned so
    // that changing it is a decision, not a side effect.
    expect(MAX_INVALIDATION_EVENT_DEPTH).toBe(3);
    expect(MAX_INVALIDATION_EVENT_DEPTH).toBeLessThanOrEqual(1024);
    expect(DEFAULT_MAX_INVALIDATION_EVENT_SIZE).toBe(4096);
  });

  it('every construction reproduces its input_hex', () => {
    for (const v of [...vectors.reject_vectors, ...vectors.accept_vectors]) {
      expect(build(v).toString('hex'), v.name).toBe(v.input_hex);
    }
  });

  /**
   * The fixture ships the metadata its own `rules` are stated in terms of. A
   * re-vendor that swaps a vector for a differently-shaped one keeps the counts
   * and the reproduced input_hex green, so check each vector still exhibits the
   * property its tag claims.
   */
  it('every reject vector exhibits the rule it is tagged with', () => {
    for (const v of vectors.reject_vectors) {
      const inputLen = v.input_hex.length / 2;
      const reasons = v.reject_reasons ?? [];
      expect(reasons.length, `${v.name}: missing reject reason`).toBeGreaterThan(0);
      for (const reason of reasons) {
        switch (reason) {
          case 'depth':
            expect(v.nesting_depth, v.name).toBeGreaterThan(1024);
            break;
          case 'overclaim':
            expect(v.declared_slots, v.name).toBeGreaterThan(inputLen - 1);
            break;
          default:
            throw new Error(`${v.name}: unknown reject reason ${String(reason)}`);
        }
      }
    }
    // The depth ceiling rests on the vectors that violate depth ALONE; if a
    // re-vendor drops them, every remaining depth vector is also caught by the
    // structural walk and the depth check stops being pinned at all.
    expect(
      vectors.reject_vectors.filter((v) => v.reject_reasons?.join() === 'depth'),
      'no depth-only reject vector left: the depth bound is no longer pinned'
    ).not.toHaveLength(0);
  });

  describe.each(sites.map((s) => [s.name, s] as const))('%s', (_name, site) => {
    it.each(vectors.reject_vectors)('rejects $name at its own guard', (v) => {
      const run = (): unknown => site.decode(build(v));
      expect(run).toThrow(SerializationError);
      expect(run).toThrow(expectedRejection(v, site));
    });
  });

  describe('accept vectors', () => {
    it.each(vectors.accept_vectors)('MessagePackSerializer.decode accepts $name', (v) => {
      expect(serializer.decode(build(v))).toEqual(EXPECTED[v.name]);
    });

    it.each(vectors.accept_vectors)('decodeInteropValue accepts $name', (v) => {
      expect(decodeInteropValue(build(v))).toEqual(EXPECTED[v.name]);
    });

    /**
     * An invalidation event is a flat map of scalars, so deserializeEvent's
     * depth cap is tighter than the spec's >= 32 floor for general values: an
     * accept vector nested deeper than that MUST be rejected there — fail-closed,
     * SerializationError, never an abort. A shallower one is not a valid event
     * either, but deserializeEvent has no shape check today (LAB-3477), so it
     * returns an all-undefined event rather than throwing. Assert whichever
     * actually happens; both are fail-closed, neither may abort.
     */
    it.each(vectors.accept_vectors)(
      'deserializeEvent on $name (depth $nesting_depth) rejects or returns an inert event',
      (v) => {
        const run = (): unknown => deserializeEvent(build(v));
        if (v.nesting_depth > MAX_INVALIDATION_EVENT_DEPTH) {
          expect(run).toThrow(SerializationError);
          expect(run).toThrow(expectedRejection(v, sites[2]));
          return;
        }
        expect(run).not.toThrow();
        expect(run()).toEqual({
          level: undefined,
          namespace: undefined,
          paramsHash: undefined,
          timestamp: undefined,
          sourceInstance: undefined,
        });
      }
    );
  });
});

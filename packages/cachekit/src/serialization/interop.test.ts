import { describe, it, expect } from 'vitest';
import {
  encodeInteropArgs,
  interopArgsHash,
  generateInteropKey,
  encodeInteropValue,
  decodeInteropValue,
  validateInteropSegment,
  INTEROP_SEGMENT_PATTERN,
  InteropFloat,
} from './interop.js';
import { ConfigurationError, SerializationError, ValueTooLargeError } from '../errors.js';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('interop segment validation', () => {
  it('accepts conforming segments', () => {
    for (const seg of ['users', 'get_user', 'a', '0', 'a.b-c_d', 'x'.repeat(64)]) {
      expect(() => validateInteropSegment('namespace', seg)).not.toThrow();
    }
  });

  it('rejects non-conforming segments with ConfigurationError', () => {
    for (const seg of ['', 'Users', 'get:user', 'users\n', '_x', '.x', 'x'.repeat(65), 'héllo']) {
      expect(() => validateInteropSegment('operation', seg)).toThrow(ConfigurationError);
    }
  });

  it('pattern is anchored full-string (trailing newline cannot pass)', () => {
    expect(INTEROP_SEGMENT_PATTERN.test('users\n')).toBe(false);
    expect(INTEROP_SEGMENT_PATTERN.multiline).toBe(false);
  });
});

describe('interop argument encoding (args profile)', () => {
  it('encodes number and BigInt forms of the same integer identically', () => {
    expect(hex(encodeInteropArgs([2n]))).toBe(hex(encodeInteropArgs([2])));
    expect(hex(encodeInteropArgs([2.0]))).toBe(hex(encodeInteropArgs([2n])));
  });

  it('rejects integral numbers beyond Number.isSafeInteger (BigInt required)', () => {
    // 2^53 is the first integer float64 cannot be trusted to carry exactly —
    // hashing it would silently key on the rounded neighbour of the intended
    // value (spec: "MUST error on a non-integral-safe Number").
    expect(() => encodeInteropArgs([2 ** 53])).toThrow(/BigInt/);
    expect(() => encodeInteropArgs([-(2 ** 60)])).toThrow(SerializationError);
    // The exact same integers pass as BigInt.
    expect(() => encodeInteropArgs([2n ** 53n])).not.toThrow();
  });

  it('InteropFloat declares float64 semantics: full collapse range, no safe gate', () => {
    // The inclusive lower collapse bound (float -2^63 -> int64-min) — same
    // bytes as the exact BigInt.
    expect(hex(encodeInteropArgs([new InteropFloat(-(2 ** 63))]))).toBe(
      hex(encodeInteropArgs([-9223372036854775808n]))
    );
    // At/above 2^64 there is no int ambiguity: bare numbers stay float64.
    expect(hex(encodeInteropArgs([2 ** 64]))).toBe(
      hex(encodeInteropArgs([new InteropFloat(2 ** 64)]))
    );
  });

  it('normalizes a Date argument exactly like the equivalent Unix float64', () => {
    // 2024-01-01T12:30:45.123Z -> 1704112245123 ms -> 1704112245.123
    const d = new Date('2024-01-01T12:30:45.123Z');
    expect(hex(encodeInteropArgs([d]))).toBe(hex(encodeInteropArgs([1704112245.123])));
  });

  it('floors pre-epoch Dates toward negative infinity (spec: DateTime determinism)', () => {
    const d = new Date(-877); // 1969-12-31T23:59:59.123Z
    expect(hex(encodeInteropArgs([d]))).toBe(hex(encodeInteropArgs([-0.877])));
  });

  it('rejects an Invalid Date', () => {
    expect(() => encodeInteropArgs([new Date('garbage')])).toThrow(SerializationError);
  });

  it('rejects undefined arguments (full declared arity is mandatory)', () => {
    expect(() => encodeInteropArgs([undefined])).toThrow(/declared arity/);
    expect(() => encodeInteropArgs([1, undefined, 3])).toThrow(SerializationError);
  });

  it('encodes a Map identically to the equivalent plain object', () => {
    const asObject = encodeInteropArgs([{ b: 2, a: 1 }]);
    const asMap = encodeInteropArgs([
      new Map<string, number>([
        ['b', 2],
        ['a', 1],
      ]),
    ]);
    expect(hex(asMap)).toBe(hex(asObject));
  });

  it('rejects non-string Map keys', () => {
    expect(() => encodeInteropArgs([new Map([[1, 'x']])])).toThrow(/keys must be strings/);
  });

  it('rejects class instances (closed data model)', () => {
    class User {
      id = 1;
    }
    expect(() => encodeInteropArgs([new User()])).toThrow(/not in the interop data model/);
  });

  it('dedupes Set elements that normalize to the same encoding (1n vs 1)', () => {
    // A JS Set holds both (1n !== 1), but they encode identically — the spec
    // dedupes by encoded bytes post-normalization.
    const s = new Set<unknown>([1n, 1]);
    expect(s.size).toBe(2);
    expect(hex(encodeInteropArgs([s]))).toBe(hex(encodeInteropArgs([new Set([1])])));
  });

  it('rejects cyclic arguments via the depth limit', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => encodeInteropArgs([cyclic])).toThrow(/max depth/);
  });

  it('rejects collections beyond the max collection size (DoS cap, symmetric with decode)', () => {
    expect(() => encodeInteropArgs([new Array(10001).fill(0)])).toThrow(ValueTooLargeError);
  });

  it('rejects oversized payloads during traversal, before materialising the full buffer', () => {
    // Two ~600 KiB strings cross the 1 MiB budget on the second chunk push.
    // The incremental pushChunk message (vs the post-concat backstop's
    // "Encoded interop args size N exceeds max") pins the fail-fast path.
    const big = 'x'.repeat(600 * 1024);
    expect(() => encodeInteropArgs([big, big])).toThrow(ValueTooLargeError);
    expect(() => encodeInteropArgs([big, big])).toThrow(/payload exceeds max size/);
  });

  it('keys never exceed 194 characters', () => {
    const key = generateInteropKey('n'.repeat(64), 'o'.repeat(64), [1]);
    expect(key.length).toBe(194);
    expect(key).toBe(`${'n'.repeat(64)}:${'o'.repeat(64)}:${interopArgsHash([1])}`);
  });
});

describe('interop Set encoding budgets (encodeCanonical, shared by both profiles)', () => {
  it('rejects a Set whose elements are collectively over budget during iteration', () => {
    // 32 × ~64 KiB elements: each far under the 1 MiB budget, ~2 MiB in
    // aggregate. Set element sub-encodes buffer into `encoded[]` before the
    // parent sink sees any bytes, so the running total must be threaded
    // across the loop — otherwise all 32 elements materialise before the
    // budget fires. Getter spies count how many elements were actually
    // encoded: each element encodes to 65,550 bytes, so the throw lands
    // during element 16 — mid-iteration, not after the loop.
    const total = 32;
    let encoded = 0;
    const elements = Array.from({ length: total }, (_, i) => ({
      get payload(): string {
        encoded++;
        return `${i}:`.padEnd(64 * 1024, 'x');
      },
    }));
    expect(() => encodeInteropValue(new Set(elements))).toThrow(ValueTooLargeError);
    expect(encoded).toBeLessThan(total);
  });

  it('accepts a duplicate-heavy Set whose deduped encoding fits the budget', () => {
    // 20 distinct-identity objects with identical canonical encodings: ~4 MiB
    // pre-dedupe, ~200 KiB deduped. Dedupe happens on insert, so duplicates
    // advance neither the byte budget nor the count — this must encode
    // byte-identically to the singleton, not throw at the pre-dedupe sum.
    const dup = (): { k: string } => ({ k: 'x'.repeat(200 * 1024) });
    const many = new Set(Array.from({ length: 20 }, dup));
    expect(many.size).toBe(20);
    expect(encodeInteropValue(many)).toEqual(encodeInteropValue(new Set([dup()])));
  });

  it('accepts a duplicate larger than half the budget (dedupe is confirmed before the aggregate charge)', () => {
    // Two distinct-identity copies of one ~700 KiB element: deduped output
    // ~700 KiB, comfortably under the 1 MiB budget. The duplicate's re-encode
    // must run against the parent base, not the advanced running total —
    // otherwise it crosses the budget mid-encode before dedupe can identify
    // it, falsely rejecting a Set whose canonical encoding fits.
    const dup = (): { k: string } => ({ k: 'y'.repeat(700 * 1024) });
    const pair = new Set([dup(), dup()]);
    expect(pair.size).toBe(2);
    expect(encodeInteropValue(pair)).toEqual(encodeInteropValue(new Set([dup()])));
  });

  it('rejects a Set with too many distinct elements during iteration', () => {
    // 10,002 tiny distinct elements: far under the byte budget, over the
    // 10,000 collection cap. The cap fires on the 10,001st retained element,
    // not after the full Set has been encoded and buffered.
    const total = 10_002;
    let encoded = 0;
    const elements = Array.from({ length: total }, (_, i) => ({
      get n(): number {
        encoded++;
        return i;
      },
    }));
    expect(() => encodeInteropValue(new Set(elements))).toThrow(ValueTooLargeError);
    expect(encoded).toBeLessThan(total);
  });
});

describe('interop map/object collection cap timing (encodeMapEntries)', () => {
  it('rejects an over-cap Map before iterating a single entry', () => {
    // Map.size is O(1), so the cap must fire before the entry loop runs —
    // otherwise 10,001 tuples materialise pre-cap. The own-property iterator
    // spy shadows Map.prototype[Symbol.iterator] and counts pulls.
    const m = new Map(Array.from({ length: 10_001 }, (_, i) => [`k${i}`, 0]));
    let iterated = 0;
    const inner = Map.prototype[Symbol.iterator].bind(m);
    Object.defineProperty(m, Symbol.iterator, {
      value: function* (): Generator<[string, number]> {
        for (const e of inner()) {
          iterated++;
          yield e as [string, number];
        }
      },
    });
    expect(() => encodeInteropValue(m)).toThrow(ValueTooLargeError);
    expect(iterated).toBe(0);
  });

  it('rejects an over-cap plain object before any key is UTF-8 encoded or sorted', () => {
    // The first-iterated key is a lone surrogate: if any key reached
    // utf8Strict, the encoder would throw SerializationError (well-formedness)
    // instead of ValueTooLargeError. The cap winning pins the ordering — the
    // count check fires before key materialisation.
    const obj: Record<string, number> = { '\ud800': 0 };
    for (let i = 0; i < 10_001; i++) obj[`k${i}`] = 0;
    expect(() => encodeInteropValue(obj)).toThrow(ValueTooLargeError);
    // Same object one key under the cap: key encoding now runs and the lone
    // surrogate is what rejects it (proves the spy key is actually live).
    const under: Record<string, number> = { '\ud800': 0 };
    for (let i = 0; i < 9_998; i++) under[`k${i}`] = 0;
    expect(() => encodeInteropValue(under)).toThrow(/well-formed Unicode|lone surrogates/);
  });

  it('accepts a Map at exactly the cap with unchanged canonical bytes', () => {
    const atCap = new Map(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, i]));
    const bytes = encodeInteropValue(atCap);
    // Object form of the same entries encodes byte-identically (shared
    // encodeMapEntries path, key-sorted canonical form).
    expect(hex(encodeInteropValue(Object.fromEntries(atCap)))).toBe(hex(bytes));
  });
});

describe('interop value encoding (value profile)', () => {
  it('maps undefined to nil (no cross-SDK arity contract for values)', () => {
    expect(hex(encodeInteropValue(undefined))).toBe('c0');
    expect(hex(encodeInteropValue({ a: undefined }))).toBe(hex(encodeInteropValue({ a: null })));
  });

  it('preserves -0 as float64 (the one JS-expressible non-collapsed float)', () => {
    expect(hex(encodeInteropValue(-0))).toBe('cb8000000000000000');
    // args profile collapses it (negative_zero vector behavior)
    expect(hex(encodeInteropArgs([-0]))).toBe('9100');
  });

  it('rejects unsafe integral numbers in values too (round-trip type stability)', () => {
    // Collapsing 2^53+ to int on write but decoding it back as BigInt would
    // make the same call return number (L1 hit) or BigInt (L2 hit)
    // intermittently — reject and require BigInt end-to-end.
    expect(() => encodeInteropValue(2 ** 53)).toThrow(/BigInt/);
    expect(() => encodeInteropValue({ id: 2 ** 60 })).toThrow(SerializationError);
  });

  it('InteropFloat in the value profile never collapses (float 2.0 stays float64)', () => {
    expect(hex(encodeInteropValue(new InteropFloat(2)))).toBe('cb4000000000000000');
  });

  it('round-trips a Date through the __datetime__ sentinel map', () => {
    const d = new Date('2024-01-01T12:30:45.123Z');
    const bytes = encodeInteropValue({ createdAt: d });
    const revived = decodeInteropValue<{ createdAt: Date }>(bytes);
    expect(revived.createdAt).toBeInstanceOf(Date);
    expect(revived.createdAt.getTime()).toBe(d.getTime());
  });

  it('rejects NaN and Infinity in values (reference-implementation behavior)', () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(() => encodeInteropValue(v)).toThrow(/NaN and Infinity/);
    }
  });
});

describe('interop value decoding', () => {
  it('rejects trailing bytes (exactly one MessagePack document)', () => {
    // 0x01 is a complete document (fixint 1); anything after it must fail.
    expect(() => decodeInteropValue(Uint8Array.of(0x01, 0x02))).toThrow(SerializationError);
  });

  it('rejects a forged giant collection header before preallocating (DoS)', () => {
    // array32 claiming 2^32-1 elements in 5 bytes — must fail on the length
    // cap, not attempt new Array(4294967295).
    expect(() => decodeInteropValue(Uint8Array.of(0xdd, 0xff, 0xff, 0xff, 0xff))).toThrow(
      SerializationError
    );
    // map16 claiming 65535 entries.
    expect(() => decodeInteropValue(Uint8Array.of(0xde, 0xff, 0xff))).toThrow(SerializationError);
  });

  it('surfaces a CK v3 frame with a targeted diagnostic', () => {
    // "CK" 0x43 0x4B | version 0x03 — the Python SDK's private container.
    const ckFrame = Uint8Array.of(0x43, 0x4b, 0x03, 0x00, 0x00, 0x00, 0x02, 0x7b, 0x7d);
    expect(() => decodeInteropValue(ckFrame)).toThrow(/Python-SDK-internal/);
  });

  it('leaves a __datetime__-shaped map with an unparseable value untouched', () => {
    const bytes = encodeInteropValue({ __datetime__: true, value: 'not-a-date' });
    expect(decodeInteropValue(bytes)).toEqual({ __datetime__: true, value: 'not-a-date' });
  });

  it('leaves __date__ and __time__ sentinels as maps (no JS type to revive into)', () => {
    const bytes = encodeInteropValue({ __date__: true, value: '2025-11-14' });
    expect(decodeInteropValue(bytes)).toEqual({ __date__: true, value: '2025-11-14' });
  });

  it('reads integers beyond 2^53 as BigInt — never silently rounded', () => {
    // A Python-written snowflake ID (uint64) must survive the read intact.
    const u64max = 18446744073709551615n;
    expect(decodeInteropValue(encodeInteropValue(u64max))).toBe(u64max);
    expect(decodeInteropValue(encodeInteropValue({ id: 2n ** 60n }))).toEqual({ id: 2n ** 60n });
  });

  it('normalizes safe-range integers back to number on read', () => {
    expect(decodeInteropValue<number>(encodeInteropValue(42))).toBe(42);
    // 5e9 encodes as uint64-width on the wire only for non-canonical writers;
    // canonical shortest-form uses uint32 here — either way the reader
    // returns a plain number inside the safe range.
    expect(decodeInteropValue<{ ts: number }>(encodeInteropValue({ ts: 1704112245123 }))).toEqual({
      ts: 1704112245123,
    });
  });
});

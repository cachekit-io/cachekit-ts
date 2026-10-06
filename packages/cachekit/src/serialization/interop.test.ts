import { describe, it, expect } from 'vitest';
import {
  encodeInteropArgs,
  interopArgsHash,
  generateInteropKey,
  encodeInteropValue,
  decodeInteropValue,
  encodeInteropValueCounted,
  decodeInteropValueCounted,
  validateInteropSegment,
  INTEROP_SEGMENT_PATTERN,
  InteropFloat,
} from './interop.js';
import { ConfigurationError, SerializationError, ValueTooLargeError } from '../errors.js';
import { DEFAULT_MAX_COLLECTION_SIZE } from '../constants.js';
import { ExtData } from '@msgpack/msgpack';

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

  it('rejects the reserved namespaces ns and nsapi', () => {
    for (const seg of ['ns', 'nsapi']) {
      expect(() => validateInteropSegment('namespace', seg)).toThrow(ConfigurationError);
      expect(() => validateInteropSegment('namespace', seg)).toThrow(/reserved/);
    }
  });

  it('reserves ns and nsapi by exact match, as a namespace only', () => {
    for (const seg of ['ns', 'nsapi']) {
      expect(() => validateInteropSegment('operation', seg)).not.toThrow();
    }
    for (const seg of ['nsx', 'nsfw', 'nsapi2']) {
      expect(() => validateInteropSegment('namespace', seg)).not.toThrow();
    }
  });

  it('rejects a non-string segment before the reservation check', () => {
    // RegExp.test string-coerces, Set.has does not: ['ns'] would pass the
    // grammar, skip the reservation, and mint an `ns:` key.
    for (const seg of [['ns'], new String('nsapi')] as unknown as string[]) {
      expect(() => validateInteropSegment('namespace', seg)).toThrow(ConfigurationError);
      expect(() => generateInteropKey(seg, 'get_user', [1])).toThrow(ConfigurationError);
    }
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
    // do not advance the byte budget; the count cap counts the caller's Set.
    // This must encode byte-identically to the singleton, not throw at the
    // pre-dedupe sum.
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

  it('rejects a Set with too many distinct elements before encoding any', () => {
    // 10,002 tiny distinct elements: far under the byte budget, over the
    // 10,000 collection cap. Set.size is O(1), so the cap fires before the
    // first element is encoded, not partway through the walk.
    let encoded = 0;
    const elements = Array.from({ length: 10_002 }, (_, i) => ({
      get n(): number {
        encoded++;
        return i;
      },
    }));
    expect(() => encodeInteropValue(new Set(elements))).toThrow(ValueTooLargeError);
    expect(encoded).toBe(0);
  });

  it('rejects an over-cap Set of canonically equal elements before iterating it', () => {
    // 10,001 distinct objects that all encode to the same bytes: the deduped
    // output is one element, but the cap counts the caller's Set. The
    // own-property iterator spy shadows Set.prototype[Symbol.iterator] and
    // counts pulls.
    const s = new Set(Array.from({ length: 10_001 }, () => ({ a: 1 })));
    let iterated = 0;
    const inner = Set.prototype[Symbol.iterator].bind(s);
    Object.defineProperty(s, Symbol.iterator, {
      value: function* (): Generator<{ a: number }> {
        for (const e of inner()) {
          iterated++;
          yield e;
        }
      },
    });
    expect(() => encodeInteropValue(s)).toThrow(ValueTooLargeError);
    expect(iterated).toBe(0);
  });

  it('accepts a Set of exactly the cap, distinct or canonically equal', () => {
    const distinct = new Set(Array.from({ length: 10_000 }, (_, i) => i));
    expect(decodeInteropValue(encodeInteropValue(distinct))).toHaveLength(10_000);
    const equal = new Set(Array.from({ length: 10_000 }, () => ({ a: 1 })));
    expect(encodeInteropValue(equal)).toEqual(encodeInteropValue(new Set([{ a: 1 }])));
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

  it('rejects an over-cap plain object without reading properties past the cap', () => {
    // The (cap+1)th key in enumeration order is a getter spy: Object.entries
    // would invoke it while materialising every tuple; the key-count
    // pre-check must throw before anything reads it.
    let reads = 0;
    const build = (plainKeys: number): Record<string, number> => {
      const obj: Record<string, number> = {};
      for (let i = 0; i < plainKeys; i++) obj[`k${i}`] = 0;
      Object.defineProperty(obj, 'spy', {
        enumerable: true,
        get: () => {
          reads++;
          return 0;
        },
      });
      return obj;
    };
    expect(() => encodeInteropValue(build(10_000))).toThrow(ValueTooLargeError);
    expect(reads).toBe(0);
    // One key under the cap: the spy is the 10,000th key, so it is read
    // exactly once and the object encodes (proves the spy is live).
    reads = 0;
    encodeInteropValue(build(9_999));
    expect(reads).toBe(1);
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

  it('rejects a backed collection over the collection cap', () => {
    const nils = new Uint8Array(3 + DEFAULT_MAX_COLLECTION_SIZE + 1).fill(0xc0);
    nils.set([
      0xdc,
      (DEFAULT_MAX_COLLECTION_SIZE + 1) >> 8,
      (DEFAULT_MAX_COLLECTION_SIZE + 1) & 0xff,
    ]);
    expect(() => decodeInteropValue(nils)).toThrow(/exceeds max/);
  });

  it('rejects a backed map over the collection cap', () => {
    const n = DEFAULT_MAX_COLLECTION_SIZE + 1;
    const pairs = new Uint8Array(3 + n * 2);
    pairs.set([0xde, n >> 8, n & 0xff]);
    for (let i = 0; i < n; i++) pairs.set([0xa0, 0xc0], 3 + i * 2); // '' -> nil
    expect(() => decodeInteropValue(pairs)).toThrow(/exceeds max/);
  });

  it('reads an ext type it has no codec for as ExtData (reader_ext_type)', () => {
    expect(decodeInteropValue(Uint8Array.of(0xd4, 0x01, 0x2a))).toEqual(
      new ExtData(1, Uint8Array.of(0x2a))
    );
  });

  it('reads invalid UTF-8 as U+FFFD on both short-string paths and above them', () => {
    // An overlong '/' (c0 af): @msgpack/msgpack read it as '/' below 201 bytes.
    // Lengths 2, 64 and 65 sit below, at and above the reader's ASCII fast-path
    // limit; 300 is past the old decoder's TextDecoder edge.
    for (const n of [2, 64, 65, 300]) {
      const pad = 'a'.repeat(n - 2);
      const doc = new Uint8Array([0xda, n >> 8, n & 0xff, ...Buffer.from(pad), 0xc0, 0xaf]);
      expect(decodeInteropValue(doc)).toBe(pad + '\ufffd\ufffd');
    }
  });

  it('reads int64 at its full width and sign', () => {
    // d3 is signed: reading it unsigned would turn -1 into 2^64-1.
    expect(
      decodeInteropValue(Uint8Array.of(0xd3, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))
    ).toBe(-1);
    expect(decodeInteropValue(Uint8Array.of(0xd3, 0x80, 0, 0, 0, 0, 0, 0, 0))).toBe(-(2n ** 63n));
  });

  it('reads an integer map key at any width as the same property', () => {
    // {1: 42} with the key as fixint (reader_non_string_map_key) and as uint64;
    // @msgpack/msgpack threw on the latter.
    expect(decodeInteropValue(Uint8Array.of(0x81, 0x01, 0x2a))).toEqual({ 1: 42 });
    expect(decodeInteropValue(Uint8Array.of(0x81, 0xcf, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x2a))).toEqual({
      1: 42,
    });
  });

  it('rejects a map key that is not a string or number', () => {
    // The pre-scan counts map entries but never checks key types, so the
    // reader refuses these itself: nil, bool, bin, array, map and ext keys.
    const keys: [number[], string][] = [
      [[0xc0], 'object'],
      [[0xc3], 'boolean'],
      [[0xc4, 0x00], 'object'],
      [[0x90], 'object'],
      [[0x80], 'object'],
      [[0xd4, 0x01, 0x2a], 'object'],
    ];
    for (const [key, type] of keys) {
      expect(() => decodeInteropValue(Uint8Array.of(0x81, ...key, 0x01))).toThrow(
        `Interop map key must be a string or number, not ${type}`
      );
    }
  });

  it('still reads the msgpack timestamp ext as a Date', () => {
    // fixext4, type -1, 32-bit seconds = 1.
    expect(decodeInteropValue(Uint8Array.of(0xd6, 0xff, 0, 0, 0, 1))).toEqual(new Date(1000));
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

describe('interop object and value count (L1 memory charge)', () => {
  it('counts the same objects and values on encode as on decode', () => {
    const value = {
      empty: [{}, []],
      when: new Date(0), // a sentinel map on the wire
      tags: new Set([[1], ['x']]),
      big: Array.from({ length: 20 }, () => []), // array16
      bin: [new Uint8Array(0), new Uint8Array(2)],
    };
    const encoded = { objects: 0, values: 0 };
    const decoded = { objects: 0, values: 0 };
    decodeInteropValueCounted(encodeInteropValueCounted(value, encoded), decoded);
    // values: 5 entries + 2 + 2 (sentinel) + 2 + 1 + 1 + 20 + 2
    expect(encoded).toEqual({ objects: 32, values: 35 });
    expect(decoded).toEqual({ objects: 32, values: 35 });
  });

  it("counts a Set's duplicates on encode: L1 keeps the caller's Set", () => {
    // 100 canonically equal elements encode as one.
    const value = new Set(Array.from({ length: 100 }, () => ({ a: [] })));
    const encoded = { objects: 0, values: 0 };
    const decoded = { objects: 0, values: 0 };
    const bytes = encodeInteropValueCounted(value, encoded);
    expect(decodeInteropValueCounted(bytes, decoded)).toEqual([{ a: [] }]);
    // The Set, then a map and an array per element; one entry per map.
    expect(encoded).toEqual({ objects: 201, values: 200 });
    expect(decoded).toEqual({ objects: 3, values: 2 });
  });

  it('leaves the public codec signatures as they were', () => {
    expect(encodeInteropValue.length).toBe(1);
    expect(decodeInteropValue.length).toBe(1);
  });
});

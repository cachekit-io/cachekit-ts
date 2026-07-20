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

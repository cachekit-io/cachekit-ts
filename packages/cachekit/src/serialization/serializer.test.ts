import { describe, it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ExtData, decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';
import {
  MessagePackSerializer,
  assertDecodeDepth,
  boundedDecodeOptions,
  decodeCounted,
  encodeCounted,
  resolveSerializerConfig,
} from './serializer.js';
import { ConfigurationError, ValueTooLargeError, SerializationError } from '../errors.js';
import { decodeInteropValue } from './interop.js';

const retag = <T extends object>(value: T, tag: string): T =>
  Object.defineProperty(value, Symbol.toStringTag, { value: tag });
/** `levels` nested collections around `1`: objects by default, arrays on request. */
const nest = (levels: number, array = false): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < levels; i++) v = array ? [v] : { n: v };
  return v;
};
const detach = (buf: ArrayBuffer) => {
  structuredClone(buf, { transfer: [buf] });
  return buf;
};

describe('MessagePackSerializer', () => {
  const serializer = new MessagePackSerializer();

  describe('encode/decode round-trip', () => {
    it('handles primitives', () => {
      expect(serializer.decode(serializer.encode(42))).toBe(42);
      expect(serializer.decode(serializer.encode('hello'))).toBe('hello');
      expect(serializer.decode(serializer.encode(true))).toBe(true);
      expect(serializer.decode(serializer.encode(null))).toBe(null);
    });

    it('handles arrays and objects', () => {
      const arr = [1, 2, 3];
      const obj = { a: 1, b: 2 };
      expect(serializer.decode(serializer.encode(arr))).toEqual(arr);
      expect(serializer.decode(serializer.encode(obj))).toEqual(obj);
    });

    it('handles nested structures', () => {
      const nested = {
        user: { name: 'Alice', age: 30 },
        tags: ['tag1', 'tag2'],
        metadata: { active: true },
      };
      expect(serializer.decode(serializer.encode(nested))).toEqual(nested);
    });

    it('handles Date objects', () => {
      const date = new Date('2025-01-01T00:00:00.000Z');
      const encoded = serializer.encode(date);
      const decoded = serializer.decode<string>(encoded);
      expect(decoded).toBe(date.toISOString());
    });

    it('handles Map objects', () => {
      const map = new Map([
        ['b', 2],
        ['a', 1],
      ]);
      const encoded = serializer.encode(map);
      const decoded = serializer.decode<Record<string, number>>(encoded);
      expect(decoded).toEqual({ a: 1, b: 2 }); // sorted keys
    });

    it('handles Set objects', () => {
      const set = new Set([3, 1, 2]);
      const encoded = serializer.encode(set);
      const decoded = serializer.decode<number[]>(encoded);
      expect(decoded).toEqual([1, 2, 3]); // sorted values
    });

    it('encodes Uint8Array and Buffer as msgpack bin, decodes to Uint8Array (LAB-4839)', () => {
      const bin = Uint8Array.of(0xc4, 0x03, 1, 2, 3);
      expect(serializer.encode(Uint8Array.of(1, 2, 3))).toEqual(bin);
      expect(serializer.encode(Buffer.from([1, 2, 3]))).toEqual(bin);
      // Another realm's Uint8Array (vm, jest) fails instanceof but is still binary.
      expect(serializer.encode(runInNewContext('Uint8Array.of(1, 2, 3)'))).toEqual(bin);
      const decoded = serializer.decode(bin);
      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(decoded).toEqual(Uint8Array.of(1, 2, 3));
    });

    it.each([
      ['Float64Array', new Float64Array([1.5])],
      ['Uint8ClampedArray', new Uint8ClampedArray(2)],
      ['DataView', new DataView(new ArrayBuffer(2))],
      ['ArrayBuffer', new ArrayBuffer(2)],
      ['ArrayBuffer', runInNewContext('new ArrayBuffer(2)')], // another realm
      ['SharedArrayBuffer', new SharedArrayBuffer(2)],
      ['ArrayBuffer', detach(new ArrayBuffer(2))],
      // Retagged: the brand, not Symbol.toStringTag, decides the type.
      ['Float64Array', retag(new Float64Array([1.5]), 'Uint8Array')],
      ['ArrayBuffer', retag(new ArrayBuffer(2), 'Object')],
    ])('rejects %s rather than map-encoding it (LAB-4839)', (name, value) => {
      expect(() => serializer.encode(value)).toThrow(SerializationError);
      expect(() => serializer.encode({ nested: value })).toThrow(`Cannot serialize ${name}`);
    });

    it('encodes a Uint8Array by its internal slots, not shadowable properties (LAB-4839)', () => {
      const shadowed = Object.defineProperty(Uint8Array.of(1, 2, 3), 'byteLength', { value: 0 });
      expect(serializer.encode(shadowed)).toEqual(Uint8Array.of(0xc4, 0x03, 1, 2, 3));
    });

    it('encodes a detached Uint8Array as empty bin (LAB-4839)', () => {
      const buf = new ArrayBuffer(4);
      const view = new Uint8Array(buf);
      detach(buf);
      expect(serializer.encode(view)).toEqual(Uint8Array.of(0xc4, 0));
    });

    it('encodes a plain object tagged as a buffer as a map (LAB-4839)', () => {
      const encoded = serializer.encode(retag({ a: 1 }, 'ArrayBuffer'));
      expect(serializer.decode(encoded)).toEqual({ a: 1 });
    });

    it('fails at load when an intrinsic getter is missing, not by keying all binary alike (LAB-4839)', async () => {
      const original = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset');
      Reflect.deleteProperty(DataView.prototype, 'byteOffset');
      vi.resetModules();
      try {
        await expect(import('./serializer.js')).rejects.toThrow(
          'cachekit: intrinsic getter byteOffset not found'
        );
      } finally {
        if (original) Object.defineProperty(DataView.prototype, 'byteOffset', original);
        vi.resetModules();
      }
    });
  });

  describe('deterministic output', () => {
    it('sorts object keys', () => {
      const a = serializer.encode({ z: 1, a: 2 });
      const b = serializer.encode({ a: 2, z: 1 });
      expect(a).toEqual(b);
    });

    it('normalizes -0 to 0', () => {
      const a = serializer.encode(-0);
      const b = serializer.encode(0);
      expect(a).toEqual(b);
    });

    it('converts undefined to null', () => {
      const result = serializer.decode(serializer.encode(undefined));
      expect(result).toBe(null);
    });

    it('produces same output for nested unsorted objects', () => {
      const a = serializer.encode({ outer: { z: 1, a: 2 }, meta: { y: 3, x: 4 } });
      const b = serializer.encode({ meta: { x: 4, y: 3 }, outer: { a: 2, z: 1 } });
      expect(a).toEqual(b);
    });

    it('sorts Map keys deterministically', () => {
      const map1 = new Map([
        ['zebra', 1],
        ['apple', 2],
      ]);
      const map2 = new Map([
        ['apple', 2],
        ['zebra', 1],
      ]);
      expect(serializer.encode(map1)).toEqual(serializer.encode(map2));
    });
  });

  describe('DoS protection - maxEncodedSize', () => {
    it('throws ValueTooLargeError for oversized encoded output', () => {
      const smallSerializer = new MessagePackSerializer({ maxEncodedSize: 10 });
      expect(() => smallSerializer.encode('a'.repeat(100))).toThrow(ValueTooLargeError);
    });

    it('throws with correct error message for encoded size', () => {
      const smallSerializer = new MessagePackSerializer({ maxEncodedSize: 10 });
      try {
        smallSerializer.encode('a'.repeat(100));
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ValueTooLargeError);
        expect((error as Error).message).toContain('exceeds max 10');
      }
    });

    it('allows values at size limit', () => {
      const serializer = new MessagePackSerializer({ maxEncodedSize: 100 });
      const value = 'a'.repeat(50); // Well under limit
      expect(() => serializer.encode(value)).not.toThrow();
    });
  });

  describe('DoS protection - maxDecodedSize', () => {
    it('throws ValueTooLargeError for oversized input', () => {
      const smallSerializer = new MessagePackSerializer({ maxDecodedSize: 10 });
      const largeData = new Uint8Array(100);
      expect(() => smallSerializer.decode(largeData)).toThrow(ValueTooLargeError);
    });

    it('throws with correct error message for input size', () => {
      const smallSerializer = new MessagePackSerializer({ maxDecodedSize: 10 });
      const largeData = new Uint8Array(100);
      try {
        smallSerializer.decode(largeData);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ValueTooLargeError);
        expect((error as Error).message).toContain('exceeds max 10');
      }
    });

    it('allows input at size limit', () => {
      const serializer = new MessagePackSerializer({ maxDecodedSize: 100 });
      const smallData = serializer.encode({ test: 'data' });
      expect(() => serializer.decode(smallData)).not.toThrow();
    });
  });

  describe('DoS protection - maxDepth', () => {
    // 32 is the lowest maxDepth the constructor accepts (protocol decode bound).
    const shallowSerializer = new MessagePackSerializer({ maxDepth: 32 });

    it('throws SerializationError for excessive depth', () => {
      expect(() => shallowSerializer.encode(nest(33))).toThrow(SerializationError);
      expect(() => shallowSerializer.encode(nest(33))).toThrow('Max depth of 32 exceeded');
    });

    it('allows nesting at depth limit', () => {
      expect(() => shallowSerializer.encode(nest(32))).not.toThrow();
    });

    it('checks depth for arrays', () => {
      expect(() => shallowSerializer.encode(nest(33, true))).toThrow(SerializationError);
      expect(() => shallowSerializer.encode(nest(33, true))).toThrow('Max depth of 32 exceeded');
    });

    it('checks depth for Map values', () => {
      const deep = new Map([['key', nest(32)]]); // Map + 32 levels = 33
      expect(() => shallowSerializer.encode(deep)).toThrow(SerializationError);
      expect(() => shallowSerializer.encode(deep)).toThrow('Max depth of 32 exceeded');
    });
  });

  describe('decode error handling', () => {
    it('throws SerializationError for invalid MessagePack', () => {
      const invalidData = new Uint8Array([0xff, 0xff, 0xff]);
      expect(() => serializer.decode(invalidData)).toThrow(SerializationError);
    });

    it('wraps decode errors with cause', () => {
      // Structurally valid msgpack that the pre-scan passes (fixarray of 3,
      // depth 1, no trailing bytes) but the decoder rejects on the collection
      // cap — exercises the decode()-path error wrapping, not the pre-scan.
      const small = new MessagePackSerializer({ maxCollectionSize: 2 });
      const overCap = Uint8Array.of(0x93, 0x01, 0x02, 0x03);
      try {
        small.decode(overCap);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SerializationError);
        expect((error as Error).message).toContain('Failed to decode MessagePack');
      }
    });
  });

  describe('configuration', () => {
    it('uses default config when none provided', () => {
      const defaultSerializer = new MessagePackSerializer();
      expect(() => defaultSerializer.encode({ test: 'data' })).not.toThrow();
    });

    it('accepts partial config override', () => {
      const customSerializer = new MessagePackSerializer({ maxDepth: 50 });
      expect(() => customSerializer.encode({ test: 'data' })).not.toThrow();
    });

    it.each([32, 1024])(
      'accepts maxDepth %s (inside the protocol bound [32, 1024])',
      (maxDepth) => {
        expect(() => new MessagePackSerializer({ maxDepth })).not.toThrow();
      }
    );

    it.each([31, 1025, 0, -1, 100.5, NaN, Infinity, undefined])(
      'rejects maxDepth %s with ConfigurationError, never clamps',
      (maxDepth) => {
        const config = { maxDepth } as { maxDepth: number };
        expect(() => new MessagePackSerializer(config)).toThrow(ConfigurationError);
        expect(() => new MessagePackSerializer(config)).toThrow(
          /maxDepth must be an integer from 32 to 1024/
        );
      }
    );

    describe.each(['maxEncodedSize', 'maxDecodedSize', 'maxCollectionSize'] as const)(
      '%s',
      (field) => {
        it.each([undefined, NaN, Infinity, 0, -1, 1.5])(
          'rejects %s with ConfigurationError naming the field',
          (value) => {
            const config = { [field]: value } as Record<string, number>;
            expect(() => new MessagePackSerializer(config)).toThrow(ConfigurationError);
            expect(() => new MessagePackSerializer(config)).toThrow(
              `serializer.${field} must be a positive safe integer, got ${String(value)}`
            );
          }
        );

        it.each([1, Number.MAX_SAFE_INTEGER])('accepts %s', (value) => {
          expect(() => new MessagePackSerializer({ [field]: value })).not.toThrow();
        });
      }
    );
  });

  describe('LAB-281: DoS protection - forged collection headers on decode', () => {
    it('rejects a forged giant collection header before preallocating (DoS)', () => {
      // array32 claiming 2^32-1 elements in 5 bytes — must fail on the length
      // cap, not attempt new Array(4294967295).
      expect(() => serializer.decode(Uint8Array.of(0xdd, 0xff, 0xff, 0xff, 0xff))).toThrow(
        SerializationError
      );
      // map16 claiming 65535 entries.
      expect(() => serializer.decode(Uint8Array.of(0xde, 0xff, 0xff))).toThrow(SerializationError);
    });

    it('applies the configured maxCollectionSize, not a hardcoded constant', () => {
      const small = new MessagePackSerializer({ maxCollectionSize: 2 });
      // fixarray of 3 fixints — legal msgpack, over the configured cap.
      expect(() => small.decode(Uint8Array.of(0x93, 0x01, 0x02, 0x03))).toThrow(SerializationError);
      // fixarray of 2 fixints — at the cap, decodes fine.
      expect(small.decode(Uint8Array.of(0x92, 0x01, 0x02))).toEqual([1, 2]);
    });

    it('never rejects what encode legally produces (write/read symmetry)', () => {
      const s = new MessagePackSerializer({ maxCollectionSize: 100 });
      const atLimit = Array.from({ length: 100 }, (_, i) => i);
      expect(s.decode(s.encode(atLimit))).toEqual(atLimit);
    });
  });

  describe('M9: DoS protection - maxCollectionSize', () => {
    it('throws SerializationError for oversized Map', () => {
      const serializer = new MessagePackSerializer({ maxCollectionSize: 100 });
      const largeMap = new Map<number, number>();
      for (let i = 0; i < 10000; i++) {
        largeMap.set(i, i);
      }
      expect(() => serializer.encode(largeMap)).toThrow(SerializationError);
    });

    it('throws SerializationError for oversized Set', () => {
      const serializer = new MessagePackSerializer({ maxCollectionSize: 100 });
      const largeSet = new Set<number>();
      for (let i = 0; i < 10000; i++) {
        largeSet.add(i);
      }
      expect(() => serializer.encode(largeSet)).toThrow(SerializationError);
    });

    it('throws SerializationError for oversized Array', () => {
      const serializer = new MessagePackSerializer({ maxCollectionSize: 100 });
      const largeArray = Array.from({ length: 10000 }, (_, i) => i);
      expect(() => serializer.encode(largeArray)).toThrow(SerializationError);
    });

    it('throws SerializationError for oversized Object', () => {
      const serializer = new MessagePackSerializer({ maxCollectionSize: 100 });
      const largeObject: Record<string, number> = {};
      for (let i = 0; i < 10000; i++) {
        largeObject[`key${i}`] = i;
      }
      expect(() => serializer.encode(largeObject)).toThrow(SerializationError);
    });

    it('allows collections at size limit', () => {
      const serializer = new MessagePackSerializer({ maxCollectionSize: 100 });
      const okMap = new Map<number, number>();
      for (let i = 0; i < 100; i++) {
        okMap.set(i, i);
      }
      expect(() => serializer.encode(okMap)).not.toThrow();
    });

    it('uses default maxCollectionSize of 10000', () => {
      const serializer = new MessagePackSerializer();
      const largeMap = new Map<number, number>();
      for (let i = 0; i < 100000; i++) {
        largeMap.set(i, i);
      }
      expect(() => serializer.encode(largeMap)).toThrow(SerializationError);
    });
  });

  describe('LAB-2487: DoS protection - nested collection-header amplification', () => {
    const serializer = new MessagePackSerializer();

    // Build N nested `array16` headers each claiming 10000 elements (3 bytes
    // each). Un-mitigated this forced ~400MB of transient heap from ~15KB
    // (~26,700x) before the end-of-input throw, because @msgpack/msgpack runs
    // `new Array(size)` per header before children decode.
    const nestedArray16Headers = (n: number): Uint8Array => {
      const buf = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        buf[i * 3] = 0xdc; // array16
        buf[i * 3 + 1] = 0x27; // 0x2710 = 10000
        buf[i * 3 + 2] = 0x10;
      }
      return buf;
    };

    it('rejects the 5000-deep forged probe before the decoder allocates (AC-2)', () => {
      // The pre-scan fails on depth (or truncation) after reading only headers,
      // so `decode()` — and its per-header `new Array(10000)` — never runs. The
      // structural rejection is what pins the allocation ceiling: no decode, no
      // preallocation. Un-mitigated, decode() of this input reached ~400MB.
      expect(() => serializer.decode(nestedArray16Headers(5000))).toThrow(SerializationError);
      expect(() => assertDecodeDepth(nestedArray16Headers(5000), 100)).toThrow(/depth|Truncated/);
    });

    it('rejects a spine that claims more children than the bytes can back', () => {
      // 100 nested array16(10000) = 300 bytes claiming 10000 children per level.
      // Structural completeness (global slot budget) rejects it as truncated:
      // the buffer cannot back the declared children. Depth alone would pass.
      expect(() => assertDecodeDepth(nestedArray16Headers(100), 1000)).toThrow(SerializationError);
    });

    it('enforces the depth bound at the configured maxDepth', () => {
      const shallow = new MessagePackSerializer({ maxDepth: 32 });
      const buf = serializer.encode(nest(33, true)); // default serializer encodes fine (maxDepth 100)
      expect(() => shallow.decode(buf)).toThrow(/depth/);
    });

    it('never rejects a legal payload nested up to maxDepth (write/read symmetry)', () => {
      // A value wrapped in exactly maxDepth collections must still round-trip:
      // the pre-scan must be no stricter than the encoder's own depth bound.
      let v: unknown = 42;
      for (let i = 0; i < 99; i++) v = [v]; // 99 array levels, well within 100
      expect(serializer.decode(serializer.encode(v))).toEqual(v);

      // Wide-but-shallow and mixed structures must pass untouched.
      const wide = { list: Array.from({ length: 5000 }, (_, i) => i), meta: { a: true, b: 'x' } };
      expect(serializer.decode(serializer.encode(wide))).toEqual(wide);
    });

    it('differential fuzz: pre-scan is byte-faithful to the decoder across every type', () => {
      // The pre-scan is a second parser gating the real decoder; the one
      // catastrophic desync is a width miscount that shifts every later offset.
      // Encode random legal values spanning every head-byte family the encoder
      // emits (each int and float width, str/bin/ext at every length tier,
      // timestamp and application ext, collections wide enough for
      // array16/map16), plus hand-built padded headers for the families it
      // never emits (array32, map32, str32, bin32, ext32), and assert the
      // pre-scan accepts exactly what the decoder accepts. The interop reader
      // (decodeInteropValue) trusts the pre-scan for backing and end of input,
      // so it runs in both arms too: on legal values it must read exactly what
      // @msgpack/msgpack reads (64-bit ints as BigInt, normalised to number when
      // safe, as the interop path does).
      const safeInts = (v: unknown): unknown => {
        if (typeof v === 'bigint') {
          return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : v;
        }
        if (Array.isArray(v)) return v.map(safeInts);
        if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
          const rec = v as Record<string, unknown>;
          return Object.fromEntries(Object.keys(rec).map((k) => [k, safeInts(rec[k])]));
        }
        return v;
      };
      /** The interop reader writes U+FFFD only for invalid UTF-8, where it
       * deliberately differs from @msgpack/msgpack's lax short-string decoder. */
      const hasReplacement = (v: unknown): boolean => {
        if (typeof v === 'string') return v.includes('\ufffd');
        if (Array.isArray(v)) return v.some(hasReplacement);
        if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
          return Object.entries(v).some(([k, x]) => k.includes('\ufffd') || hasReplacement(x));
        }
        return false;
      };
      const opts = { ...boundedDecodeOptions(10000, 10 * 1024 * 1024), useBigInt64: true };
      let seed = 0x2487;
      const rand = () => {
        // deterministic LCG; Math.imul avoids the 2^53 overflow trap
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
      // Lengths straddle every header tier and the reader's short-string paths
      // (13 = first rope length, 64/65 = ASCII fast path edge, 200/201 = the old
      // decoder's TextDecoder edge, 255/256 = str8/str16). Lengths of 2^16 and up
      // stay out: they would cost seconds; the padded headers below cover them.
      const lengths = [0, 1, 5, 12, 13, 31, 32, 63, 64, 65, 200, 201, 255, 256, 300] as const;
      const scalars: (() => unknown)[] = [
        () => null,
        () => rand() < 0.5,
        () => Math.floor(rand() * 128), // positive fixint
        () => 128 + Math.floor(rand() * 128), // uint8
        () => 256 + Math.floor(rand() * 65000), // uint16
        () => 65536 + Math.floor(rand() * 1e9), // uint32
        () => 2 ** 40 + Math.floor(rand() * 1e6), // uint64 (number)
        () => -1 - Math.floor(rand() * 32), // negative fixint
        () => -33 - Math.floor(rand() * 96), // int8
        () => -129 - Math.floor(rand() * 32000), // int16
        () => -32769 - Math.floor(rand() * 1e9), // int32
        () => -(2 ** 40) - Math.floor(rand() * 1e6), // int64 (number)
        () => pick([2n ** 60n, -(2n ** 60n), 2n ** 64n - 1n, -(2n ** 63n), -1n, 1n]), // BigInt widths
        () => (rand() - 0.5) * 1e6, // float (float32 when the round encodes floats as float32)
        () => 'k'.repeat(pick(lengths)), // ASCII
        () => 'Zoë東京'.repeat(1 + Math.floor(rand() * 40)), // non-ASCII, short and long
        () => '\ufeffbom', // a leading U+FEFF; long ones differ from @msgpack/msgpack by design
        () => new Uint8Array(pick(lengths)), // bin8 / bin16
        () => new ExtData(1, new Uint8Array(pick([1, 2, 4, 8, 16, 3, 300] as const))), // fixext / ext8 / ext16
        () => new Date(Math.floor(rand() * 2e12)), // timestamp ext
      ];
      const scalar = (): unknown => pick(scalars)();
      const key = (i: number): string => pick(['f' + i, 'f' + i, 'kéy' + i, 'k'.repeat(20) + i]);
      const randomValue = (depth: number): unknown => {
        const r = rand();
        if (depth > 4 || r < 0.45) return scalar();
        // Occasionally emit a WIDE array/map of scalars so array16/map16 headers
        // (>15 entries) get exercised — without recursing, so total node count
        // stays bounded (deep recursion keeps a small branching factor).
        if (r < 0.55) {
          const wide = 16 + Math.floor(rand() * 24); // 16..39 → array16/map16
          if (rand() < 0.5) return Array.from({ length: wide }, () => scalar());
          const o: Record<string, unknown> = {};
          for (let i = 0; i < wide; i++) o[key(i)] = scalar();
          return o;
        }
        const n = Math.floor(rand() * 5); // narrow recursion (fixarray/fixmap)
        if (r < 0.8) return Array.from({ length: n }, () => randomValue(depth + 1));
        const o: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) o[key(i)] = randomValue(depth + 1);
        return o;
      };

      const check = (bytes: Uint8Array): void => {
        // Legal documents must pass the pre-scan and read the same both ways.
        expect(() => assertDecodeDepth(bytes, 100)).not.toThrow();
        expect(decodeInteropValue(bytes)).toStrictEqual(safeInts(msgpackDecode(bytes, opts)));
      };
      const legal: Uint8Array[] = [];
      for (let i = 0; i < 500; i++) {
        const bytes = msgpackEncode(randomValue(0), {
          useBigInt64: true,
          forceFloat32: i % 4 === 0,
        });
        check(bytes);
        legal.push(bytes);
      }
      // Padded 32-bit headers no encoder emits: array32 [1, 2], map32 {a: 1},
      // str32 'abc', bin32 de ad, ext32 type 1 [2a].
      const hex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/ /g, ''), 'hex'));
      for (const h of [
        'dd 00000002 01 02',
        'df 00000001 a161 01',
        'db 00000003 616263',
        'c6 00000002 dead',
        'c9 00000001 01 2a',
      ]) {
        check(hex(h));
      }

      // Garbage, built by flipping, inserting or deleting one byte of a legal
      // document so most of it still parses. The pre-scan must accept or reject
      // through SerializationError — never fault with a raw RangeError/TypeError
      // (a bad skip width or out-of-range DataView read, i.e. a walker bug). The
      // interop reader may also reject only with SerializationError, and never a
      // document both the pre-scan and @msgpack/msgpack accept (it accepts every
      // key type that decoder does, and more). When both accept, it must read
      // the same value, except where it decodes invalid UTF-8 to U+FFFD.
      // A structurally complete buffer can still be a malformed ext the decoder
      // rejects: that is the safe desync direction (reject, not over-allocate).
      let compared = 0;
      for (let i = 0; i < 2000; i++) {
        const src = pick(legal);
        const at = Math.floor(rand() * src.length);
        const byte = Math.floor(rand() * 256);
        const mutation = rand();
        let bytes: Uint8Array;
        if (mutation < 0.5) {
          bytes = src.slice();
          bytes[at] = byte;
        } else if (mutation < 0.75) {
          bytes = new Uint8Array([...src.subarray(0, at), byte, ...src.subarray(at)]);
        } else {
          bytes = new Uint8Array([...src.subarray(0, at), ...src.subarray(at + 1)]);
        }
        let scanned = true;
        try {
          assertDecodeDepth(bytes, 100);
        } catch (error) {
          expect(error).toBeInstanceOf(SerializationError);
          scanned = false;
        }
        let reference: unknown;
        let decoded = false;
        try {
          reference = msgpackDecode(bytes, opts);
          decoded = true;
        } catch {
          // garbage the decoder rejects: no claim
        }
        let value: unknown;
        try {
          value = decodeInteropValue(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(SerializationError);
          expect(scanned && decoded, `interop rejected a readable document: ${String(error)}`).toBe(
            false
          );
          continue;
        }
        if (decoded && !hasReplacement(value)) {
          expect(value).toStrictEqual(safeInts(reference));
          compared++;
        }
      }
      // The garbage arm only proves something if it reaches the comparison.
      expect(compared).toBeGreaterThan(200);
    });

    it('directly exercises each pre-scan rejection branch', () => {
      // Invalid/reserved head byte (0xc1) → default throw.
      expect(() => assertDecodeDepth(Uint8Array.of(0xc1), 100)).toThrow(/head byte/);
      // Trailing bytes after a complete value.
      expect(() => assertDecodeDepth(Uint8Array.of(0x2a, 0x2a), 100)).toThrow(/Trailing/);
      // Truncated multibyte length (str16 header claims 2 length bytes, only 1).
      expect(() => assertDecodeDepth(Uint8Array.of(0xda, 0x00), 100)).toThrow(/Truncated/);
      // Truncated collection children (fixarray(1) with no element).
      expect(() => assertDecodeDepth(Uint8Array.of(0x91), 100)).toThrow(/Truncated/);
      // Empty buffer is not a valid single value.
      expect(() => assertDecodeDepth(new Uint8Array(0), 100)).toThrow(/Truncated/);
    });
  });

  describe('object and value count (L1 memory charge)', () => {
    const config = resolveSerializerConfig();

    it('counts every array, map, bin and ext header, empty ones included', () => {
      const zeros = (n: number) => new Array<number>(n).fill(0);
      for (const bytes of [
        [0x80], // fixmap
        [0x90], // fixarray
        [0xdc, 0, 0], // array16
        [0xdd, 0, 0, 0, 0], // array32
        [0xde, 0, 0], // map16
        [0xdf, 0, 0, 0, 0], // map32
        [0xc4, 0], // bin8
        [0xc5, 0, 0], // bin16
        [0xc6, 0, 0, 0, 0], // bin32
        [0xd4, 1, ...zeros(1)], // fixext1
        [0xd5, 1, ...zeros(2)], // fixext2
        [0xd6, 1, ...zeros(4)], // fixext4
        [0xd7, 1, ...zeros(8)], // fixext8
        [0xd8, 1, ...zeros(16)], // fixext16
        [0xc7, 0, 1], // ext8
        [0xc8, 0, 0, 1], // ext16
        [0xc9, 0, 0, 0, 0, 1], // ext32
      ]) {
        expect(assertDecodeDepth(Uint8Array.from(bytes), 100).objects).toBe(1);
      }
      expect(assertDecodeDepth(Uint8Array.of(0x2a), 100).objects).toBe(0);
      expect(assertDecodeDepth(Uint8Array.of(0xa1, 0x61), 100).objects).toBe(0); // str
      expect(assertDecodeDepth(msgpackEncode([{}, [], { a: [] }, 'x', 1]), 100).objects).toBe(5);
    });

    it('counts every array element and map entry, at every header width', () => {
      const values = (bytes: number[]) => assertDecodeDepth(Uint8Array.from(bytes), 100).values;
      expect(values([0x92, 1, 2])).toBe(2); // fixarray
      expect(values([0xdc, 0, 3, 1, 2, 3])).toBe(3); // array16
      expect(values([0xdd, 0, 0, 0, 1, 1])).toBe(1); // array32
      // A map counts its entries, not its keys and values.
      expect(values([0x82, 0xa1, 0x61, 1, 0xa1, 0x62, 2])).toBe(2); // fixmap
      expect(values([0xde, 0, 1, 0xa1, 0x61, 1])).toBe(1); // map16
      expect(values([0xdf, 0, 0, 0, 1, 0xa1, 0x61, 1])).toBe(1); // map32
      expect(values([0x2a])).toBe(0);
      expect(values([0xc4, 3, 1, 2, 3])).toBe(0); // a bin's bytes are not values
      // [[0, 0], {a: [0]}]: 2 + 2 + 1 + 1
      expect(values([0x92, 0x92, 0, 0, 0x81, 0xa1, 0x61, 0x91, 0])).toBe(6);
    });

    it('counts the same objects on encode as on decode', () => {
      const value = [
        {},
        [],
        { a: [] },
        new Map([['k', new Set([1])]]),
        new Date(0), // a string, not an object of its own
        new Uint8Array(3), // bin
        Array.from({ length: 20 }, () => ({})), // array16
      ];
      const encoded = { objects: 0, values: 0 };
      const decoded = { objects: 0, values: 0 };
      decodeCounted(encodeCounted(value, config, encoded), config, decoded);
      expect(encoded).toEqual({ objects: 29, values: 30 });
      expect(decoded).toEqual({ objects: 29, values: 30 });
    });

    it("counts a Map's own entries when String(key) merges them", () => {
      // L1 keeps the caller's Map, every entry of it, though the encoding has one.
      const value = new Map(Array.from({ length: 100 }, () => [{}, 0] as const));
      const count = { objects: 0, values: 0 };
      const decoded = decodeCounted<Record<string, number>>(
        encodeCounted(value, config, count),
        config
      );
      expect(Object.keys(decoded)).toEqual(['[object Object]']);
      expect(count.values).toBe(100);
    });

    it('counts the bin and timestamp ext values another writer stores', () => {
      const bins = { objects: 0, values: 0 };
      decodeCounted(
        msgpackEncode(Array.from({ length: 100 }, () => new Uint8Array(0))),
        config,
        bins
      );
      expect(bins.objects).toBe(101);

      // @msgpack/msgpack writes a Date as a timestamp ext and reads it back as a Date.
      const dates = { objects: 0, values: 0 };
      const decoded = decodeCounted<Date[]>(
        msgpackEncode(Array.from({ length: 100 }, () => new Date(0))),
        config,
        dates
      );
      expect(decoded[0]).toBeInstanceOf(Date);
      expect(dates.objects).toBe(101);
    });

    it('counts nothing for a value the size check rejects', () => {
      const count = { objects: 0, values: 0 };
      const small = resolveSerializerConfig({ maxEncodedSize: 8 });
      expect(() =>
        encodeCounted(
          Array.from({ length: 20 }, () => ({})),
          small,
          count
        )
      ).toThrow(ValueTooLargeError);
      expect(count).toEqual({ objects: 0, values: 0 });
    });

    it('leaves the public codec signatures as they were', () => {
      expect(MessagePackSerializer.prototype.encode.length).toBe(1);
      expect(MessagePackSerializer.prototype.decode.length).toBe(1);
    });
  });
});

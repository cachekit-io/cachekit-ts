import { describe, it, expect } from 'vitest';
import { decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';
import { MessagePackSerializer, assertDecodeDepth, boundedDecodeOptions } from './serializer.js';
import { ValueTooLargeError, SerializationError } from '../errors.js';

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
    it('throws SerializationError for excessive depth', () => {
      const shallowSerializer = new MessagePackSerializer({ maxDepth: 3 });
      const deep = { a: { b: { c: { d: 1 } } } };
      expect(() => shallowSerializer.encode(deep)).toThrow(SerializationError);
    });

    it('throws with correct error message for depth', () => {
      const shallowSerializer = new MessagePackSerializer({ maxDepth: 3 });
      const deep = { a: { b: { c: { d: 1 } } } };
      try {
        shallowSerializer.encode(deep);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SerializationError);
        expect((error as Error).message).toContain('Max depth of 3 exceeded');
      }
    });

    it('allows nesting at depth limit', () => {
      const shallowSerializer = new MessagePackSerializer({ maxDepth: 3 });
      const acceptable = { a: { b: { c: 1 } } }; // depth 3
      expect(() => shallowSerializer.encode(acceptable)).not.toThrow();
    });

    it('checks depth for arrays', () => {
      const shallowSerializer = new MessagePackSerializer({ maxDepth: 2 });
      const deep = [[[1]]]; // depth 3
      expect(() => shallowSerializer.encode(deep)).toThrow(SerializationError);
    });

    it('checks depth for Map values', () => {
      const shallowSerializer = new MessagePackSerializer({ maxDepth: 2 });
      const deep = new Map([['key', { nested: { tooDeep: 1 } }]]);
      expect(() => shallowSerializer.encode(deep)).toThrow(SerializationError);
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
      const shallow = new MessagePackSerializer({ maxDepth: 3 });
      let v: unknown = 1;
      for (let i = 0; i < 4; i++) v = [v]; // 4 levels of nesting
      const buf = serializer.encode(v); // default serializer encodes fine (maxDepth 100)
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
      // Encode random legal values spanning EVERY msgpack head-byte family
      // (incl. bin, bigint→int64, float64, ext→timestamp, and collections wide
      // enough to emit array16/map16, not just fixarray/fixmap) and assert the
      // pre-scan accepts exactly what the decoder accepts — proving no
      // skip-width desync. `useBigInt64` matches the interop decode path.
      const encOpts = { useBigInt64: true } as const;
      const opts = { ...boundedDecodeOptions(10000, 10 * 1024 * 1024), useBigInt64: true };
      let seed = 0x2487;
      const rand = () => {
        // deterministic LCG; Math.imul avoids the 2^53 overflow trap
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const scalar = (): unknown => {
        const r = rand();
        if (r < 0.14) return null;
        if (r < 0.28) return Math.floor(rand() * 1e9); // int
        if (r < 0.42) return rand() * 1e6 + 0.5; // float64
        if (r < 0.56) return BigInt(Math.floor(rand() * 1e15)); // int64
        if (r < 0.7) return rand() < 0.5;
        if (r < 0.84) return 'k'.repeat(Math.floor(rand() * 40)); // fixstr/str8
        if (r < 0.92) return new Uint8Array(Math.floor(rand() * 30)); // bin8
        return new Date(Math.floor(rand() * 2e12)); // ext (timestamp)
      };
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
          for (let i = 0; i < wide; i++) o['f' + i] = scalar();
          return o;
        }
        const n = Math.floor(rand() * 5); // narrow recursion (fixarray/fixmap)
        if (r < 0.8) return Array.from({ length: n }, () => randomValue(depth + 1));
        const o: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) o['f' + i] = randomValue(depth + 1);
        return o;
      };

      for (let i = 0; i < 500; i++) {
        const bytes = msgpackEncode(randomValue(0), encOpts);
        // Legal values must pass the pre-scan and round-trip through the decoder.
        expect(() => assertDecodeDepth(bytes, 100)).not.toThrow();
        expect(() => msgpackDecode(bytes, opts)).not.toThrow();
      }

      // Random garbage: the pre-scan must either accept or reject through
      // SerializationError — never fault with a raw RangeError/TypeError (a bad
      // skip width or out-of-range DataView read, i.e. a walker bug). We do NOT
      // assert decode never throws on accepted garbage — a structurally-complete
      // buffer can still be a malformed ext/invalid-UTF-8 str the decoder
      // rejects, which is the SAFE desync direction (reject, not over-allocate).
      // The bounded opts here mean no false-accept can amplify regardless; the
      // dedicated nested-header test above pins the actual amplification bound.
      for (let i = 0; i < 1000; i++) {
        const bytes = new Uint8Array(Math.floor(rand() * 48));
        for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(rand() * 256);
        try {
          assertDecodeDepth(bytes, 100);
        } catch (error) {
          // A non-SerializationError means the walker itself faulted, not a
          // structural rejection.
          expect(error).toBeInstanceOf(SerializationError);
        }
      }
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
});

import { describe, it, expect } from 'vitest';
import { MessagePackSerializer } from './serializer.js';
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
      const invalidData = new Uint8Array([0xff, 0xff, 0xff]);
      try {
        serializer.decode(invalidData);
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
});

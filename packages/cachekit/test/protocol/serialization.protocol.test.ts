import { describe, it, expect } from 'vitest';
import { MessagePackSerializer } from '../../src/serialization/serializer';

/**
 * Protocol v1.0 Serialization Test Vectors
 *
 * Ensures deterministic MessagePack output for cross-language compatibility.
 */
describe('Protocol v1.0 Serialization', () => {
  const serializer = new MessagePackSerializer();

  describe('deterministic encoding', () => {
    it('object keys are sorted', () => {
      const a = serializer.encode({ z: 1, a: 2, m: 3 });
      const b = serializer.encode({ a: 2, m: 3, z: 1 });
      expect(a).toEqual(b);
    });

    it('nested objects are sorted', () => {
      const a = serializer.encode({ outer: { z: 1, a: 2 } });
      const b = serializer.encode({ outer: { a: 2, z: 1 } });
      expect(a).toEqual(b);
    });

    it('-0 normalizes to 0', () => {
      const a = serializer.encode(-0);
      const b = serializer.encode(0);
      expect(a).toEqual(b);
    });

    it('undefined normalizes to null', () => {
      const a = serializer.encode(undefined);
      const b = serializer.encode(null);
      expect(a).toEqual(b);
    });
  });

  describe('type preservation', () => {
    it('round-trips primitives', () => {
      expect(serializer.decode(serializer.encode(42))).toBe(42);
      expect(serializer.decode(serializer.encode('hello'))).toBe('hello');
      expect(serializer.decode(serializer.encode(true))).toBe(true);
      expect(serializer.decode(serializer.encode(null))).toBe(null);
      expect(serializer.decode(serializer.encode(3.14))).toBeCloseTo(3.14);
    });

    it('round-trips arrays', () => {
      const arr = [1, 'two', true, null];
      expect(serializer.decode(serializer.encode(arr))).toEqual(arr);
    });

    it('round-trips objects', () => {
      const obj = { name: 'test', count: 42, active: true };
      expect(serializer.decode(serializer.encode(obj))).toEqual(obj);
    });
  });
});

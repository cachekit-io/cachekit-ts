/**
 * Serializer depth bound — Workers lane
 *
 * The protocol's decode-bounds rule asks each SDK to test a complete document
 * at its own bound on its smallest supported stack. This runs the auto-mode
 * encoder at the highest maxDepth the constructor accepts, inside workerd.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeCounted,
  encodeCounted,
  resolveSerializerConfig,
} from '../../src/serialization/serializer.js';
import { SerializationError } from '../../src/errors.js';

const nest = (levels: number, array: boolean): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < levels; i++) v = array ? [v] : { n: v };
  return v;
};

describe('auto-mode encode at maxDepth 1024 (workerd)', () => {
  const config = resolveSerializerConfig({ maxDepth: 1024 });

  it.each([false, true])('round-trips a leaf at depth 1024 (arrays: %s)', (array) => {
    const value = nest(1024, array);
    expect(decodeCounted(encodeCounted(value, config), config)).toEqual(value);
  });

  it.each([false, true])('rejects a leaf at depth 1025 (arrays: %s)', (array) => {
    expect(() => encodeCounted(nest(1025, array), config)).toThrow(SerializationError);
    expect(() => encodeCounted(nest(1025, array), config)).toThrow('Max depth of 1024 exceeded');
  });
});

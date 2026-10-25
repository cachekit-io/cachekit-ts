import { afterAll, beforeAll, expect } from 'vitest';
import { blake2b256Hex } from '@cachekit-io/cachekit-core-ts';
import {
  setKeyHashBinding,
  usingKeyHashBinding,
  type Blake2b256Hex,
} from '../../src/serialization/blake2b.js';

/**
 * The two ways Node hashes a cache key: through the NAPI binding, and in JS
 * when no binding is set. Key vectors must come out byte for byte the same in
 * both. The Workers lane runs the wasm binding (test/workers).
 */
export const KEY_HASH_LANES: ReadonlyArray<readonly [string, Blake2b256Hex | undefined]> = [
  ['NAPI binding', blake2b256Hex],
  ['pure JS', undefined],
];

/** Hash the enclosing describe's keys through `hash`, and drop it afterwards. */
export function useKeyHashLane(hash: Blake2b256Hex | undefined): void {
  beforeAll(() => {
    setKeyHashBinding(hash);
    // A lane that silently fell back to JS would pass and prove nothing.
    expect(usingKeyHashBinding()).toBe(hash !== undefined);
  });
  afterAll(() => setKeyHashBinding(undefined));
}

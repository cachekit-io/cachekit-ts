import { describe, it, expect } from 'vitest';
import { AutoKeys } from './auto-keys.js';
import { generateKey, generateParamsHash } from './key-generator.js';
import {
  FULL_PATH_KEYS,
  MEMOISABLE_KEYS,
  PINNED_NAMESPACE,
} from '../../test/fixtures/auto-mode-keys.js';

describe('AutoKeys', () => {
  it('keeps every pinned key', () => {
    const keys = new AutoKeys();
    for (const { args, key } of [...MEMOISABLE_KEYS, ...FULL_PATH_KEYS]) {
      expect(keys.key(PINNED_NAMESPACE, [...args])).toBe(key);
    }
  });

  it('rebuilds the prefix when the namespace changes', () => {
    const keys = new AutoKeys();
    expect(keys.key('a', [1])).toBe(generateKey('a', [1]));
    expect(keys.key('b', [1])).toBe(generateKey('b', [1]));
    expect(keys.key('a', [1])).toBe(generateKey('a', [1]));
  });

  it('keys a namespace that is not a string as generateKey does, on every call', () => {
    const keys = new AutoKeys();
    const hash = generateParamsHash([1]);
    expect(keys.key(42 as unknown as string, [1])).toBe(`42:${hash}`);
    expect(keys.key(undefined as unknown as string, [1])).toBe(`undefined:${hash}`);
    let n = 0;
    const moving = { toString: () => `ns${++n}` } as unknown as string;
    expect(keys.key(moving, [1])).toBe(`ns1:${hash}`);
    expect(keys.key(moving, [1])).toBe(`ns2:${hash}`);
    expect(() => keys.key(Symbol('ns') as unknown as string, [1])).toThrow(TypeError);
  });
});

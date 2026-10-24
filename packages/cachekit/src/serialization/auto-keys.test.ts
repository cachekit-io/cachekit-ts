import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Encoder } from '@msgpack/msgpack';
import { AutoKeys } from './auto-keys.js';
import { generateKey, generateParamsHash } from './key-generator.js';
import {
  FULL_PATH_KEYS,
  MEMOISABLE_KEYS,
  PINNED_NAMESPACE,
} from '../../test/fixtures/auto-mode-keys.js';

const NS = PINNED_NAMESPACE;

/** Counts full-path key generations: each one encodes the arguments once. */
let encodes: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  encodes = vi.spyOn(Encoder.prototype, 'encodeSharedRef');
});
afterEach(() => {
  encodes.mockRestore();
});

/** Runs `call` and reports whether it took the full key path. */
const fullPath = (call: () => unknown): boolean => {
  const before = encodes.mock.calls.length;
  call();
  return encodes.mock.calls.length > before;
};

/** A NaN whose bits differ from the NaN literal's. */
const payloadNaN = (): number => {
  const bits = new BigUint64Array([0x7ff8000000000001n]);
  return new Float64Array(bits.buffer)[0];
};

describe('AutoKeys', () => {
  it('keeps every pinned key, memoising or not, on first and repeat calls', () => {
    const corpus = [...MEMOISABLE_KEYS, ...FULL_PATH_KEYS];
    // One memo for the whole corpus: two calls that shared an entry they
    // should not would read back the wrong key on one of the passes.
    for (const keys of [new AutoKeys(true), new AutoKeys(false)]) {
      for (let pass = 0; pass < 2; pass++) {
        for (const { args, key } of corpus) {
          expect(keys.key(NS, [...args], true)).toBe(key);
        }
      }
    }
  });

  it('memoises every call in the memoisable corpus, and no other', () => {
    const keys = new AutoKeys(true);
    for (const { name, args } of MEMOISABLE_KEYS) {
      keys.key(NS, [...args], true);
      expect(
        fullPath(() => keys.key(NS, [...args], true)),
        name
      ).toBe(false);
    }
    for (const { name, args } of FULL_PATH_KEYS) {
      keys.key(NS, [...args], true);
      expect(
        fullPath(() => keys.key(NS, [...args], true)),
        name
      ).toBe(true);
    }
  });

  it('keys 1, true and 1 as a string apart, and 0 and -0 as one', () => {
    const keys = new AutoKeys(true);
    const one = keys.key(NS, [1], true);
    expect(keys.key(NS, [true], true)).not.toBe(one);
    expect(keys.key(NS, ['1'], true)).not.toBe(one);
    expect(keys.key(NS, [true], true)).not.toBe(keys.key(NS, ['1'], true));
    const zero = keys.key(NS, [0], true);
    expect(fullPath(() => expect(keys.key(NS, [-0], true)).toBe(zero))).toBe(false);
    expect(zero).toBe(generateKey(NS, [-0]));
    keys.key(NS, [0, 'a'], true);
    expect(fullPath(() => keys.key(NS, [-0, 'a'], true))).toBe(false);
  });

  it('keys every NaN in full, so NaNs with different bits keep their own keys', () => {
    const keys = new AutoKeys(true);
    const nan = payloadNaN();
    expect(keys.key(NS, [NaN], true)).toBe(generateKey(NS, [NaN]));
    expect(keys.key(NS, [nan], true)).toBe(generateKey(NS, [nan]));
    expect(keys.key(NS, [NaN, 1], true)).toBe(generateKey(NS, [NaN, 1]));
    expect(keys.key(NS, [nan, 1], true)).toBe(generateKey(NS, [nan, 1]));
    expect(fullPath(() => keys.key(NS, [NaN], true))).toBe(true);
    expect(fullPath(() => keys.key(NS, [1, NaN], true))).toBe(true);
  });

  it('keeps apart strings that would run together without their lengths', () => {
    const keys = new AutoKeys(true);
    for (const args of [
      ['a', 'sb'],
      ['as', 'b'],
      ['a', 's1:b'],
      ['a:', 'b'],
      ['s1:a', ''],
      ['', 's1:a'],
    ]) {
      expect(keys.key(NS, args, true)).toBe(generateKey(NS, args));
    }
  });

  it('keeps to the argument and length budget', () => {
    const keys = new AutoKeys(true);
    const repeatIsFull = (args: unknown[]) => {
      keys.key(NS, args, true);
      return fullPath(() => keys.key(NS, args, true));
    };
    expect(repeatIsFull([1, 2, 3, 4, 5, 6, 7, 8])).toBe(false);
    expect(repeatIsFull([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(true);
    expect(repeatIsFull(['é'.repeat(256)])).toBe(false);
    expect(repeatIsFull(['é'.repeat(257)])).toBe(true);
    // Code units, not code points: 128 surrogate pairs fill the budget.
    expect(repeatIsFull(['\u{1F600}'.repeat(128)])).toBe(false);
    expect(repeatIsFull(['\u{1F600}'.repeat(128) + 'a'])).toBe(true);
    expect(repeatIsFull(['a'.repeat(200), 1, 'b'.repeat(56)])).toBe(false);
    expect(repeatIsFull(['a'.repeat(200), 1, 'b'.repeat(57)])).toBe(true);
  });

  it('keys every other argument in full, and still rejects what it rejected', () => {
    const keys = new AutoKeys(true);
    for (const arg of [{}, [], new Date(0), Object(1), Object('a'), Uint8Array.of(1)]) {
      keys.key(NS, [arg], true);
      expect(fullPath(() => keys.key(NS, [arg], true))).toBe(true);
      expect(fullPath(() => keys.key(NS, [1, arg], true))).toBe(true);
    }
    for (const arg of [1n, Symbol('s'), () => 1]) {
      for (const args of [[arg], [1, arg]]) {
        expect(() => keys.key(NS, args, true)).toThrow(/^Unrecognized object/);
        expect(() => keys.key(NS, args, true)).toThrow(/^Unrecognized object/);
      }
    }
  });

  it('holds at most 1,024 entries, and is emptied when full', () => {
    const keys = new AutoKeys(true);
    for (let i = 0; i < 512; i++) keys.key(NS, [i], true);
    for (let i = 0; i < 512; i++) keys.key(NS, [i, 'x'], true);
    // 1,024 entries across both shapes, all still held.
    expect(fullPath(() => keys.key(NS, [0], true))).toBe(false);
    expect(fullPath(() => keys.key(NS, [511, 'x'], true))).toBe(false);
    // The 1,025th empties the memo and is the one entry left.
    expect(fullPath(() => keys.key(NS, [-1], true))).toBe(true);
    expect(fullPath(() => keys.key(NS, [-1], true))).toBe(false);
    expect(fullPath(() => keys.key(NS, [0], true))).toBe(true);
    expect(fullPath(() => keys.key(NS, [511, 'x'], true))).toBe(true);
  });

  it('empties the memo when the namespace changes', () => {
    const keys = new AutoKeys(true);
    expect(keys.key('a', [1], true)).toBe(generateKey('a', [1]));
    expect(keys.key('b', [1], true)).toBe(generateKey('b', [1]));
    const a = generateKey('a', [1]);
    expect(fullPath(() => expect(keys.key('a', [1], true)).toBe(a))).toBe(true);
  });

  it('neither reads nor writes the memo for a call that opts out', () => {
    const keys = new AutoKeys(true);
    keys.key(NS, [1], false);
    expect(fullPath(() => keys.key(NS, [1], true))).toBe(true);
    expect(fullPath(() => keys.key(NS, [1], false))).toBe(true);
    expect(fullPath(() => keys.key(NS, [1], true))).toBe(false);
  });

  it('memoises nothing unless built to', () => {
    const keys = new AutoKeys(false);
    keys.key(NS, [1], true);
    expect(fullPath(() => keys.key(NS, [1], true))).toBe(true);
  });

  it('forgets every entry on forget()', () => {
    const keys = new AutoKeys(true);
    keys.key(NS, [1], true);
    keys.key(NS, [1, 2], true);
    keys.forget();
    expect(fullPath(() => keys.key(NS, [1], true))).toBe(true);
    expect(fullPath(() => keys.key(NS, [1, 2], true))).toBe(true);
  });

  it('matches generateKey on random primitive tuples', () => {
    // Values chosen to collide if a type or a field boundary were dropped.
    const pool: unknown[] = [
      0,
      -0,
      1,
      -1,
      1.5,
      2 ** 53,
      Infinity,
      -Infinity,
      NaN,
      true,
      false,
      null,
      undefined,
      '',
      '0',
      '1',
      'n1;',
      's1:a',
      'a',
      'ab',
      'as',
      'sb',
      's',
      'n',
      't',
      'f',
      'l',
      'u',
      ';',
      ':',
      'é',
      '\ud800',
    ];
    let seed = 1;
    const next = () => (seed = (seed * 48271) % 2147483647);
    const keys = new AutoKeys(true);
    for (let i = 0; i < 5_000; i++) {
      const args = Array.from({ length: next() % 5 }, () => pool[next() % pool.length]);
      expect(keys.key(NS, args, true)).toBe(generateKey(NS, args));
    }
  });

  it('keys a namespace that is not a string as generateKey does, on every call', () => {
    const keys = new AutoKeys(true);
    const hash = generateParamsHash([1]);
    expect(keys.key(42 as unknown as string, [1], true)).toBe(`42:${hash}`);
    expect(keys.key(undefined as unknown as string, [1], true)).toBe(`undefined:${hash}`);
    let n = 0;
    const moving = { toString: () => `ns${++n}` } as unknown as string;
    expect(keys.key(moving, [1], true)).toBe(`ns1:${hash}`);
    expect(keys.key(moving, [1], true)).toBe(`ns2:${hash}`);
    expect(() => keys.key(Symbol('ns') as unknown as string, [1], true)).toThrow(TypeError);
  });
});

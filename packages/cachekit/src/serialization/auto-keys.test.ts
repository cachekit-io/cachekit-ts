import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Encoder } from '@msgpack/msgpack';
import { AutoKeys } from './auto-keys.js';
import { generateKey, generateParamsHash } from './key-generator.js';
import {
  FULL_PATH_KEYS,
  MEMOISABLE_KEYS,
  PINNED_NAMESPACE,
} from '../../test/fixtures/auto-mode-keys.js';

const NS = PINNED_NAMESPACE;
/** An hour, in seconds: no test outside the window tests runs to the end of one. */
const TTL = 3600;

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

/** Heap in use after full collections. */
const heapAfterGc = (): number => {
  setFlagsFromString('--expose-gc');
  const gc: unknown = runInNewContext('gc');
  if (typeof gc !== 'function') throw new Error('gc is not exposed');
  for (let i = 0; i < 3; i++) gc();
  return process.memoryUsage().heapUsed;
};

/**
 * Keys eight calls, each passing a 128-character ID sliced from its own 4 MiB
 * body, and returns once nothing but the memo can reach a body or an ID. V8
 * holds such an ID as a slice that keeps the whole body alive.
 */
function keySlices(keys: AutoKeys, argsOf: (id: string, i: number) => unknown[]): void {
  for (let i = 0; i < 8; i++) {
    const body = `${String(i).padStart(3, '0')}:` + 'x'.repeat(4 << 20);
    keys.key(NS, argsOf(body.slice(0, 128), i), true, TTL);
  }
}

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
          expect(keys.key(NS, [...args], true, TTL)).toBe(key);
        }
      }
    }
  });

  it('memoises every call in the memoisable corpus, and no other', () => {
    const keys = new AutoKeys(true);
    for (const { name, args } of MEMOISABLE_KEYS) {
      keys.key(NS, [...args], true, TTL);
      expect(
        fullPath(() => keys.key(NS, [...args], true, TTL)),
        name
      ).toBe(false);
    }
    for (const { name, args } of FULL_PATH_KEYS) {
      keys.key(NS, [...args], true, TTL);
      expect(
        fullPath(() => keys.key(NS, [...args], true, TTL)),
        name
      ).toBe(true);
    }
  });

  it('keys 1, true and 1 as a string apart, and 0 and -0 as one', () => {
    const keys = new AutoKeys(true);
    const one = keys.key(NS, [1], true, TTL);
    expect(keys.key(NS, [true], true, TTL)).not.toBe(one);
    expect(keys.key(NS, ['1'], true, TTL)).not.toBe(one);
    expect(keys.key(NS, [true], true, TTL)).not.toBe(keys.key(NS, ['1'], true, TTL));
    const zero = keys.key(NS, [0], true, TTL);
    expect(fullPath(() => expect(keys.key(NS, [-0], true, TTL)).toBe(zero))).toBe(false);
    expect(zero).toBe(generateKey(NS, [-0]));
    keys.key(NS, [0, 'a'], true, TTL);
    expect(fullPath(() => keys.key(NS, [-0, 'a'], true, TTL))).toBe(false);
  });

  it('keys every NaN in full, so NaNs with different bits keep their own keys', () => {
    const keys = new AutoKeys(true);
    const nan = payloadNaN();
    expect(keys.key(NS, [NaN], true, TTL)).toBe(generateKey(NS, [NaN]));
    expect(keys.key(NS, [nan], true, TTL)).toBe(generateKey(NS, [nan]));
    expect(keys.key(NS, [NaN, 1], true, TTL)).toBe(generateKey(NS, [NaN, 1]));
    expect(keys.key(NS, [nan, 1], true, TTL)).toBe(generateKey(NS, [nan, 1]));
    expect(fullPath(() => keys.key(NS, [NaN], true, TTL))).toBe(true);
    expect(fullPath(() => keys.key(NS, [1, NaN], true, TTL))).toBe(true);
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
      expect(keys.key(NS, args, true, TTL)).toBe(generateKey(NS, args));
    }
  });

  it('keeps to the argument and length budget', () => {
    const keys = new AutoKeys(true);
    const repeatIsFull = (args: unknown[]) => {
      keys.key(NS, args, true, TTL);
      return fullPath(() => keys.key(NS, args, true, TTL));
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
      keys.key(NS, [arg], true, TTL);
      expect(fullPath(() => keys.key(NS, [arg], true, TTL))).toBe(true);
      expect(fullPath(() => keys.key(NS, [1, arg], true, TTL))).toBe(true);
    }
    for (const arg of [1n, Symbol('s'), () => 1]) {
      for (const args of [[arg], [1, arg]]) {
        expect(() => keys.key(NS, args, true, TTL)).toThrow(/^Unrecognized object/);
        expect(() => keys.key(NS, args, true, TTL)).toThrow(/^Unrecognized object/);
      }
    }
  });

  it('holds at most 1,024 entries, and is emptied when full', () => {
    const keys = new AutoKeys(true);
    for (let i = 0; i < 512; i++) keys.key(NS, [i], true, TTL);
    for (let i = 0; i < 512; i++) keys.key(NS, [i, 'x'], true, TTL);
    // 1,024 entries across both shapes, all still held.
    expect(fullPath(() => keys.key(NS, [0], true, TTL))).toBe(false);
    expect(fullPath(() => keys.key(NS, [511, 'x'], true, TTL))).toBe(false);
    // The 1,025th empties the memo and is the one entry left.
    expect(fullPath(() => keys.key(NS, [-1], true, TTL))).toBe(true);
    expect(fullPath(() => keys.key(NS, [-1], true, TTL))).toBe(false);
    expect(fullPath(() => keys.key(NS, [0], true, TTL))).toBe(true);
    expect(fullPath(() => keys.key(NS, [511, 'x'], true, TTL))).toBe(true);
  });

  it('empties the memo when the namespace changes', () => {
    const keys = new AutoKeys(true);
    expect(keys.key('a', [1], true, TTL)).toBe(generateKey('a', [1]));
    expect(keys.key('b', [1], true, TTL)).toBe(generateKey('b', [1]));
    const a = generateKey('a', [1]);
    expect(fullPath(() => expect(keys.key('a', [1], true, TTL)).toBe(a))).toBe(true);
  });

  it('neither reads nor writes the memo for a call that opts out', () => {
    const keys = new AutoKeys(true);
    keys.key(NS, [1], false, TTL);
    expect(fullPath(() => keys.key(NS, [1], true, TTL))).toBe(true);
    expect(fullPath(() => keys.key(NS, [1], false, TTL))).toBe(true);
    expect(fullPath(() => keys.key(NS, [1], true, TTL))).toBe(false);
  });

  it('memoises nothing unless built to', () => {
    const keys = new AutoKeys(false);
    keys.key(NS, [1], true, TTL);
    expect(fullPath(() => keys.key(NS, [1], true, TTL))).toBe(true);
  });

  it('forgets every entry on forget()', () => {
    const keys = new AutoKeys(true);
    keys.key(NS, [1], true, TTL);
    keys.key(NS, [1, 2], true, TTL);
    keys.forget();
    expect(fullPath(() => keys.key(NS, [1], true, TTL))).toBe(true);
    expect(fullPath(() => keys.key(NS, [1, 2], true, TTL))).toBe(true);
  });

  it.each<[string, (id: string, i: number) => unknown[]]>([
    ['one argument', (id) => [id]],
    ['several arguments', (id, i) => [id, i]],
  ])('keeps no larger string an argument was sliced from: %s', async (_, argsOf) => {
    const keys = new AutoKeys(true);
    const before = heapAfterGc();
    keySlices(keys, argsOf);
    encodes.mockClear(); // the spy's record of each call holds its arguments
    await new Promise((resolve) => setImmediate(resolve));
    // The eight bodies are 32 MiB; the eight entries are a few KiB.
    expect(heapAfterGc() - before).toBeLessThan(4 << 20);
    // And the entries are there, keyed by value.
    const args = argsOf(`000:${'x'.repeat(124)}`, 0);
    const key = generateKey(NS, args);
    expect(fullPath(() => expect(keys.key(NS, args, true, TTL)).toBe(key))).toBe(false);
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
      expect(keys.key(NS, args, true, TTL)).toBe(generateKey(NS, args));
    }
  });

  it('keys a namespace that is not a string as generateKey does, on every call', () => {
    const keys = new AutoKeys(true);
    const hash = generateParamsHash([1]);
    expect(keys.key(42 as unknown as string, [1], true, TTL)).toBe(`42:${hash}`);
    expect(keys.key(undefined as unknown as string, [1], true, TTL)).toBe(`undefined:${hash}`);
    let n = 0;
    const moving = { toString: () => `ns${++n}` } as unknown as string;
    expect(keys.key(moving, [1], true, TTL)).toBe(`ns1:${hash}`);
    expect(keys.key(moving, [1], true, TTL)).toBe(`ns2:${hash}`);
    expect(() => keys.key(Symbol('ns') as unknown as string, [1], true, TTL)).toThrow(TypeError);
  });
});

describe('AutoKeys memo window', () => {
  // Date.now() is the clock L1 expires entries by, and the memo reads it too.
  let clock: number;
  let now: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clock = 1_700_000_000_000;
    now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => {
    now.mockRestore();
  });

  it('serves its entries until one ttl after the first, then empties', () => {
    const keys = new AutoKeys(true);
    keys.key(NS, [1], true, 10);
    clock += 6_000;
    keys.key(NS, [1, 'x'], true, 10); // a later entry does not move the end
    clock += 3_999;
    expect(fullPath(() => keys.key(NS, [1], true, 10))).toBe(false);
    expect(fullPath(() => keys.key(NS, [1, 'x'], true, 10))).toBe(false);
    clock += 1;
    expect(fullPath(() => keys.key(NS, [1, 'x'], true, 10))).toBe(true);
    expect(fullPath(() => keys.key(NS, [1], true, 10))).toBe(true);
  });

  it.each<[string, (keys: AutoKeys) => unknown]>([
    ['an object argument', (keys) => keys.key(NS, [{ id: 1 }], true, 10)],
    ['a call that opts out', (keys) => keys.key(NS, [2], false, 10)],
  ])('empties on any call past its end, even one with %s', (_, call) => {
    const keys = new AutoKeys(true);
    keys.key(NS, [1], true, 10);
    clock += 10_000;
    call(keys);
    // Back inside the old window, an entry the call left behind would serve.
    clock -= 5_000;
    expect(fullPath(() => keys.key(NS, [1], true, 10))).toBe(true);
  });

  it('starts a new window with the first entry after forget()', () => {
    const keys = new AutoKeys(true);
    keys.key(NS, [1], true, 10);
    clock += 5_000;
    keys.forget();
    clock += 1_000;
    keys.key(NS, [1], true, 10);
    clock += 9_999;
    expect(fullPath(() => keys.key(NS, [1], true, 10))).toBe(false);
    clock += 1;
    expect(fullPath(() => keys.key(NS, [1], true, 10))).toBe(true);
  });

  it('starts a new window with the entry that empties a full memo', () => {
    const keys = new AutoKeys(true);
    for (let i = 0; i < 1024; i++) keys.key(NS, [i], true, 10);
    clock += 5_000;
    keys.key(NS, [-1], true, 10);
    clock += 9_999;
    expect(fullPath(() => keys.key(NS, [-1], true, 10))).toBe(false);
    clock += 1;
    expect(fullPath(() => keys.key(NS, [-1], true, 10))).toBe(true);
  });

  it('keeps its entries under a ttl of 0, which never expires, and reads no clock', () => {
    const keys = new AutoKeys(true);
    keys.key(NS, [1], true, 0);
    keys.key(NS, [1, 2], true, 0);
    clock += 10 ** 12;
    expect(fullPath(() => keys.key(NS, [1], true, 0))).toBe(false);
    expect(fullPath(() => keys.key(NS, [1, 2], true, 0))).toBe(false);
    expect(now).not.toHaveBeenCalled();
  });

  it.each([NaN, -1, Infinity])('memoises nothing under a ttl of %s', (ttl) => {
    const keys = new AutoKeys(true);
    for (const args of [[1], [1, 2]]) {
      keys.key(NS, args, true, ttl);
      expect(fullPath(() => keys.key(NS, args, true, ttl))).toBe(true);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import {
  encodeCounted,
  normalize,
  resolveSerializerConfig,
  type SerializerConfig,
} from './serializer.js';
import { ValueTooLargeError } from '../errors.js';

// encodeCounted writes encode(normalize(value)) in one walk. The oracle is that
// two-pass composition, run on the in-tree normalize at test time, so a change
// to normalize that the one-pass path does not follow fails here.

type Outcome =
  { bytes: Uint8Array; objects: number; values: number } | { error: string; message: string };

function twoPass(value: unknown, config: SerializerConfig): Outcome {
  try {
    const walk = { forKey: false, objects: 0, values: 0 };
    const bytes = msgpackEncode(
      normalize(value, 0, config.maxDepth, config.maxCollectionSize, walk)
    );
    if (bytes.length > config.maxEncodedSize) {
      throw new ValueTooLargeError(
        `Encoded size ${bytes.length} exceeds max ${config.maxEncodedSize}`
      );
    }
    return { bytes: bytes.slice(), objects: walk.objects, values: walk.values };
  } catch (e) {
    return { error: (e as Error).constructor.name, message: (e as Error).message };
  }
}

function onePass(value: unknown, config: SerializerConfig): Outcome {
  try {
    const count = { objects: 0, values: 0 };
    const bytes = encodeCounted(value, config, count);
    return { bytes, ...count };
  } catch (e) {
    return { error: (e as Error).constructor.name, message: (e as Error).message };
  }
}

const config = resolveSerializerConfig();

// ES2024 buffer operations, which this lib target does not type.
const detach = (u: Uint8Array) =>
  void structuredClone(u.buffer, { transfer: [u.buffer as ArrayBuffer] });
type Resizable = ArrayBuffer & { resize(length: number): void };
const resizable = (length: number, maxByteLength: number) =>
  new (
    ArrayBuffer as unknown as new (length: number, options: { maxByteLength: number }) => Resizable
  )(length, { maxByteLength });

/** mulberry32: small, seedable, and good enough to spread the cases. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)];
  return { next, int, pick };
}

const NUMBERS = [
  0,
  -0,
  1,
  -1,
  31,
  -32,
  -33,
  127,
  128,
  -128,
  -129,
  255,
  256,
  65535,
  65536,
  -32768,
  -32769,
  2 ** 31 - 1,
  -(2 ** 31),
  -(2 ** 31) - 1,
  2 ** 32 - 1,
  2 ** 32,
  2 ** 40 + 7,
  -(2 ** 40) - 7,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  2 ** 60,
  -(2 ** 60),
  0.5,
  -1.25,
  1e300,
  Number.MIN_VALUE,
  NaN,
  Infinity,
  -Infinity,
];
const STRINGS = [
  '',
  'a',
  'b',
  'B',
  'key',
  'é',
  '日本',
  '😀',
  'x'.repeat(31),
  'x'.repeat(32),
  'x'.repeat(255),
  'y'.repeat(256),
  'é'.repeat(60),
  '\ud800',
  'a\udc00b',
  'z'.repeat(50) + '\ud83d',
  'w'.repeat(49) + '\ud83d',
  'constructor',
  'toString',
  '10',
  '2',
  '01',
  '-1',
  '1.5',
  '4294967295',
];
// Keys that stay in the one-pass path, and the shapes that must go to normalize.
const PLAIN_KEYS = ['a', 'b', 'B', 'key', 'é', '', '01', '-1', '1.5', 'constructor', 'k10', '😀'];
const INDEX_KEYS = ['0', '2', '10', '4294967295', '9007199254740993'];

function generate(r: ReturnType<typeof rng>, depth: number): unknown {
  const leaf = depth > 4 || r.next() < 0.35;
  if (leaf) {
    switch (r.int(14)) {
      case 0:
        return undefined;
      case 1:
        return null;
      case 2:
        return r.next() < 0.5;
      case 3:
      case 4:
        return r.pick(NUMBERS);
      case 5:
        return (r.next() - 0.5) * 10 ** r.int(12);
      case 6:
      case 7:
        return r.pick(STRINGS);
      case 8:
        return Uint8Array.from({ length: r.pick([0, 3, 300]) }, (_, i) => i);
      case 9:
        return Buffer.from([1, 2, 3]).subarray(1);
      case 10:
        return r.pick([new Date(1_700_000_000_000), new Date(NaN)]);
      case 11:
        // Each of these makes both paths throw.
        return r.next() < 0.97
          ? r.pick(STRINGS)
          : r.pick<() => unknown>([
              () => new Int8Array([1]),
              () => new DataView(new ArrayBuffer(2)),
              () => new ArrayBuffer(2),
              () => 1n,
              () => Symbol('s'),
              () => () => 1,
            ])();
      case 12:
        return new Uint8Array(new ArrayBuffer(8), 2, 4);
      default:
        return r.pick(STRINGS);
    }
  }
  const children = () =>
    Array.from({ length: r.pick(depth < 2 ? [0, 1, 3, 16, 17] : [0, 1, 2]) }, () =>
      generate(r, depth + 1)
    );
  switch (r.int(12)) {
    case 0:
    case 1:
    case 2: {
      const obj: Record<string, unknown> = {};
      for (const v of children())
        obj[r.pick(PLAIN_KEYS) + (r.next() < 0.5 ? '' : String(r.int(40)))] = v;
      return obj;
    }
    case 3: {
      const obj: Record<string, unknown> = {};
      for (const v of children()) obj[r.pick([...PLAIN_KEYS, ...INDEX_KEYS])] = v;
      return obj;
    }
    case 4: {
      // An own __proto__ key, as JSON.parse makes one.
      const obj = JSON.parse('{"__proto__": {"x": 1}, "a": 1}') as Record<string, unknown>;
      obj.b = generate(r, depth + 1);
      return obj;
    }
    case 5: {
      const obj: Record<string, unknown> = {};
      const v = generate(r, depth + 1);
      Object.defineProperty(obj, r.pick(PLAIN_KEYS), { get: () => v, enumerable: true });
      Object.defineProperty(obj, 'hidden', { value: 1, enumerable: false });
      obj.z = generate(r, depth + 1);
      return obj;
    }
    case 6:
    case 7:
      return children();
    case 8: {
      // Holey, and with an element getter.
      const arr: unknown[] = new Array(r.int(20));
      for (let i = 0; i < arr.length; i++) if (r.next() < 0.5) arr[i] = generate(r, depth + 1);
      if (arr.length > 0) Object.defineProperty(arr, 0, { get: () => 'g', enumerable: true });
      return arr;
    }
    case 9: {
      // String(key) merges 1 and '1', and a non-string key sorts by its string.
      const keys = [1, '1', 'b', 2, true, null, { o: 1 }];
      return new Map(children().map((v, i) => [keys[i % keys.length], v]));
    }
    case 10:
      return new Set([...children(), r.pick(STRINGS), r.pick(NUMBERS)]);
    default:
      return r.pick<() => unknown>([
        () => Object.assign(Object.create(null), { b: 1, a: [2] }),
        () =>
          new (class Point {
            y = 2;
            x = 1;
          })(),
        () => new String('ab'),
        () => new Number(5),
        () => Object.assign(new (class extends Array {})(), { 0: 1 }),
        () => Object.setPrototypeOf([1, 2], null),
        () => runInNewContext('({ b: [1, { a: new Date(0) }], a: new Map([[1, 2]]) })'),
        () => runInNewContext('[new Uint8Array([1]), [2]]'),
      ])();
  }
}

const hex = (o: Outcome) =>
  'bytes' in o ? { ...o, bytes: Buffer.from(o.bytes).toString('hex') } : o;

describe('encodeCounted one-pass encode', () => {
  it('matches encode(normalize(value)): bytes, L1 counts and errors, on seeded random values', () => {
    const seed = Number(process.env.CACHEKIT_ONE_PASS_SEED ?? (Math.random() * 2 ** 32) >>> 0);
    const r = rng(seed);
    const failures: unknown[] = [];
    let errors = 0;
    for (let i = 0; i < 4000 && failures.length < 3; i++) {
      const value = generate(r, 0);
      const want = twoPass(value, config);
      const got = onePass(value, config);
      if ('error' in want) errors++;
      try {
        expect(hex(got)).toEqual(hex(want));
      } catch {
        failures.push({ case: i, want: hex(want), got: hex(got) });
      }
    }
    // Both outcomes are exercised, not only the happy path.
    expect(errors).toBeGreaterThan(20);
    if (failures.length) {
      throw new Error(
        `one-pass encode diverged; reproduce with CACHEKIT_ONE_PASS_SEED=${seed}\n` +
          JSON.stringify(failures, null, 2)
      );
    }
  });

  it('matches at and past msgpack encode depth of 100 and the configured maxDepth', () => {
    const nest = (levels: number, leaf: unknown, array = false): unknown => {
      let v = leaf;
      for (let i = 0; i < levels; i++) v = array ? [v] : { n: v };
      return v;
    };
    for (const maxDepth of [32, 100, 200, 1024]) {
      const c = resolveSerializerConfig({ maxDepth });
      for (const levels of [31, 32, 33, 98, 99, 100, 101, 150, 199, 200, 201]) {
        // Holes: [<hole>, 1], and [<hole>] alone, whose depth only encode() checks.
        const holey = Object.assign(new Array(2), { 1: 1 });
        for (const leaf of [
          1,
          undefined,
          new Map([[1, 2]]),
          new Date(0),
          holey,
          new Array(1),
          {},
          1n,
        ]) {
          for (const array of [false, true]) {
            const value = nest(levels, leaf, array);
            expect(hex(onePass(value, c)), `maxDepth ${maxDepth} levels ${levels}`).toEqual(
              hex(twoPass(value, c))
            );
          }
        }
      }
    }
  });

  it('lets a normalize error later in the walk win over an earlier encode error', () => {
    // msgpack's "Unrecognized object" at a, normalize's binary rule at b
    const value = { a: () => 1, b: new Int8Array(1), c: 1n };
    const got = onePass(value, config);
    expect(got).toEqual(twoPass(value, config));
    expect(got).toMatchObject({ error: 'SerializationError' });
    // With no normalize error the first encode error is thrown.
    expect(onePass({ a: Symbol('x'), b: 1n }, config)).toEqual({
      error: 'Error',
      message: 'Unrecognized object: [object Symbol]',
    });
  });

  describe('errors: same class and message as normalize + encode', () => {
    const small = resolveSerializerConfig({ maxCollectionSize: 3, maxEncodedSize: 64 });
    const cases: [string, unknown, SerializerConfig][] = [
      [
        'depth',
        JSON.parse('{"a":'.repeat(40) + '1' + '}'.repeat(40)),
        resolveSerializerConfig({ maxDepth: 32 }),
      ],
      ['array size', [1, 2, 3, 4], small],
      ['nested array size', { a: [1, 2, 3, 4] }, small],
      [
        'Map size',
        new Map([
          [1, 1],
          [2, 2],
          [3, 3],
          [4, 4],
        ]),
        small,
      ],
      ['Set size', { s: new Set([1, 2, 3, 4]) }, small],
      ['object key count', { a: 1, b: 2, c: 3, d: 4 }, small],
      ['Int8Array', { v: new Int8Array([1]) }, config],
      ['DataView', [new DataView(new ArrayBuffer(1))], config],
      ['ArrayBuffer', new ArrayBuffer(1), config],
      ['maxEncodedSize', 'x'.repeat(100), small],
      ['maxEncodedSize, object', { a: 'x'.repeat(40), b: 'y'.repeat(40) }, small],
    ];
    for (const [name, value, c] of cases) {
      it(name, () => {
        const want = twoPass(value, c);
        expect(want).toHaveProperty('error');
        expect(onePass(value, c)).toEqual(want);
      });
    }
  });

  it('hands Map, own __proto__ and index-like keys to normalize', () => {
    // normalize orders these as the engine does, so the bytes show who encoded them.
    for (const value of [
      { 10: 'a', 2: 'b', x: 'c' },
      { '4294967295': 1, '0': 2 },
      JSON.parse('{"b": 1, "__proto__": {"x": 1}, "a": 2}'),
      new Map<unknown, unknown>([
        [2, 'a'],
        ['10', 'b'],
        [{}, 'c'],
      ]),
    ]) {
      expect(hex(onePass(value, config))).toEqual(hex(twoPass(value, config)));
    }
  });

  it('reads each own property, element and getter once per encode', () => {
    let reads = 0;
    const counted = <T>(v: T) => ({
      get: () => {
        reads++;
        return v;
      },
      enumerable: true,
    });
    const inner = Object.defineProperty({ a: 1 }, 'g', counted('inner'));
    const arr = Object.defineProperty([1, 2, 3], 1, counted({ x: 1 }));
    const value = Object.defineProperties(
      {},
      { b: counted(inner), c: counted(arr), d: counted(5) }
    );
    encodeCounted(value, config);
    expect(reads).toBe(5);
    reads = 0;
    encodeCounted(value, config);
    expect(reads).toBe(5);
  });

  describe('user code that runs later in the walk', () => {
    // Each case builds two fresh values, since its getters change state.
    const same = (make: () => unknown, c = config) =>
      expect(hex(onePass(make(), c))).toEqual(hex(twoPass(make(), c)));
    const later = (get: () => unknown) => ({ get, enumerable: true });

    it('sees a Uint8Array as encode() read it, after normalize', () => {
      same(() => {
        const u = Uint8Array.of(1, 2, 3);
        return Object.defineProperty(
          { a: u },
          'b',
          later(() => ((u[0] = 99), 1))
        );
      });
      // inside a Map, which normalize copies
      same(() => {
        const u = Uint8Array.of(1, 2, 3);
        return Object.defineProperty(
          { a: new Map([['k', u]]) },
          'b',
          later(() => ((u[1] = 7), 1))
        );
      });
      // detached, then a later encode() error: the detached read throws first
      same(() => {
        const u = Uint8Array.of(1, 2, 3);
        return Object.defineProperty(
          { a: u },
          'b',
          later(() => (detach(u), () => 1))
        );
      });
      // encode() stops at its first error, so it never reads a binary after it
      same(() => {
        const u = Uint8Array.of(1, 2, 3);
        return Object.defineProperty(
          { a: () => 1, b: u },
          'c',
          later(() => (detach(u), 1))
        );
      });
      same(() => {
        const ab = resizable(4, 8);
        const u = new Uint8Array(ab, 0, 4);
        return Object.defineProperty(
          { a: u },
          'b',
          later(() => (ab.resize(1), 1))
        );
      });
    });

    it('makes encode() error messages only for the error thrown, when it is thrown', () => {
      let tags = 0;
      const tagged = () =>
        Object.defineProperty(() => 1, Symbol.toStringTag, {
          get: () => (tags++, 'Tagged'),
        });
      same(() => ({ a: tagged(), b: tagged() }));
      tags = 0;
      onePass({ a: tagged(), b: tagged() }, config);
      expect(tags).toBe(1);
      // normalize's error wins, and no message is made for the function
      tags = 0;
      same(() => ({ a: tagged(), b: new ArrayBuffer(1) }));
      onePass({ a: tagged(), b: new ArrayBuffer(1) }, config);
      expect(tags).toBe(0);
      // a later getter changes the tag the message reads
      same(() => {
        const f = tagged();
        return Object.defineProperty(
          { a: f },
          'b',
          later(() => (Object.defineProperty(f, Symbol.toStringTag, { value: 'Changed' }), 1))
        );
      });
    });

    it('reads an array constructor, an own map and a toStringTag as often as normalize', () => {
      let reads = 0;
      const count = <T>(v: T) => later(() => (reads++, v));
      const cases: [() => object, number][] = [
        [() => Object.defineProperty([1, 2], 'constructor', count(undefined)), 1],
        [() => Object.defineProperty([1, 2], 'map', count(Array.prototype.map)), 1],
        [() => Object.defineProperty({ 0: 1, a: 2 }, Symbol.toStringTag, count('T')), 1],
        [
          () => Object.defineProperty(new ArrayBuffer(1), Symbol.toStringTag, count('ArrayBuffer')),
          1,
        ],
      ];
      for (const [make, want] of cases) {
        same(make);
        reads = 0;
        onePass(make(), config);
        expect(reads).toBe(want);
      }
      // an own map that is not Array.prototype.map is called, as normalize calls it
      same(() => Object.assign([1, 2], { map: () => 'x' }));
      // a tag getter that adds a key each time it runs
      same(() => {
        const o: Record<string, number> = { 0: 1 };
        let n = 0;
        return Object.defineProperty(o, Symbol.toStringTag, {
          get: () => ((o[`k${n++}`] = n), 'T'),
        });
      });
    });
  });

  describe('the reused buffer', () => {
    it('never changes bytes it returned earlier', () => {
      const first = encodeCounted({ a: 'first', n: [1, 2, 3] }, config);
      const snapshot = first.slice();
      // Grows the buffer past its initial size, then past the retain limit.
      encodeCounted({ big: 'x'.repeat(10_000) }, config);
      encodeCounted(
        { big: 'y'.repeat(1_000_000) },
        resolveSerializerConfig({ maxEncodedSize: 2 ** 21 })
      );
      encodeCounted({ b: 'second' }, config);
      expect(first).toEqual(snapshot);
      expect(first.byteOffset).toBe(0);
      expect(first.buffer.byteLength).toBe(first.length);
    });

    it('encodes correctly after an encode that threw part-way', () => {
      const value = { a: 'a'.repeat(3000), b: 1 };
      const want = twoPass(value, config);
      const throwing = Object.defineProperty({ a: 'x'.repeat(5000) }, 'b', {
        get: () => {
          throw new RangeError('getter');
        },
        enumerable: true,
      });
      expect(() => encodeCounted(throwing, config)).toThrow(RangeError);
      expect(() => encodeCounted({ a: 1, z: 1n }, config)).toThrow('Unrecognized object');
      expect(hex(onePass(value, config))).toEqual(hex(want));
    });

    it('serves a re-entrant encode (a getter that writes) without corrupting either', () => {
      const innerValue = { inner: 'i'.repeat(100), n: [1, 2] };
      let inner: Uint8Array | undefined;
      const outerValue = Object.defineProperty({ a: 'o'.repeat(100) }, 'b', {
        get: () => {
          inner = encodeCounted(innerValue, config);
          return 'after';
        },
        enumerable: true,
      });
      const outer = encodeCounted(outerValue, config);
      expect(hex(onePass(innerValue, config))).toEqual(hex(twoPass(innerValue, config)));
      expect(Buffer.from(inner!).toString('hex')).toBe(
        Buffer.from((twoPass(innerValue, config) as { bytes: Uint8Array }).bytes).toString('hex')
      );
      expect(Buffer.from(outer).toString('hex')).toBe(
        Buffer.from(msgpackEncode({ a: 'o'.repeat(100), b: 'after' })).toString('hex')
      );
    });
  });
});

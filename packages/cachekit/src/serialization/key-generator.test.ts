import { describe, it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { Encoder } from '@msgpack/msgpack';
import { ValueTooLargeError } from '../errors.js';
import { generateKey, generateParamsHash, extractNamespace } from './key-generator.js';
import {
  FULL_PATH_KEYS,
  MEMOISABLE_KEYS,
  PINNED_NAMESPACE,
} from '../../test/fixtures/auto-mode-keys.js';

/** The key for a single binary or object argument. */
const key = (arg: object) => generateKey('test', [arg]);

describe('generateKey', () => {
  it('generates consistent keys for same input', () => {
    const key1 = generateKey('test:fn', [1, 2, 3]);
    const key2 = generateKey('test:fn', [1, 2, 3]);
    expect(key1).toBe(key2);
  });

  it('generates different keys for different inputs', () => {
    const key1 = generateKey('test:fn', [1, 2, 3]);
    const key2 = generateKey('test:fn', [1, 2, 4]);
    expect(key1).not.toBe(key2);
  });

  it('includes namespace in key', () => {
    const key = generateKey('my-service:myFunction', []);
    expect(key.startsWith('my-service:myFunction:')).toBe(true);
  });

  it('produces 64-char hex hash', () => {
    const key = generateKey('test', [1]);
    const hash = key.split(':').pop()!;
    expect(hash.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('handles complex nested arguments', () => {
    const args = [{ nested: { deep: { value: [1, 2, 3] } } }];
    const key = generateKey('test', args);
    expect(key).toBeTruthy();
  });

  it('is deterministic with object key order', () => {
    const key1 = generateKey('test', [{ b: 2, a: 1 }]);
    const key2 = generateKey('test', [{ a: 1, b: 2 }]);
    expect(key1).toBe(key2); // Object keys are sorted
  });

  it('hashes a Uint8Array argument as msgpack bin, not as an index map', () => {
    const bin = generateKey('test', [Uint8Array.of(1, 2, 3)]);
    expect(bin).not.toBe(generateKey('test', [{ 0: 1, 1: 2, 2: 3 }]));
    expect(generateKey('test', [Buffer.from([1, 2, 3])])).toBe(bin);
    // Past maxCollectionSize (10,000), which used to throw.
    expect(() => generateKey('test', [new Uint8Array(20_000)])).not.toThrow();
  });

  it('hashes any other binary argument by its type and bytes', () => {
    expect(key(new Float32Array([1.5, -2]))).toBe(key(Float32Array.of(1.5, -2)));
    expect(key(new Float32Array([1.5]))).not.toBe(key(new Float32Array([2.5])));
    // Same bytes, different type: distinct keys.
    expect(key(Int8Array.of(-1))).not.toBe(key(Uint8Array.of(255)));
    expect(key(Uint8Array.of(1).buffer)).not.toBe(key(Uint8Array.of(1)));
    // Every ArrayBuffer, SharedArrayBuffer and DataView used to hash as {}, so
    // distinct buffers shared one key.
    const sab = (b: number) => {
      const buf = new SharedArrayBuffer(1);
      new Uint8Array(buf)[0] = b;
      return buf;
    };
    expect(key(Uint8Array.of(1).buffer)).not.toBe(key(Uint8Array.of(2).buffer));
    expect(key(new DataView(Uint8Array.of(1).buffer))).not.toBe(
      key(new DataView(Uint8Array.of(2).buffer))
    );
    expect(key(sab(1))).not.toBe(key(sab(2)));
    expect(key(runInNewContext('Uint8Array.of(1).buffer'))).toBe(key(Uint8Array.of(1).buffer));
    // The brand decides, not Symbol.toStringTag: a plain object tagged as a
    // buffer hashes by its keys, not as one shared empty buffer.
    const tagged = (a: number) =>
      Object.defineProperty({ a }, Symbol.toStringTag, { value: 'ArrayBuffer' });
    expect(key(tagged(1))).not.toBe(key(tagged(2)));
  });

  it('hashes a detached binary argument as empty instead of throwing', () => {
    const detached = <T extends object>(view: (buf: ArrayBuffer) => T): T => {
      const buf = new ArrayBuffer(4);
      const result = view(buf);
      structuredClone(buf, { transfer: [buf] });
      return result;
    };
    expect(key(detached((buf) => buf))).toBe(key(new ArrayBuffer(0)));
    expect(key(detached((buf) => new Uint8Array(buf)))).toBe(key(new Uint8Array(0)));
    expect(key(detached((buf) => new DataView(buf)))).toBe(key(new DataView(new ArrayBuffer(0))));
  });

  it('keys a large non-Uint8Array binary argument by digest, without throwing', () => {
    // A request body well past the 64 KiB key limit: main hashed it as {}.
    const big = (b: number) => {
      const buf = new ArrayBuffer(1 << 20);
      new Uint8Array(buf)[(1 << 20) - 1] = b;
      return buf;
    };
    expect(() => key(big(1))).not.toThrow();
    expect(key(big(1))).toBe(key(big(1)));
    expect(key(big(1))).not.toBe(key(big(2)));
    expect(key(new DataView(big(1)))).not.toBe(key(new DataView(big(2))));
    // main gave these distinct keys; hashing raw bytes would exceed 64 KiB.
    expect(() => key(new Float64Array(10_000).fill(0.5))).not.toThrow();
  });

  it('hashes an object whose tag read throws by its keys', () => {
    const strict = new Proxy(
      { a: 1 },
      {
        get(target, prop) {
          if (!(prop in target)) throw new Error(`unknown prop ${String(prop)}`);
          return Reflect.get(target, prop);
        },
      }
    );
    expect(key(strict)).toBe(key({ a: 1 }));
    const throwingTag = Object.defineProperty({ a: 1 }, Symbol.toStringTag, {
      get() {
        throw new Error('no tag');
      },
    });
    expect(key(throwingTag)).toBe(key({ a: 1 }));
  });

  it('never gives a binary argument the key of an ordinary object', () => {
    expect(key(Int8Array.of(-1))).not.toBe(key({ Int8Array: Uint8Array.of(255) }));
    expect(key(Int8Array.of(-1))).not.toBe(key({ Int8Array: Int8Array.of(-1) }));
    expect(key(new ArrayBuffer(1))).not.toBe(key({ ArrayBuffer: new Uint8Array(1) }));
  });

  it('reads binary bytes from internal slots, not shadowable properties', () => {
    const shadowed = Object.defineProperty(Uint8Array.of(1, 2, 3), 'byteLength', { value: 0 });
    expect(key(shadowed)).toBe(key(Uint8Array.of(1, 2, 3)));
    const retagged = (b: number) =>
      Object.defineProperty(Uint8Array.of(b).buffer, Symbol.toStringTag, { value: 'Object' });
    expect(key(retagged(1))).not.toBe(key(retagged(2)));
    // lib types ArrayBuffer's toStringTag as the literal 'ArrayBuffer'.
    class Tagged extends ArrayBuffer {}
    Object.defineProperty(Tagged.prototype, Symbol.toStringTag, { value: 'Tagged' });
    expect(key(new Tagged(1))).toBe(key(new ArrayBuffer(1)));
  });

  it('keeps non-binary keys byte-identical to earlier releases', () => {
    // Pinned from main before binary support: changing it orphans every
    // existing cache entry.
    const args = [
      ...[1, -0, 1.5, -7, 2 ** 53, 'héllo', '', true, false, null, undefined],
      [1, [2, [3]]],
      { b: 2, a: { d: [1], c: null }, Int8Array: 'x' },
      new Date(0),
      new Map<unknown, unknown>([
        ['b', 1],
        ['a', { z: 1 }],
      ]),
      new Set([3, 1, 2]),
    ];
    expect(generateKey('test', args)).toBe(
      'test:0c0e00c359985743c94e25e7898c35885ee325a08553315d6f79c1f8ab39fc24'
    );
  });

  describe.each([
    ['memoisable', MEMOISABLE_KEYS],
    ['full-path', FULL_PATH_KEYS],
  ])('keeps the pinned %s keys', (_, corpus) => {
    it.each(corpus)('$name', ({ args, key }) => {
      expect(generateKey(PINNED_NAMESPACE, [...args])).toBe(key);
      expect(generateParamsHash([...args])).toBe(key.slice(PINNED_NAMESPACE.length + 1));
    });
  });

  it.each([
    ['without', undefined],
    [
      'with',
      function (this: Uint8Array) {
        return Array.from(this, (b) => b.toString(16).padStart(2, '0')).join('');
      },
    ],
  ])('keeps the pinned keys %s a native Uint8Array.prototype.toHex', async (_, toHex) => {
    const proto = Uint8Array.prototype as { toHex?: unknown };
    const native = Object.getOwnPropertyDescriptor(proto, 'toHex');
    delete proto.toHex;
    if (toHex) proto.toHex = toHex;
    try {
      vi.resetModules();
      const fresh = await import('./key-generator.js');
      for (const { args, key } of [...MEMOISABLE_KEYS, ...FULL_PATH_KEYS]) {
        expect(fresh.generateKey(PINNED_NAMESPACE, [...args])).toBe(key);
      }
    } finally {
      delete proto.toHex;
      if (native) Object.defineProperty(proto, 'toHex', native);
    }
  });

  it('keeps rejecting bigint, symbol and function arguments', () => {
    for (const arg of [1n, Symbol('s'), () => 1]) {
      expect(() => generateKey(PINNED_NAMESPACE, [arg])).toThrow(/^Unrecognized object/);
    }
  });
});

describe('the shared key encoder', () => {
  /** Each encodeSharedRef call's encoder and the bytes it handed back. */
  const recordEncodes = () => {
    const calls: { encoder: Encoder; bytes: Uint8Array }[] = [];
    const real = Encoder.prototype.encodeSharedRef;
    const spy = vi.spyOn(Encoder.prototype, 'encodeSharedRef').mockImplementation(function (
      this: Encoder,
      value: unknown
    ) {
      const bytes = real.call(this, value);
      calls.push({ encoder: this, bytes });
      return bytes;
    });
    return { calls, restore: () => spy.mockRestore() };
  };
  const zeroed = (bytes: Uint8Array) => bytes.every((b) => b === 0);

  it('wipes the bytes it wrote once they are hashed', () => {
    const { calls, restore } = recordEncodes();
    try {
      generateKey('test', ['secret-argument', 42]);
      expect(calls).toHaveLength(1);
      expect(calls[0].bytes.length).toBeGreaterThan(0);
      expect(zeroed(new Uint8Array(calls[0].bytes.buffer))).toBe(true);
    } finally {
      restore();
    }
  });

  it('is reused while it keeps its size, and replaced once an argument grows it', () => {
    const { calls, restore } = recordEncodes();
    try {
      generateKey('test', [1]);
      generateKey('test', [2]);
      generateKey('test', ['x'.repeat(5_000)]);
      generateKey('test', [3]);
      const [first, second, big, after] = calls;
      expect(second.encoder).toBe(first.encoder);
      expect(big.encoder).toBe(first.encoder);
      expect(big.bytes.buffer.byteLength).toBeGreaterThan(2048);
      expect(zeroed(new Uint8Array(big.bytes.buffer))).toBe(true);
      expect(after.encoder).not.toBe(first.encoder);
      expect(after.bytes.buffer.byteLength).toBe(2048);
    } finally {
      restore();
    }
  });

  it('is replaced when the arguments fail to encode or exceed the key size limit', () => {
    const { calls, restore } = recordEncodes();
    try {
      generateKey('test', [1]);
      expect(() => generateKey('test', ['partial', 1n])).toThrow(/^Unrecognized object/);
      generateKey('test', [2]);
      expect(() => generateKey('test', ['x'.repeat(70_000)])).toThrow(ValueTooLargeError);
      generateKey('test', [3]);
      const encoders = calls.map((c) => c.encoder);
      // The failed encode returned nothing, so it has no entry.
      expect(encoders).toHaveLength(4);
      expect(encoders[1]).not.toBe(encoders[0]);
      expect(encoders[3]).not.toBe(encoders[2]);
      expect(zeroed(new Uint8Array(calls[2].bytes.buffer))).toBe(true);
      for (const { args, key } of MEMOISABLE_KEYS) {
        expect(generateKey(PINNED_NAMESPACE, [...args])).toBe(key);
      }
    } finally {
      restore();
    }
  });
});

describe('generateParamsHash', () => {
  it('returns 64-char hex string', () => {
    const hash = generateParamsHash([1, 2, 3]);
    expect(hash.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('matches hash portion of generateKey', () => {
    const args = [1, 2, 3];
    const fullKey = generateKey('test', args);
    const paramsHash = generateParamsHash(args);
    expect(fullKey.endsWith(paramsHash)).toBe(true);
  });
});

describe('extractNamespace', () => {
  it('extracts namespace from valid key', () => {
    const hash = 'a'.repeat(64);
    const key = `my-service:getUser:${hash}`;
    expect(extractNamespace(key)).toBe('my-service:getUser');
  });

  it('handles namespaces with colons', () => {
    const hash = 'b'.repeat(64);
    const key = `a:b:c:${hash}`;
    expect(extractNamespace(key)).toBe('a:b:c');
  });

  it('returns original key if no hash', () => {
    expect(extractNamespace('no-hash')).toBe('no-hash');
  });
});

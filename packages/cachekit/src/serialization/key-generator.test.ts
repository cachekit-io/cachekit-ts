import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { generateKey, generateParamsHash, extractNamespace } from './key-generator.js';

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

  it('hashes a Uint8Array argument as msgpack bin, not as an index map (LAB-4839)', () => {
    const bin = generateKey('test', [Uint8Array.of(1, 2, 3)]);
    expect(bin).not.toBe(generateKey('test', [{ 0: 1, 1: 2, 2: 3 }]));
    expect(generateKey('test', [Buffer.from([1, 2, 3])])).toBe(bin);
    // Past maxCollectionSize (10,000), which used to throw.
    expect(() => generateKey('test', [new Uint8Array(20_000)])).not.toThrow();
  });

  it('hashes any other binary argument by its type and bytes (LAB-4839)', () => {
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

  it('hashes a detached binary argument as empty instead of throwing (LAB-4839)', () => {
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

  it('never gives a binary argument the key of an ordinary object (LAB-4839)', () => {
    expect(key(Int8Array.of(-1))).not.toBe(key({ Int8Array: Uint8Array.of(255) }));
    expect(key(Int8Array.of(-1))).not.toBe(key({ Int8Array: Int8Array.of(-1) }));
    expect(key(new ArrayBuffer(1))).not.toBe(key({ ArrayBuffer: new Uint8Array(1) }));
  });

  it('reads binary bytes from internal slots, not shadowable properties (LAB-4839)', () => {
    const shadowed = Object.defineProperty(Uint8Array.of(1, 2, 3), 'byteLength', { value: 0 });
    expect(key(shadowed)).toBe(key(Uint8Array.of(1, 2, 3)));
    const retagged = (b: number) =>
      Object.defineProperty(Uint8Array.of(b).buffer, Symbol.toStringTag, { value: 'Object' });
    expect(key(retagged(1))).not.toBe(key(retagged(2)));
    class Tagged extends ArrayBuffer {
      get [Symbol.toStringTag]() {
        return 'Tagged';
      }
    }
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

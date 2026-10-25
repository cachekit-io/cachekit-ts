/**
 * Cache-key hashing — Workers lane
 *
 * Keys hash in JS until the wasm module is instantiated, then through the wasm
 * binding's blake2b256Hex; every pinned key must come out byte for byte the
 * same either way. Inside real workerd, on the wasm32 build. The tests run in
 * order: the first must see the module not yet instantiated.
 */

import { describe, it, expect } from 'vitest';
import { blake2b256Hex as wasmBlake2b256Hex, initSync } from '@cachekit-io/cachekit-core-wasm';
import { createCache } from '../../src/workers/index.js';
import { generateKey } from '../../src/serialization/key-generator.js';
import { generateInteropKey } from '../../src/serialization/interop.js';
import { usingKeyHashBinding } from '../../src/serialization/blake2b.js';
import { FULL_PATH_KEYS, MEMOISABLE_KEYS, PINNED_NAMESPACE } from '../fixtures/auto-mode-keys.js';
import { InMemoryBackend } from '../fixtures/metrics.js';
import { hexToBytes } from '../fixtures/wire-vectors.js';
import interop from '../protocol/fixtures/interop-mode.json' with { type: 'json' };

const PINNED = [...MEMOISABLE_KEYS, ...FULL_PATH_KEYS];
/** ['x' * 65,537] as interop args: past the wasm limit. Python's hashlib agrees. */
const LONG_INTEROP_KEY = 'ns1:op:e8896cc5d4fe161cabdfd093b47a70d4b65ea03e05871cf61a3b458f1349a126'; // pragma: allowlist secret

/**
 * The wasm instance's linear memory. Once the module is instantiated, initSync
 * returns the live instance's exports without reading its argument.
 */
function wasmBuffer(): ArrayBuffer {
  const live: unknown = initSync({ module: new Uint8Array(0) });
  const buffer =
    typeof live === 'object' && live !== null && 'memory' in live
      ? (live.memory as { buffer?: unknown } | undefined)?.buffer
      : undefined;
  if (!(buffer instanceof ArrayBuffer)) throw new Error('no live wasm instance');
  return buffer;
}

/** Whether `needle` occurs anywhere in `haystack`. */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe('cache-key hashing on Workers', () => {
  it('hashes in JS while no cache has needed the wasm module', () => {
    // Compression off and no encryption: nothing instantiates the module.
    createCache({ backend: new InMemoryBackend(), compression: false });
    expect(usingKeyHashBinding()).toBe(false);
    for (const { args, key } of PINNED) expect(generateKey(PINNED_NAMESPACE, [...args])).toBe(key);
  });

  it('hashes through wasm once a cache instantiates the module', () => {
    createCache({ backend: new InMemoryBackend() });
    expect(usingKeyHashBinding()).toBe(true);
    for (const { args, key } of PINNED) expect(generateKey(PINNED_NAMESPACE, [...args])).toBe(key);
    expect(generateInteropKey('ns1', 'op', ['x'.repeat(64 * 1024 + 1)])).toBe(LONG_INTEROP_KEY);
  });

  it.each(interop.key_vectors.map((v) => [v.name, v] as const))(
    'wasm blake2b256Hex gives interop vector %s its args_hash',
    (_, vector) => {
      expect(wasmBlake2b256Hex(hexToBytes(vector.canonical_args_hex))).toBe(vector.args_hash);
    }
  );

  it('hashes only the bytes a view covers', () => {
    const backing = new Uint8Array(64).fill(0xc1);
    const view = backing.subarray(7, 52);
    view.set(Uint8Array.from({ length: 45 }, (_, i) => i));
    expect(wasmBlake2b256Hex(view)).toBe(wasmBlake2b256Hex(view.slice()));
    expect(wasmBlake2b256Hex(view)).not.toBe(wasmBlake2b256Hex(backing));
  });

  it('wipes its copy of the input from wasm memory', () => {
    // A marker past the first 32 bytes (a freed chunk's allocator header may
    // overwrite those) and outside the last block (the hasher's own buffer).
    const input = new Uint8Array(1024);
    const marker = Uint8Array.from({ length: 48 }, (_, i) => (i * 37 + 11) & 255);
    input.set(marker, 64);
    wasmBlake2b256Hex(input);
    expect(contains(new Uint8Array(wasmBuffer()), marker)).toBe(false);
  });

  it('never copies a binary key argument past the key size limit into wasm memory', () => {
    const before = wasmBuffer().byteLength;
    const big = new ArrayBuffer(before + (1 << 20));
    generateKey(PINNED_NAMESPACE, [big]);
    expect(wasmBuffer().byteLength).toBe(before);
    // The control: the same bytes through the binding directly do grow it.
    wasmBlake2b256Hex(new Uint8Array(big));
    expect(wasmBuffer().byteLength).toBeGreaterThan(before);
  });
});

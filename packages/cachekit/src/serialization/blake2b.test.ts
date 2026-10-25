import { afterEach, describe, expect, it, vi } from 'vitest';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as napi from '@cachekit-io/cachekit-core-ts';
import { blake2b256, blake2b256Hex, setKeyHashBinding, usingKeyHashBinding } from './blake2b.js';
import { generateKey } from './key-generator.js';
import { setLogger } from '../logger.js';
import { FULL_PATH_KEYS, PINNED_NAMESPACE } from '../../test/fixtures/auto-mode-keys.js';

const reference = (data: Uint8Array) => bytesToHex(blake2b(data, { dkLen: 32 }));
const filled = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 255);

/** Inputs around BLAKE2b's 128-byte block, plus empty and large. */
const INPUTS = [0, 1, 4, 45, 127, 128, 129, 256, 257, 1024, 64 * 1024 + 1].map(filled);

afterEach(() => {
  setKeyHashBinding(undefined);
  setLogger(null);
});

describe('the NAPI blake2b256Hex', () => {
  it.each(INPUTS.map((input) => [input.length, input] as const))(
    'matches @noble/hashes for %i bytes',
    (_, input) => {
      expect(napi.blake2b256Hex(input)).toBe(reference(input));
    }
  );

  it('hashes only the bytes a view covers, not the rest of its buffer', () => {
    // Guard bytes either side: a binding that ignored byteOffset or length
    // would hash them too.
    const backing = new Uint8Array(64).fill(0xc1);
    backing.set(filled(45), 7);
    const view = backing.subarray(7, 52);
    expect(napi.blake2b256Hex(view)).toBe(reference(filled(45)));
    expect(napi.blake2b256Hex(Buffer.from(filled(45)))).toBe(reference(filled(45)));
  });
});

describe('setKeyHashBinding', () => {
  it('hashes in JS until a binding is set', () => {
    expect(usingKeyHashBinding()).toBe(false);
    expect(blake2b256Hex(filled(45))).toBe(reference(filled(45)));
  });

  it('routes both digests through the binding once it passes the self-test', () => {
    const hash = vi.fn(napi.blake2b256Hex);
    setKeyHashBinding(hash);
    expect(usingKeyHashBinding()).toBe(true);
    hash.mockClear();
    for (const input of INPUTS) {
      expect(blake2b256Hex(input)).toBe(reference(input));
      expect(bytesToHex(blake2b256(input))).toBe(reference(input));
    }
    expect(hash).toHaveBeenCalledTimes(2 * INPUTS.length);
  });

  it('goes back to JS when set to undefined, as from an older binding without the export', () => {
    const log = vi.fn();
    setLogger(log);
    setKeyHashBinding(napi.blake2b256Hex);
    setKeyHashBinding(undefined);
    expect(usingKeyHashBinding()).toBe(false);
    expect(blake2b256Hex(filled(45))).toBe(reference(filled(45)));
    expect(log).not.toHaveBeenCalled();
  });

  it('reports a binding with the wrong digest and never uses it', () => {
    const log = vi.fn();
    setLogger(log);
    const wrong = vi.fn(() => '0'.repeat(64));
    setKeyHashBinding(wrong);
    expect(usingKeyHashBinding()).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/wrong self-test digest \(0{64}\)/),
      undefined
    );
    expect(blake2b256Hex(filled(45))).toBe(reference(filled(45)));
    expect(wrong).toHaveBeenCalledTimes(1);
  });

  it('reports a binding that throws on the self-test and never uses it', () => {
    const log = vi.fn();
    setLogger(log);
    const failure = new Error('no wasm');
    setKeyHashBinding(() => {
      throw failure;
    });
    expect(usingKeyHashBinding()).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/failed its self-test/), failure);
  });

  it('drops a binding that throws in use, reports it once, and answers in JS', () => {
    const log = vi.fn();
    setLogger(log);
    let broken = false;
    const failure = new Error('out of memory');
    setKeyHashBinding((data) => {
      if (broken) throw failure;
      return napi.blake2b256Hex(data);
    });
    broken = true;
    expect(blake2b256Hex(filled(45))).toBe(reference(filled(45)));
    expect(bytesToHex(blake2b256(filled(4)))).toBe(reference(filled(4)));
    expect(usingKeyHashBinding()).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/hashed in JS from now on/), failure);
  });

  it('keys the failing call right when the logger makes a key of its own', () => {
    // The failing call's input is a view of the shared key encoder's buffer,
    // which a key made inside the logger would overwrite.
    const { args, key } = FULL_PATH_KEYS.find((k) => k.name === 'the Ir suite arguments')!;
    setLogger(() => void generateKey('logger', ['an alert', { id: 1 }]));
    let broken = false;
    setKeyHashBinding((data) => {
      if (broken) throw new Error('out of memory');
      return napi.blake2b256Hex(data);
    });
    broken = true;
    expect(generateKey(PINNED_NAMESPACE, [...args])).toBe(key);
  });
});

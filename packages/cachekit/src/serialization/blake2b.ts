import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { logError } from '../logger.js';
import { CACHE_KEY_HASH_LENGTH } from '../constants.js';

/**
 * A binding's cache-key hash: unkeyed BLAKE2b-256 of `data`, as 64 lowercase
 * hex characters.
 */
export type Blake2b256Hex = (data: Uint8Array) => string;

const HEX_DIGITS = new TextEncoder().encode('0123456789abcdef');
const hexBytes = new Uint8Array(CACHE_KEY_HASH_LENGTH);
const hexDecoder = new TextDecoder();
const nativeHex = typeof (Uint8Array.prototype as { toHex?: unknown }).toHex === 'function';

/**
 * Lowercase hex of a 32-byte digest, as one string. Without a native
 * Uint8Array.prototype.toHex (Node.js 24 and earlier), bytesToHex appends two
 * digits at a time, and V8 keeps every intermediate string inside the result:
 * about 800 bytes more for each key that L1 or a key memo holds.
 */
function digestHex(digest: Uint8Array): string {
  if (nativeHex) return bytesToHex(digest);
  for (let i = 0; i < digest.length; i++) {
    hexBytes[2 * i] = HEX_DIGITS[digest[i] >> 4];
    hexBytes[2 * i + 1] = HEX_DIGITS[digest[i] & 15];
  }
  return hexDecoder.decode(hexBytes);
}

/** The cache-key hash in JS (@noble/hashes): what keys use without a binding. */
export function nobleBlake2b256Hex(data: Uint8Array): string {
  return digestHex(blake2b(data, { dkLen: 32 }));
}

/**
 * A binding must reproduce this digest before keys use it. The input is two
 * full BLAKE2b blocks and one byte, so the check runs a compression of a full
 * block as well as the final one.
 */
const SELF_TEST_INPUT_LENGTH = 257;
const SELF_TEST_DIGEST = '45f7f084c30bac7cbae2e1963bc6e6b0d8cb227a12927e97fb941d288fb1f9a3'; // pragma: allowlist secret

/** The binding keys are hashed with, or undefined to hash them in JS. */
let binding: Blake2b256Hex | undefined;

/**
 * Hash cache keys with a binding's BLAKE2b-256 from now on, or in JS again
 * with `undefined`. Each runtime entry calls it once its binding is loaded:
 * the Node entry as it is imported, the Workers entry when the wasm module is
 * first instantiated. Either path gives every key the same bytes.
 *
 * A binding that gets the self-test digest wrong, or throws on it, is
 * reported and never used. A function an older binding lacks arrives as
 * undefined and leaves keys in JS, which is not an error.
 */
export function setKeyHashBinding(hash: Blake2b256Hex | undefined): void {
  binding = undefined;
  if (typeof hash !== 'function') return;
  const input = Uint8Array.from({ length: SELF_TEST_INPUT_LENGTH }, (_, i) => i & 255);
  try {
    const digest = hash(input);
    if (digest === SELF_TEST_DIGEST) {
      binding = hash;
      return;
    }
    logError(
      `[cachekit] the binding's BLAKE2b-256 gave the wrong self-test digest (${String(digest)}); ` +
        'cache keys are hashed in JS instead'
    );
  } catch (error) {
    logError(
      "[cachekit] the binding's BLAKE2b-256 failed its self-test; cache keys are hashed in JS instead",
      error
    );
  }
}

/** Whether cache keys are hashed through a binding right now, rather than in JS. */
export function usingKeyHashBinding(): boolean {
  return binding !== undefined;
}

/**
 * A binding that throws once it is in use is dropped for good, after one
 * report, and the call that met the failure is answered in JS: a faster hash
 * must never be the reason a key cannot be made.
 */
function viaBinding(hash: Blake2b256Hex, data: Uint8Array): string {
  try {
    return hash(data);
  } catch (error) {
    if (binding === hash) {
      binding = undefined;
      logError(
        "[cachekit] the binding's BLAKE2b-256 failed; cache keys are hashed in JS from now on",
        error
      );
    }
    return nobleBlake2b256Hex(data);
  }
}

/**
 * Unkeyed BLAKE2b-256 of `data` as 64 lowercase hex characters: through the
 * binding when one is set, in JS otherwise.
 */
export function blake2b256Hex(data: Uint8Array): string {
  return binding === undefined ? nobleBlake2b256Hex(data) : viaBinding(binding, data);
}

/** Unkeyed BLAKE2b-256 of `data`, the 32-byte digest, by the same path. */
export function blake2b256(data: Uint8Array): Uint8Array {
  return binding === undefined
    ? blake2b(data, { dkLen: 32 })
    : hexToBytes(viaBinding(binding, data));
}

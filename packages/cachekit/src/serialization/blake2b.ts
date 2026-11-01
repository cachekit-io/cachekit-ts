// @noble/hashes' BLAKE2b. In the ES module build `#noble-blake2` (package.json
// `imports`) is a static import of noble (esm-noble-blake2.ts). A lazy
// require(esm) there would share noble with the app's own ES module graph,
// which can still be loading it: Node 22.12 to 22.14 then throw, 22.15, 22.16
// and 23 return it unevaluated, and every version throws while an import() of
// it is in flight. In the CommonJS build it is cjs-noble-blake2.ts, which loads
// noble at require below Node 24 and on first use from 24.
import { blake2b } from '#noble-blake2';
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
 * Lowercase hex of `bytes`, as one string. Without a native
 * Uint8Array.prototype.toHex (Node.js 24 and earlier), appending two digits at
 * a time would leave V8 holding every intermediate string inside the result:
 * about 800 bytes more for each key that L1 or a key memo holds. The digits go
 * into a byte buffer instead, decoded once.
 */
export function bytesToHex(bytes: Uint8Array): string {
  if (nativeHex) return (bytes as Uint8Array & { toHex(): string }).toHex();
  const out =
    bytes.length * 2 <= hexBytes.length
      ? hexBytes.subarray(0, bytes.length * 2)
      : new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    out[2 * i] = HEX_DIGITS[bytes[i] >> 4];
    out[2 * i + 1] = HEX_DIGITS[bytes[i] & 15];
  }
  return hexDecoder.decode(out);
}

/** The bytes a binding's hex digest spells. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new SyntaxError(
      `[cachekit] the binding returned a malformed hex digest (${hex.length} characters)`
    );
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return bytes;
}

/** The cache-key hash in JS (@noble/hashes): what keys use without a binding. */
export function nobleBlake2b256Hex(data: Uint8Array): string {
  return bytesToHex(blake2b(data, { dkLen: 32 }));
}

/** Unkeyed BLAKE2b-128 of `data` as 32 lowercase hex characters, always in JS. */
export function nobleBlake2b128Hex(data: Uint8Array): string {
  return bytesToHex(blake2b(data, { dkLen: 16 }));
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
 * must never be the reason a key cannot be made. The answer is computed before
 * the report: `data` can be a view of the shared key encoder's buffer, and a
 * logger that makes a key of its own would overwrite it.
 */
function viaBinding(hash: Blake2b256Hex, data: Uint8Array): string {
  try {
    return hash(data);
  } catch (error) {
    const hex = nobleBlake2b256Hex(data);
    binding = undefined;
    logError(
      "[cachekit] the binding's BLAKE2b-256 failed; cache keys are hashed in JS from now on",
      error
    );
    return hex;
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

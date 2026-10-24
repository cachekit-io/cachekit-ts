import { Encoder } from '@msgpack/msgpack';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { normalize } from './serializer.js';
import { ValueTooLargeError } from '../errors.js';
import {
  KEY_GEN_MAX_SIZE,
  KEY_GEN_MAX_DEPTH,
  DEFAULT_MAX_COLLECTION_SIZE,
  CACHE_KEY_HASH_LENGTH,
} from '../constants.js';

/** The key encoder's buffer, in bytes: room for the arguments of almost any key. */
const KEY_ENCODER_BUFFER = 2048;

/**
 * One encoder for every key, because building one per call (its buffer and two
 * views over it) cost more than encoding the arguments. The bytes a call writes
 * are wiped once hashed, so the buffer never holds an earlier call's
 * arguments, and an encoder an outsize argument has grown is replaced rather
 * than kept at that size.
 */
let keyEncoder = new Encoder({ initialBufferSize: KEY_ENCODER_BUFFER });

/**
 * BLAKE2b-256 of the key arguments' deterministic MessagePack, with strict
 * limits. Not the value serializer: key arguments are hashed, never decoded, so
 * any binary argument (typed array, DataView, ArrayBuffer) hashes by its type
 * and bytes.
 */
function digestArgs(args: unknown[]): Uint8Array {
  const normalized = normalize(args, 0, KEY_GEN_MAX_DEPTH, DEFAULT_MAX_COLLECTION_SIZE, {
    forKey: true,
    objects: 0,
    values: 0,
  });
  let encoded: Uint8Array;
  try {
    encoded = keyEncoder.encodeSharedRef(normalized);
  } catch (error) {
    // The buffer holds whatever was written before the throw: drop it.
    keyEncoder = new Encoder({ initialBufferSize: KEY_ENCODER_BUFFER });
    throw error;
  }
  try {
    if (encoded.length > KEY_GEN_MAX_SIZE) {
      throw new ValueTooLargeError(
        `Encoded size ${encoded.length} exceeds max ${KEY_GEN_MAX_SIZE}`
      );
    }
    return blake2b(encoded, { dkLen: 32 });
  } finally {
    encoded.fill(0);
    if (encoded.buffer.byteLength > KEY_ENCODER_BUFFER) {
      keyEncoder = new Encoder({ initialBufferSize: KEY_ENCODER_BUFFER });
    }
  }
}

/**
 * Generate a cache key from namespace and arguments.
 *
 * Uses Blake2b-256 for the hash, which is:
 * - Faster than SHA-256
 * - Equally secure (256-bit security level)
 * - Used by @noble/hashes (Cure53-audited)
 *
 * Output format: `{namespace}:{64-char-hex-hash}`
 *
 * @param namespace - Cache namespace (e.g., "user-service:getUser")
 * @param args - Function arguments to include in the key
 * @returns Cache key string
 *
 * @example
 * ```typescript
 * const key = generateKey('user-service:getUser', [123, { includeDeleted: false }]);
 * // Returns: "user-service:getUser:a1b2c3d4e5f6..."
 * ```
 */
export function generateKey(namespace: string, args: unknown[]): string {
  const hash = generateParamsHash(args);
  return `${namespace}:${hash}`;
}

/**
 * Generate a params hash from function arguments.
 *
 * This is the hash portion only (64 hex chars), used for:
 * - Params-level invalidation
 * - Cross-language cache key compatibility
 *
 * @param args - Function arguments to hash
 * @returns 64-character hex hash string
 */
export function generateParamsHash(args: unknown[]): string {
  return bytesToHex(digestArgs(args));
}

/**
 * `blake2b(utf8(key), digestSize=16)` hex — 32 chars. The SDK's canonical
 * short key digest, byte-identical to cachekit-py's `_key_to_path` stem: the
 * File backend's flat filename and the redacted `keyHash=` in size-rejection
 * logs are the same value, so a logged rejection can be matched to its cache
 * file (or to a suspect key by recomputing) without ever logging the key.
 */
export function blake2b16Hex(key: string): string {
  return bytesToHex(blake2b(utf8ToBytes(key), { dkLen: 16 }));
}

/**
 * Extract namespace from a full cache key.
 *
 * @param key - Full cache key (format: "namespace:hash")
 * @returns The namespace portion
 */
export function extractNamespace(key: string): string {
  const lastColon = key.lastIndexOf(':');
  if (lastColon === -1) {
    return key;
  }
  // Check if what follows is a 64-char hex hash
  const suffix = key.substring(lastColon + 1);
  if (suffix.length === CACHE_KEY_HASH_LENGTH && /^[0-9a-f]+$/i.test(suffix)) {
    return key.substring(0, lastColon);
  }
  return key;
}

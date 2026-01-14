import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { MessagePackSerializer } from './serializer.js';
import { KEY_GEN_MAX_SIZE, KEY_GEN_MAX_DEPTH, CACHE_KEY_HASH_LENGTH } from '../constants.js';

// Use a dedicated serializer for key generation with strict limits
const keySerializer = new MessagePackSerializer({
  maxEncodedSize: KEY_GEN_MAX_SIZE,
  maxDecodedSize: KEY_GEN_MAX_SIZE,
  maxDepth: KEY_GEN_MAX_DEPTH,
});

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
  // Serialize arguments deterministically (sorted keys, normalized values)
  const serialized = keySerializer.encode(args);

  // Hash with Blake2b-256
  const hash = blake2b(serialized, { dkLen: 32 }); // 32 bytes = 256 bits

  // Convert to hex string
  const hexHash = bytesToHex(hash);

  // Combine namespace and hash
  return `${namespace}:${hexHash}`;
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
  const serialized = keySerializer.encode(args);
  const hash = blake2b(serialized, { dkLen: 32 });
  return bytesToHex(hash);
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

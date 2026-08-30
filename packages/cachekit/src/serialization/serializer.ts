import { encode, decode } from '@msgpack/msgpack';
import { SerializationError, ValueTooLargeError } from '../errors.js';
import {
  DEFAULT_MAX_ENCODED_SIZE,
  DEFAULT_MAX_DECODED_SIZE,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_COLLECTION_SIZE,
} from '../constants.js';

/**
 * Serializer configuration with DoS protection limits.
 */
export interface SerializerConfig {
  /** Maximum size of encoded output in bytes (default: 1MB) */
  maxEncodedSize: number;
  /** Maximum size of decoded input in bytes (default: 10MB) */
  maxDecodedSize: number;
  /** Maximum object nesting depth (default: 100) */
  maxDepth: number;
  /**
   * Maximum collection size for Maps, Sets, Arrays, Objects (default: 10000).
   * Enforced on encode and decode; decode-time rejections report the
   * underlying @msgpack/msgpack option names (maxArrayLength/maxMapLength).
   */
  maxCollectionSize: number;
}

const DEFAULT_CONFIG: SerializerConfig = {
  maxEncodedSize: DEFAULT_MAX_ENCODED_SIZE,
  maxDecodedSize: DEFAULT_MAX_DECODED_SIZE,
  maxDepth: DEFAULT_MAX_DEPTH,
  maxCollectionSize: DEFAULT_MAX_COLLECTION_SIZE,
};

/**
 * Build @msgpack/msgpack decode options that bound header-declared sizes.
 *
 * Backend bytes are untrusted: without explicit bounds @msgpack/msgpack
 * preallocates arrays/maps from their headers (`new Array(size)`), so a few
 * forged bytes claiming a 2^32-element array would OOM the reader before a
 * single element is decoded. Collection headers are capped up front; string
 * and bin lengths are additionally bounded by each caller's input-size cap.
 *
 * Package-internal: shared by the auto-mode serializer, the interop decoder,
 * and the invalidation-event decoder so the bounds cannot drift apart.
 */
export function boundedDecodeOptions(maxCollectionSize: number, maxDecodedSize: number) {
  return {
    maxArrayLength: maxCollectionSize,
    maxMapLength: maxCollectionSize,
    maxStrLength: maxDecodedSize,
    maxBinLength: maxDecodedSize,
  };
}

/**
 * Serializer interface for pluggable serialization strategies.
 */
export interface Serializer {
  encode<T>(value: T): Uint8Array;
  decode<T>(data: Uint8Array): T;
}

/**
 * Normalize a value for deterministic serialization.
 * - Sort object keys alphabetically
 * - Convert -0 to 0
 * - Convert undefined to null
 * - Track depth to prevent stack overflow
 * - M9 Fix: Check collection size to prevent DoS via large collections
 */
function normalize(
  value: unknown,
  depth: number,
  maxDepth: number,
  maxCollectionSize: number
): unknown {
  if (depth > maxDepth) {
    throw new SerializationError(`Max depth of ${maxDepth} exceeded`);
  }

  if (value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    // Normalize -0 to 0
    if (Object.is(value, -0)) {
      return 0;
    }
    return value;
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    // M9 Fix: Check array size
    if (value.length > maxCollectionSize) {
      throw new SerializationError(
        `Array size ${value.length} exceeds max collection size ${maxCollectionSize}`
      );
    }
    return value.map((item) => normalize(item, depth + 1, maxDepth, maxCollectionSize));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Map) {
    // M9 Fix: Check Map size
    if (value.size > maxCollectionSize) {
      throw new SerializationError(
        `Map size ${value.size} exceeds max collection size ${maxCollectionSize}`
      );
    }
    const obj: Record<string, unknown> = {};
    const sortedKeys = Array.from(value.keys()).sort();
    for (const key of sortedKeys) {
      obj[String(key)] = normalize(value.get(key), depth + 1, maxDepth, maxCollectionSize);
    }
    return obj;
  }

  if (value instanceof Set) {
    // M9 Fix: Check Set size
    if (value.size > maxCollectionSize) {
      throw new SerializationError(
        `Set size ${value.size} exceeds max collection size ${maxCollectionSize}`
      );
    }
    return Array.from(value)
      .map((item) => normalize(item, depth + 1, maxDepth, maxCollectionSize))
      .sort();
  }

  // Plain object - sort keys
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);

  // M9 Fix: Check object key count
  if (keys.length > maxCollectionSize) {
    throw new SerializationError(
      `Object key count ${keys.length} exceeds max collection size ${maxCollectionSize}`
    );
  }

  const sortedKeys = keys.sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    result[key] = normalize(obj[key], depth + 1, maxDepth, maxCollectionSize);
  }
  return result;
}

/**
 * MessagePack serializer with DoS protection.
 *
 * Features:
 * - Deterministic output (sorted keys, normalized values)
 * - Four-layer DoS protection (C4 fix; decode bounds added in LAB-281):
 *   1. maxDecodedSize - limit input size to decode() and str/bin lengths inside it
 *   2. maxEncodedSize - limit output size from encode()
 *   3. maxDepth - limit nesting depth to prevent stack overflow
 *   4. maxCollectionSize - bound collection headers at decode time (no
 *      preallocation from forged headers) and collection sizes at encode time
 */
export class MessagePackSerializer implements Serializer {
  private readonly config: SerializerConfig;

  constructor(config: Partial<SerializerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Encode a value to MessagePack bytes.
   *
   * @throws {ValueTooLargeError} if encoded size exceeds maxEncodedSize
   * @throws {SerializationError} if depth exceeds maxDepth or collection size exceeds limit
   */
  encode<T>(value: T): Uint8Array {
    // Normalize for deterministic output (also checks depth and collection size)
    const normalized = normalize(value, 0, this.config.maxDepth, this.config.maxCollectionSize);

    // Encode to MessagePack
    const encoded = encode(normalized);

    // Check encoded size
    if (encoded.length > this.config.maxEncodedSize) {
      throw new ValueTooLargeError(
        `Encoded size ${encoded.length} exceeds max ${this.config.maxEncodedSize}`
      );
    }

    return encoded;
  }

  /**
   * Validate decoded object depth to prevent decompression bombs.
   */
  private validateDepth(value: unknown, depth: number): void {
    if (depth > this.config.maxDepth) {
      throw new SerializationError(
        `Deserialized object exceeds max depth of ${this.config.maxDepth}`
      );
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.validateDepth(item, depth + 1);
      }
    } else if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value)) {
        this.validateDepth(v, depth + 1);
      }
    }
  }

  /**
   * Decode MessagePack bytes to a value.
   *
   * @throws {ValueTooLargeError} if input size exceeds maxDecodedSize
   * @throws {SerializationError} if decoding fails
   */
  decode<T>(data: Uint8Array): T {
    // Check input size
    if (data.length > this.config.maxDecodedSize) {
      throw new ValueTooLargeError(
        `Input size ${data.length} exceeds max ${this.config.maxDecodedSize}`
      );
    }

    try {
      const decoded = decode(
        data,
        boundedDecodeOptions(this.config.maxCollectionSize, this.config.maxDecodedSize)
      );

      // Validate depth of decoded object (DoS protection)
      this.validateDepth(decoded, 0);

      return decoded as T;
    } catch (error) {
      if (error instanceof SerializationError) {
        throw error;
      }
      throw new SerializationError(
        `Failed to decode MessagePack: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error instanceof Error ? error : undefined }
      );
    }
  }
}

/** Default serializer instance */
export const defaultSerializer = new MessagePackSerializer();

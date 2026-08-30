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
    maxExtLength: maxDecodedSize,
  };
}

/**
 * Reject untrusted MessagePack whose collection nesting exceeds `maxDepth`,
 * before it reaches the decoder (LAB-2487).
 *
 * `boundedDecodeOptions` caps each collection's *declared* size, but
 * `@msgpack/msgpack` (3.1.3, latest; `main` has no depth option) eagerly runs
 * `new Array(size)` for every array header the moment it is read — before the
 * children decode. A header claiming `maxCollectionSize` elements passes the
 * per-collection cap and preallocates ~`maxCollectionSize * 8` bytes; nested
 * headers stack those preallocations. Measured: 5000 nested `array16` headers
 * (15 KB) forced ~400 MB of transient heap (~26,700x) before the end-of-input
 * throw. The library's own `maxDepth`-equivalent is the encoder's; the decoder
 * has none, and the serializer's post-decode `validateDepth` runs *after* the
 * allocations. So the bound has to be enforced pre-decode.
 *
 * This is a single-pass structural walk that reads only headers and skips
 * payloads — it allocates nothing but a small per-depth counter array (bounded
 * by `maxDepth`), and it materialises no values. Requiring the walk to consume
 * exactly `data.length` also makes it fail closed on the forged case: a header
 * claiming N children that the buffer cannot back is rejected as truncated,
 * before the decoder allocates. Only arrays and maps recurse in the decoder, so
 * only they count toward depth; str/bin/ext payloads are opaque bytes already
 * bounded by `maxStr/BinLength`. Any unknown or truncated byte throws — a
 * pre-scan/decoder desync can only ever *reject* (availability), never *admit*
 * bytes the decoder would then amplify.
 *
 * ponytail: hand-rolled structural walk because @msgpack/msgpack exposes no
 * maxDepth; delete this in favour of a decoder-native bound if one lands
 * upstream (tracked alongside LAB-2487).
 *
 * @throws {SerializationError} if nesting exceeds `maxDepth` or the bytes are
 *   structurally truncated/malformed.
 */
export function assertDecodeDepth(data: Uint8Array, maxDepth: number): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // pending[d] = child values still to consume inside the collection at depth d.
  const pending: number[] = [1]; // exactly one top-level value expected
  let depth = 0;
  let pos = 0;

  const need = (n: number): void => {
    if (pos + n > data.length) {
      throw new SerializationError(`Truncated MessagePack at byte ${pos} (decode pre-scan)`);
    }
  };

  while (depth >= 0) {
    // Unwind collections whose children are all accounted for.
    while (depth >= 0 && pending[depth] === 0) depth--;
    if (depth < 0) break;
    pending[depth]--; // this value fills one slot of its parent
    need(1);
    const b = data[pos++];
    let children = 0; // >0 opens a new collection level

    if (b <= 0x7f || b >= 0xe0) {
      // positive/negative fixint — no payload
    } else if (b >= 0x80 && b <= 0x8f) {
      children = (b & 0x0f) * 2; // fixmap: N keys + N values
    } else if (b >= 0x90 && b <= 0x9f) {
      children = b & 0x0f; // fixarray
    } else if (b >= 0xa0 && b <= 0xbf) {
      pos += b & 0x1f; // fixstr
    } else {
      switch (b) {
        case 0xc0: // nil
        case 0xc2: // false
        case 0xc3: // true
          break;
        case 0xcc: // uint8
        case 0xd0: // int8
          pos += 1;
          break;
        case 0xcd: // uint16
        case 0xd1: // int16
          pos += 2;
          break;
        case 0xca: // float32
        case 0xce: // uint32
        case 0xd2: // int32
          pos += 4;
          break;
        case 0xcb: // float64
        case 0xcf: // uint64
        case 0xd3: // int64
          pos += 8;
          break;
        case 0xd9: // str8
        case 0xc4: // bin8
          need(1);
          pos += 1 + data[pos];
          break;
        case 0xda: // str16
        case 0xc5: // bin16
          need(2);
          pos += 2 + view.getUint16(pos);
          break;
        case 0xdb: // str32
        case 0xc6: // bin32
          need(4);
          pos += 4 + view.getUint32(pos);
          break;
        case 0xdc: // array16
          need(2);
          children = view.getUint16(pos);
          pos += 2;
          break;
        case 0xdd: // array32
          need(4);
          children = view.getUint32(pos);
          pos += 4;
          break;
        case 0xde: // map16
          need(2);
          children = view.getUint16(pos) * 2;
          pos += 2;
          break;
        case 0xdf: // map32
          need(4);
          children = view.getUint32(pos) * 2;
          pos += 4;
          break;
        case 0xd4: // fixext1
          pos += 1 + 1;
          break;
        case 0xd5: // fixext2
          pos += 1 + 2;
          break;
        case 0xd6: // fixext4
          pos += 1 + 4;
          break;
        case 0xd7: // fixext8
          pos += 1 + 8;
          break;
        case 0xd8: // fixext16
          pos += 1 + 16;
          break;
        case 0xc7: // ext8
          need(1);
          pos += 2 + data[pos];
          break;
        case 0xc8: // ext16
          need(2);
          pos += 3 + view.getUint16(pos);
          break;
        case 0xc9: // ext32
          need(4);
          pos += 5 + view.getUint32(pos);
          break;
        default:
          throw new SerializationError(
            `Invalid MessagePack head byte 0x${b.toString(16)} at byte ${pos - 1} (decode pre-scan)`
          );
      }
    }

    if (children > 0) {
      depth++;
      if (depth > maxDepth) {
        throw new SerializationError(`Max depth of ${maxDepth} exceeded (decode pre-scan)`);
      }
      pending[depth] = children;
    }
  }

  need(0);
  if (pos > data.length) {
    throw new SerializationError(`Truncated MessagePack at byte ${pos} (decode pre-scan)`);
  }
  if (pos !== data.length) {
    throw new SerializationError(
      `Trailing bytes after MessagePack document: consumed ${pos} of ${data.length} (decode pre-scan)`
    );
  }
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
 * - Five-layer DoS protection (C4 fix; decode bounds added in LAB-281,
 *   pre-decode depth bound in LAB-2487):
 *   1. maxDecodedSize - limit input size to decode() and str/bin lengths inside it
 *   2. maxEncodedSize - limit output size from encode()
 *   3. maxDepth - limit nesting depth (at encode time, and pre-decode via
 *      assertDecodeDepth so nested headers can't stack preallocations)
 *   4. maxCollectionSize - bound collection headers at decode time (no
 *      preallocation from forged headers) and collection sizes at encode time
 *   5. assertDecodeDepth - reject over-depth / structurally-incomplete input
 *      before the decoder allocates (LAB-2487; see the function's own docs)
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
   *
   * Now largely redundant with the pre-decode `assertDecodeDepth` on this path
   * (that rejects over-depth input before `decode()` builds the graph 1:1). Kept
   * as a cheap post-decode backstop for the freshly hand-rolled pre-scan: if the
   * walker ever under-counts depth, this still catches it before the value is
   * returned. Retire once the pre-scan's parity is proven in CI.
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

    // Bound nesting depth before the decoder eagerly preallocates per-header
    // collections (LAB-2487) — the per-collection cap alone lets nested headers
    // stack preallocations disproportionate to input size.
    assertDecodeDepth(data, this.config.maxDepth);

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

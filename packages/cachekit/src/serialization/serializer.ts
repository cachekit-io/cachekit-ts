import { ExtData, encode, decode } from '@msgpack/msgpack';
import { blake2b } from '@noble/hashes/blake2.js';
import { ConfigurationError, SerializationError, ValueTooLargeError } from '../errors.js';
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
  /**
   * Maximum size of encoded output in bytes (default: 1MB). Must be a positive
   * safe integer; the constructor throws `ConfigurationError` otherwise.
   */
  maxEncodedSize: number;
  /**
   * Maximum size of decoded input in bytes (default: 10MB). Must be a positive
   * safe integer; the constructor throws `ConfigurationError` otherwise.
   */
  maxDecodedSize: number;
  /**
   * Maximum object nesting depth (default: 100). Must be an integer from 32 to
   * 1024, the protocol's decode bound; the constructor throws
   * `ConfigurationError` otherwise.
   */
  maxDepth: number;
  /**
   * Maximum collection size for Maps, Sets, Arrays, Objects (default: 10000).
   * Enforced on encode and decode; decode-time rejections report the
   * underlying @msgpack/msgpack option names (maxArrayLength/maxMapLength).
   * Must be a positive safe integer; the constructor throws
   * `ConfigurationError` otherwise.
   */
  maxCollectionSize: number;
}

/**
 * Valid range for `maxDepth`, from the protocol's decode-bounds rule
 * (spec/interop-mode.md, "Decode bounds"): a reader's nesting bound MUST be at
 * least 32 and MUST NOT exceed 1024. Above it, a backed nesting chain decodes
 * and recurses past the protocol's bound; below it, legal interop values are
 * rejected.
 */
const MIN_MAX_DEPTH = 32;
const MAX_MAX_DEPTH = 1024;

/** Size bounds that must be positive safe integers (see the constructor). */
const SIZE_BOUND_FIELDS = ['maxEncodedSize', 'maxDecodedSize', 'maxCollectionSize'] as const;

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
 * It also counts what L1 charges for on a read (see `ObjectCount`): the
 * values that decode to a heap object of their own (arrays and maps, empty
 * ones included, bin and ext), and the elements and map entries those arrays
 * and maps hold. So a decoder-native depth bound, should @msgpack/msgpack grow
 * one, would not replace this walk.
 *
 * @returns the document's object and value counts.
 * @throws {SerializationError} if nesting exceeds `maxDepth` or the bytes are
 *   structurally truncated/malformed.
 */
export function assertDecodeDepth(data: Uint8Array, maxDepth: number): ObjectCount {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // pending[d] = child values still to consume inside the collection at depth d.
  const pending: number[] = [1]; // exactly one top-level value expected
  let depth = 0;
  let pos = 0;
  // Counted at each header, not at `children > 0` below: an empty container
  // opens no level but still costs a heap object once decoded. A map's values
  // count its entries, not its keys and values.
  let objects = 0;
  let values = 0;

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
      objects++;
      values += b & 0x0f;
    } else if (b >= 0x90 && b <= 0x9f) {
      children = b & 0x0f; // fixarray
      objects++;
      values += children;
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
        case 0xc4: // bin8
          objects++; // a Uint8Array once decoded
        // falls through
        case 0xd9: // str8
          need(1);
          pos += 1 + data[pos];
          break;
        case 0xc5: // bin16
          objects++;
        // falls through
        case 0xda: // str16
          need(2);
          pos += 2 + view.getUint16(pos);
          break;
        case 0xc6: // bin32
          objects++;
        // falls through
        case 0xdb: // str32
          need(4);
          pos += 4 + view.getUint32(pos);
          break;
        case 0xdc: // array16
          need(2);
          children = view.getUint16(pos);
          pos += 2;
          objects++;
          values += children;
          break;
        case 0xdd: // array32
          need(4);
          children = view.getUint32(pos);
          pos += 4;
          objects++;
          values += children;
          break;
        case 0xde: // map16
          need(2);
          children = view.getUint16(pos) * 2;
          pos += 2;
          objects++;
          values += children / 2;
          break;
        case 0xdf: // map32
          need(4);
          children = view.getUint32(pos) * 2;
          pos += 4;
          objects++;
          values += children / 2;
          break;
        case 0xd4: // fixext1
          objects++; // a Date (timestamp) or other object once decoded
          pos += 1 + 1;
          break;
        case 0xd5: // fixext2
          objects++;
          pos += 1 + 2;
          break;
        case 0xd6: // fixext4
          objects++;
          pos += 1 + 4;
          break;
        case 0xd7: // fixext8
          objects++;
          pos += 1 + 8;
          break;
        case 0xd8: // fixext16
          objects++;
          pos += 1 + 16;
          break;
        case 0xc7: // ext8
          objects++;
          need(1);
          pos += 2 + data[pos];
          break;
        case 0xc8: // ext16
          objects++;
          need(2);
          pos += 3 + view.getUint16(pos);
          break;
        case 0xc9: // ext32
          objects++;
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
  return { objects, values };
}

/**
 * Receives what L1 charges for beyond a value's serialized size, counted by a
 * walk the codec already runs (see OBJECT_SIZE and VALUE_SIZE in
 * l1/lru-cache.ts). Package-internal.
 */
export interface ObjectCount {
  /**
   * Values that decode to a heap object of their own: arrays and maps
   * (objects, Maps, Sets), empty ones too, plus binary and ext values.
   */
  objects: number;
  /**
   * Elements of arrays and Sets plus entries of maps (objects, Maps): one
   * slot each in the heap object that holds them. A Map or Set counts every
   * entry the caller's value holds, including those the encoding merges.
   */
  values: number;
}

/**
 * State shared by one normalize() walk. The count rides in the object that
 * already carries the mode: as a sixth recursive argument it measured
 * costlier on a write of many empty objects.
 */
interface NormalizeWalk {
  readonly forKey: boolean;
  objects: number;
  values: number;
}

/**
 * Serializer interface for pluggable serialization strategies.
 */
export interface Serializer {
  encode<T>(value: T): Uint8Array;
  decode<T>(data: Uint8Array): T;
}

// Intrinsic getters, captured once: they read internal slots, so they cannot be
// fooled by Symbol.toStringTag or shadowed properties, and work on another
// realm's objects. The %TypedArray% name getter returns undefined for a DataView.
// T is the getter's return type per the spec, which TypeScript cannot check.
type Getter<T> = (this: unknown) => T;
function getter<T>(proto: object, name: PropertyKey): Getter<T> {
  const get: Getter<T> | undefined = Object.getOwnPropertyDescriptor(proto, name)?.get;
  // Fail at load: bytesOf and hasBufferBrand swallow throws, so a missing getter
  // would otherwise give every binary argument the same key.
  if (!get) throw new Error(`cachekit: intrinsic getter ${String(name)} not found`);
  return get;
}
const typedArrayProto: object = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayName = getter<string | undefined>(typedArrayProto, Symbol.toStringTag);
const viewGetters = (proto: object) => ({
  buffer: getter<ArrayBufferLike>(proto, 'buffer'),
  byteOffset: getter<number>(proto, 'byteOffset'),
  byteLength: getter<number>(proto, 'byteLength'),
});
const typedArrayView = viewGetters(typedArrayProto);
const dataViewView = viewGetters(DataView.prototype);
const arrayBufferByteLength = getter<number>(ArrayBuffer.prototype, 'byteLength');
// SharedArrayBuffer is absent in browsers without cross-origin isolation.
const sharedArrayBufferByteLength =
  typeof SharedArrayBuffer === 'function'
    ? getter<number>(SharedArrayBuffer.prototype, 'byteLength')
    : undefined;

/** The getter throws unless `value` holds that buffer's internal slot. */
function hasBufferBrand(value: object, byteLength: Getter<number>): value is ArrayBufferLike {
  try {
    byteLength.call(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bytes as a Uint8Array view, not a copy. A detached (transferred) buffer
 * throws on any view but holds no bytes, so it reads as empty, as it would in
 * the caller's own function, rather than throwing from key generation.
 */
function bytesOf(value: ArrayBufferLike | ArrayBufferView): Uint8Array {
  try {
    if (!ArrayBuffer.isView(value)) return new Uint8Array(value);
    const view = typedArrayName.call(value) === undefined ? dataViewView : typedArrayView;
    return new Uint8Array(
      view.buffer.call(value),
      view.byteOffset.call(value),
      view.byteLength.call(value)
    );
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * A binary value's type and bytes, from its brand; undefined if `value` is not
 * binary. Not instanceof, which another realm's buffers (vm, jest) fail, nor
 * Symbol.toStringTag, which any object can set (LAB-4839).
 */
function binary(value: object): [type: string, bytes: Uint8Array] | undefined {
  if (ArrayBuffer.isView(value)) {
    return [typedArrayName.call(value) ?? 'DataView', bytesOf(value)];
  }
  // The tag or instanceof only picks which brand to check, so a plain object
  // never pays for a throw. instanceof catches a same-realm buffer that retags
  // itself; only another realm's retagged buffer is missed, and encodes as {}.
  // Reading the tag runs a Proxy trap or Symbol.toStringTag getter, which may
  // throw; such an object is not a buffer, and must not throw from key generation.
  let tag = '';
  try {
    tag = Object.prototype.toString.call(value).slice(8, -1);
  } catch {
    // Not a buffer: fall through to the instanceof and brand checks.
  }
  if (
    (tag === 'ArrayBuffer' || value instanceof ArrayBuffer) &&
    hasBufferBrand(value, arrayBufferByteLength)
  ) {
    return ['ArrayBuffer', bytesOf(value)];
  }
  if (
    sharedArrayBufferByteLength &&
    (tag === 'SharedArrayBuffer' || value instanceof SharedArrayBuffer) &&
    hasBufferBrand(value, sharedArrayBufferByteLength)
  ) {
    return ['SharedArrayBuffer', bytesOf(value)];
  }
  return undefined;
}

/**
 * Normalize a value for deterministic serialization.
 * - Sort object keys alphabetically
 * - Convert -0 to 0
 * - Convert undefined to null
 * - Track depth to prevent stack overflow
 * - M9 Fix: Check collection size to prevent DoS via large collections
 * - Pass Uint8Array (incl. Buffer) through as msgpack bin; reject other binary
 *   values, but hash any binary key argument (`walk.forKey`) by its bytes
 * - Count arrays, Maps, Sets, plain objects and binary values into `walk.objects`,
 *   and their elements and entries into `walk.values`
 *
 * Package-internal: key generation calls it with `walk.forKey` set.
 */
export function normalize(
  value: unknown,
  depth: number,
  maxDepth: number,
  maxCollectionSize: number,
  walk: NormalizeWalk
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
    walk.objects++;
    walk.values += value.length;
    return value.map((item) => normalize(item, depth + 1, maxDepth, maxCollectionSize, walk));
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
    walk.objects++;
    // The Map's own size: String(key) can merge keys in the encoding, but L1
    // holds the caller's Map with every entry.
    walk.values += value.size;
    const obj: Record<string, unknown> = {};
    const sortedKeys = Array.from(value.keys()).sort();
    for (const key of sortedKeys) {
      obj[String(key)] = normalize(value.get(key), depth + 1, maxDepth, maxCollectionSize, walk);
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
    walk.objects++;
    walk.values += value.size;
    return Array.from(value)
      .map((item) => normalize(item, depth + 1, maxDepth, maxCollectionSize, walk))
      .sort();
  }

  const bin = binary(value);
  if (bin) {
    walk.objects++;
    const [type, bytes] = bin;
    // @msgpack/msgpack emits a Uint8Array as bin, bounded by the caller's
    // post-encode size check.
    if (type === 'Uint8Array') return bytes;
    // A key argument is hashed, never decoded: hash other binary by type and a
    // BLAKE2b-256 digest of its bytes, so Int8Array([-1]) and Uint8Array([255])
    // stay distinct keys. The digest keeps the argument 32 bytes whatever the
    // buffer's size, so a large ArrayBuffer (a request body) neither trips the
    // 64 KiB key limit nor gets copied before it is checked. As a msgpack ext,
    // which no ordinary argument normalizes to, it cannot collide with an object
    // of that shape, e.g. { Int8Array: Uint8Array.of(255) }.
    if (walk.forKey) return new ExtData(0, encode([type, blake2b(bytes, { dkLen: 32 })]));
    // A value would decode as a Uint8Array — a silent type change — so reject
    // it with the fix instead (LAB-4839).
    throw new SerializationError(
      `Cannot serialize ${type}: binary values must be a Uint8Array or Buffer ` +
        '(view the bytes with new Uint8Array(buffer, byteOffset, byteLength))'
    );
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

  walk.objects++;
  walk.values += keys.length;
  const sortedKeys = keys.sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    result[key] = normalize(obj[key], depth + 1, maxDepth, maxCollectionSize, walk);
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

  /**
   * @throws {ConfigurationError} if `maxDepth` is not an integer in [32, 1024],
   *   or if `maxEncodedSize`, `maxDecodedSize` or `maxCollectionSize` is not a
   *   positive safe integer. Rejected, never clamped: `NaN`, `Infinity` or an
   *   explicit `undefined` would otherwise switch the bound off
   *   (`size > NaN` is always false).
   */
  constructor(config: Partial<SerializerConfig> = {}) {
    this.config = resolveSerializerConfig(config);
  }

  /** The decoded-size ceiling, for callers that must enforce it upstream of decode(). */
  get maxDecodedSize(): number {
    return this.config.maxDecodedSize;
  }

  /**
   * Encode a value to MessagePack bytes.
   *
   * @throws {ValueTooLargeError} if encoded size exceeds maxEncodedSize
   * @throws {SerializationError} if depth exceeds maxDepth or collection size exceeds limit
   */
  encode<T>(value: T): Uint8Array {
    return encodeCounted(value, this.config);
  }

  /**
   * Decode MessagePack bytes to a value.
   *
   * @throws {ValueTooLargeError} if input size exceeds maxDecodedSize
   * @throws {SerializationError} if decoding fails
   */
  decode<T>(data: Uint8Array): T {
    return decodeCounted<T>(data, this.config);
  }
}

/**
 * The serializer config with defaults applied, validated as the
 * MessagePackSerializer constructor documents. Package-internal: the cache
 * holds the config and calls encodeCounted / decodeCounted with it.
 */
export function resolveSerializerConfig(config: Partial<SerializerConfig> = {}): SerializerConfig {
  const resolved = { ...DEFAULT_CONFIG, ...config };
  const { maxDepth } = resolved;
  if (!Number.isInteger(maxDepth) || maxDepth < MIN_MAX_DEPTH || maxDepth > MAX_MAX_DEPTH) {
    throw new ConfigurationError(
      `serializer.maxDepth must be an integer from ${MIN_MAX_DEPTH} to ${MAX_MAX_DEPTH}, got ${String(maxDepth)}`
    );
  }
  for (const field of SIZE_BOUND_FIELDS) {
    const value = resolved[field];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ConfigurationError(
        `serializer.${field} must be a positive safe integer, got ${String(value)}`
      );
    }
  }
  return resolved;
}

/**
 * MessagePackSerializer.encode, adding the value's object and value counts to
 * `count` once the bytes pass the size check. Package-internal.
 */
export function encodeCounted<T>(
  value: T,
  config: SerializerConfig,
  count?: ObjectCount
): Uint8Array {
  // Normalize for deterministic output (also checks depth and collection size)
  const walk = { forKey: false, objects: 0, values: 0 };
  const normalized = normalize(value, 0, config.maxDepth, config.maxCollectionSize, walk);

  // Encode to MessagePack
  const encoded = encode(normalized);

  // Check encoded size
  if (encoded.length > config.maxEncodedSize) {
    throw new ValueTooLargeError(
      `Encoded size ${encoded.length} exceeds max ${config.maxEncodedSize}`
    );
  }

  if (count) {
    count.objects += walk.objects;
    count.values += walk.values;
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
function validateDepth(value: unknown, depth: number, maxDepth: number): void {
  if (depth > maxDepth) {
    throw new SerializationError(`Deserialized object exceeds max depth of ${maxDepth}`);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      validateDepth(item, depth + 1, maxDepth);
    }
  } else if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    // bin decodes to a Uint8Array: its elements are bytes, not children.
    for (const v of Object.values(value)) {
      validateDepth(v, depth + 1, maxDepth);
    }
  }
}

/**
 * MessagePackSerializer.decode, adding the document's object and value counts
 * to `count` once it decodes. Package-internal.
 */
export function decodeCounted<T>(
  data: Uint8Array,
  config: SerializerConfig,
  count?: ObjectCount
): T {
  // Check input size
  if (data.length > config.maxDecodedSize) {
    throw new ValueTooLargeError(`Input size ${data.length} exceeds max ${config.maxDecodedSize}`);
  }

  // Bound nesting depth before the decoder eagerly preallocates per-header
  // collections (LAB-2487) — the per-collection cap alone lets nested headers
  // stack preallocations disproportionate to input size.
  const counted = assertDecodeDepth(data, config.maxDepth);

  try {
    const decoded = decode(
      data,
      boundedDecodeOptions(config.maxCollectionSize, config.maxDecodedSize)
    );

    // Validate depth of decoded object (DoS protection)
    validateDepth(decoded, 0, config.maxDepth);

    if (count) {
      count.objects += counted.objects;
      count.values += counted.values;
    }
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

/** Default serializer instance */
export const defaultSerializer = new MessagePackSerializer();

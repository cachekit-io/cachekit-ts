import { ExtData, ExtensionCodec, encode, decode } from '@msgpack/msgpack';
import { blake2b256 } from './blake2b.js';
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
 * Package-internal: shared by the auto-mode serializer and the
 * invalidation-event decoder so the bounds cannot drift apart. The interop
 * reader (readInteropDocument) applies the same collection cap itself.
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
 * before it reaches the decoder.
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
 * The interop reader (readInteropDocument in interop.ts) does no bounds checks
 * of its own: it relies on this walk for backing, depth and exact end of input.
 * A width disagreement between the two could make it misread rather than
 * reject, so it re-checks that it ended at `data.length`, and the differential
 * fuzz in serializer.test.ts runs both parsers over the same inputs.
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
  // opens no level but still costs a heap object once decoded. `values` is
  // charged one unit per array element and one per map entry (a key-value
  // pair); key bytes are covered by the per-byte charge.
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
   * One unit per element of an array or Set and one per entry (key-value pair)
   * of a map (object, Map); key bytes are covered by the per-byte charge. A Map
   * or Set counts every entry the caller's value holds, including those the
   * encoding merges.
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

/** A view's byte length, read without running user code; 0 once detached. */
function intrinsicByteLength(view: ArrayBufferView): number {
  try {
    return (
      typedArrayName.call(view) === undefined ? dataViewView : typedArrayView
    ).byteLength.call(view);
  } catch {
    return 0;
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
 * Symbol.toStringTag, which any object can set.
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

// normalize() and the one-pass ValueEncoder throw these, so their messages
// cannot drift apart.
const tooDeep = (maxDepth: number) => new SerializationError(`Max depth of ${maxDepth} exceeded`);
const tooLarge = (what: string, size: number, maxCollectionSize: number) =>
  new SerializationError(`${what} ${size} exceeds max collection size ${maxCollectionSize}`);
// A value would decode as a Uint8Array — a silent type change — so reject
// it with the fix instead.
const binaryValueError = (type: string) =>
  new SerializationError(
    `Cannot serialize ${type}: binary values must be a Uint8Array or Buffer ` +
      '(view the bytes with new Uint8Array(buffer, byteOffset, byteLength))'
  );

/**
 * Normalize a value for deterministic serialization.
 * - Sort object keys alphabetically
 * - Convert -0 to 0
 * - Convert undefined to null
 * - Track depth to prevent stack overflow
 * - Check collection size to prevent DoS via large collections
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
    throw tooDeep(maxDepth);
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
    // Check array size
    if (value.length > maxCollectionSize) {
      throw tooLarge('Array size', value.length, maxCollectionSize);
    }
    walk.objects++;
    walk.values += value.length;
    return value.map((item) => normalize(item, depth + 1, maxDepth, maxCollectionSize, walk));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Map) {
    // Check Map size
    if (value.size > maxCollectionSize) {
      throw tooLarge('Map size', value.size, maxCollectionSize);
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
    // Check Set size
    if (value.size > maxCollectionSize) {
      throw tooLarge('Set size', value.size, maxCollectionSize);
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
    if (walk.forKey) return new ExtData(0, encode([type, blake2b256(bytes)]));
    throw binaryValueError(type);
  }

  const obj = value as Record<string, unknown>;
  return normalizeObject(obj, Object.keys(obj), depth, maxDepth, maxCollectionSize, walk);
}

/** normalize() of a plain object whose own enumerable keys are `keys`. */
function normalizeObject(
  obj: Record<string, unknown>,
  keys: string[],
  depth: number,
  maxDepth: number,
  maxCollectionSize: number,
  walk: NormalizeWalk
): Record<string, unknown> {
  // Check object key count
  if (keys.length > maxCollectionSize) {
    throw tooLarge('Object key count', keys.length, maxCollectionSize);
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
 * - Five-layer DoS protection:
 *   1. maxDecodedSize - limit input size to decode() and str/bin lengths inside it
 *   2. maxEncodedSize - limit output size from encode()
 *   3. maxDepth - limit nesting depth (at encode time, and pre-decode via
 *      assertDecodeDepth so nested headers can't stack preallocations)
 *   4. maxCollectionSize - bound collection headers at decode time (no
 *      preallocation from forged headers) and collection sizes at encode time
 *   5. assertDecodeDepth - reject over-depth / structurally-incomplete input
 *      before the decoder allocates (see the function's own docs)
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

/** @msgpack/msgpack's encode() nesting bound, counted from 1 at the top value. */
const MSGPACK_MAX_DEPTH = 100;
/**
 * A safe superset of the keys an engine orders before all others, which
 * `normalize` cannot order: it also matches '4294967295' and above, which
 * engines order as plain strings. A match only sends the object to normalize.
 */
const INDEX_KEY = /^(0|[1-9][0-9]*)$/;
/** Above this many UTF-16 units @msgpack/msgpack encodes a string with TextEncoder. */
const TEXT_ENCODER_THRESHOLD = 50;
const textEncoder = new TextEncoder();
const VALUE_ENCODER_BUFFER = 2048;
/** A buffer grown past this is dropped after the encode rather than kept. */
const VALUE_ENCODER_RETAIN = 1 << 20;
/** The error for an encoded value past `maxEncodedSize`, wherever it is found. */
const encodedTooLarge = (size: number, max: number) =>
  new ValueTooLargeError(`Encoded size ${size} exceeds max ${max}`);
/** What a writer reads its bytes from once the output can only be an error. */
const EMPTY = new Uint8Array(0);
/** set() on it throws for a detached or out-of-bounds view, and does nothing for an empty one. */
const ONE_BYTE = new Uint8Array(1);
const unrecognized = (value: unknown) =>
  new Error(`Unrecognized object: ${Object.prototype.toString.apply(value)}`);

/**
 * Writes the bytes of @msgpack/msgpack's encode(normalize(value)) in one walk,
 * without building normalize's sorted copy first.
 *
 * Plain values (primitives, Array.prototype arrays, and objects with neither
 * an index-like nor a `__proto__` key) are normalized and encoded where they
 * are visited, reading each property once, in the order normalize
 * reads it. Any other subtree goes to normalize itself and its copy is encoded
 * as @msgpack/msgpack would encode it, so a change to how normalize treats
 * Map, Set, Date, other binary or those keys applies here unchanged.
 *
 * Old order, kept: normalize ran to completion before encode() started. So
 * normalize's errors (depth, collection size, binary type) throw at once,
 * while encode()'s (its own depth bound of 100, a bigint, symbol or function)
 * wait for the walk to end, and only the first is made and thrown; past it the
 * walk runs normalize's checks and writes nothing. What encode() read from the
 * copy rather than the caller's value, a Uint8Array's bytes and any object
 * normalize returned, is written in after the walk too, so a getter that
 * changes it later in the walk changes the result as it did before, and an
 * ExtData sees its offset in the stream.
 *
 * A rejected write is bounded, not free: before a late segment shows that
 * encode() would have stopped, the walk writes what follows it, but never more
 * than maxEncodedSize; past that it only counts (see `doomed`).
 *
 * Known differences from encode(normalize(value)), all needing user code that
 * changes or misreports the value while it is encoded:
 * - a Proxy whose traps have side effects or answer inconsistently (trap
 *   call counts and order differ);
 * - patched intrinsics: a non-conforming Array.prototype.map, its iterator,
 *   Array[Symbol.species] or Array.prototype.constructor, or an
 *   Array.prototype index set during the walk;
 * - an Object.prototype property that is read-only or an accessor, which
 *   normalize's `result[key] = v` trips over and this does not;
 * - an encoder registered on @msgpack/msgpack's shared default codec;
 * - a function the walk visits itself, or gets back from an array's own map
 *   or species, that a later getter moves onto Date's or ExtData's prototype
 *   (see `callable`; one inside a Map or Set copy is read late, as before);
 * - a typed array or ExtData data whose `length` is not a non-negative
 *   integer, or whose `length` or `byteLength` disagrees with its contents:
 *   encode()'s result then depends on its private buffer's capacity.
 *
 * One instance per module, reused: building a buffer and its views per call
 * costs a write of a small value more than encoding it. The bytes returned are
 * a copy; the buffer is zeroed after every encode, so it never keeps a
 * plaintext value, and dropped once it outgrows VALUE_ENCODER_RETAIN. A
 * re-entrant call (a getter on the value writing to a cache) gets an instance
 * of its own. Package-internal: exported for its tests.
 */
export class ValueEncoder {
  private bytes!: Uint8Array;
  private view!: DataView;
  private pos = 0;
  private entered = false;
  /** Makes encode()'s first error, when it is thrown. */
  private deferred: (() => Error) | undefined;
  /** Set once encode() would have stopped: the walk then only runs normalize's checks. */
  private skip = false;
  /** Set while the late segments are written: encode()'s errors then throw at once. */
  private finishing = false;
  /**
   * What encode() read only after normalize had finished, and user code later
   * in the walk can still change: a Uint8Array's bytes, which normalize's copy
   * shares with the caller's buffer, and every object or function normalize
   * returned or the value holds. Written in, where they go, once the walk ends.
   */
  private segments: { at: number; copy: object; depth: number }[] = [];
  /**
   * Set once the output passes maxEncodedSize, when the result can only be an
   * error: writers then only count, so the error still names the exact size
   * and an ExtData still sees its offset, but nothing more is allocated.
   */
  private doomed = false;
  /** The output's length once the late segments are counted in. */
  private size = 0;
  /** While splicing, walked bytes still to be copied after the current segment. */
  private toCopy = 0;
  private maxEncodedSize = 0;
  private maxDepth = 0;
  private maxCollectionSize = 0;
  private walk: NormalizeWalk = { forKey: false, objects: 0, values: 0 };

  constructor() {
    this.reset(VALUE_ENCODER_BUFFER);
  }

  encode(value: unknown, config: SerializerConfig, walk: NormalizeWalk): Uint8Array {
    if (this.entered) return new ValueEncoder().encode(value, config, walk);
    this.entered = true;
    this.pos = 0;
    this.maxEncodedSize = config.maxEncodedSize;
    this.maxDepth = config.maxDepth;
    this.maxCollectionSize = config.maxCollectionSize;
    this.walk = walk;
    try {
      this.value(value, 0);
      return this.finish();
    } finally {
      // State first: if zeroing threw (at the stack limit), this encoder
      // would otherwise stay entered for good.
      this.deferred = undefined;
      this.skip = false;
      this.doomed = false;
      this.segments.length = 0;
      this.entered = false;
      // Zero the buffer this keeps; one it drops is garbage, as encode()'s are.
      if (this.bytes.length > VALUE_ENCODER_RETAIN) this.reset(VALUE_ENCODER_BUFFER);
      else this.bytes.fill(0, 0, this.pos);
    }
  }

  /**
   * The walk's result: its bytes with the segments written in, or encode()'s
   * first error, or, past maxEncodedSize, the size error encodeCounted makes.
   */
  private finish(): Uint8Array {
    // Nothing is added past encode()'s first error, so it reached every segment.
    this.size = this.pos;
    const encoded = this.segments.length ? this.splice() : EMPTY;
    if (this.deferred) throw this.deferred();
    if (this.doomed) throw encodedTooLarge(this.size, this.maxEncodedSize);
    if (this.segments.length) return encoded;
    // A buffer this drops can be handed over as it is; one it keeps is copied.
    return this.bytes.length > VALUE_ENCODER_RETAIN
      ? this.bytes.subarray(0, this.pos)
      : this.bytes.slice(0, this.pos);
  }

  /**
   * An encode() error. In the walk, the first is held until normalize would
   * have finished, and nothing after it is written; in a late segment it
   * throws, being earlier than any held one.
   */
  private defer(error: () => Error): void {
    if (this.finishing) throw error();
    if (this.deferred) return;
    this.deferred = error;
    this.skip = true;
  }

  /** A part of normalize's copy, for encode() to read after the walk. */
  private late(copy: object, depth: number): void {
    if (!this.skip) this.segments.push({ at: this.pos, copy, depth });
  }

  /** normalize(value, depth) then encode() at depth + 1, as one step. */
  private value(value: unknown, depth: number): void {
    if (depth > this.maxDepth) throw tooDeep(this.maxDepth);
    if (depth >= MSGPACK_MAX_DEPTH) {
      this.defer(() => new Error(`Too deep objects in depth ${depth + 1}`));
    }
    switch (typeof value) {
      case 'undefined':
        return this.u8(0xc0);
      case 'boolean':
        return this.u8(value ? 0xc3 : 0xc2);
      case 'number':
        return this.number(value);
      case 'string':
        return this.string(value);
      case 'object':
        break;
      case 'function':
        return this.callable(value, depth);
      default:
        return this.defer(() => unrecognized(value));
    }
    if (value === null) return this.u8(0xc0);
    if (Array.isArray(value)) return this.array(value as unknown[], depth);
    if (value instanceof Date || value instanceof Map || value instanceof Set) {
      return this.delegate(value, depth);
    }
    const bin = binary(value);
    if (bin) {
      this.walk.objects++;
      if (bin[0] !== 'Uint8Array') throw binaryValueError(bin[0]);
      return this.late(bin[1], depth + 1);
    }
    this.object(value as Record<string, unknown>, depth);
  }

  private array(value: unknown[], depth: number): void {
    const { length } = value;
    if (length > this.maxCollectionSize) {
      throw tooLarge('Array size', length, this.maxCollectionSize);
    }
    // normalize copies with value.map(), which an own `map` replaces, and
    // which builds its copy from value.constructor (its species). Checked
    // without reading either, so normalize still reads each once.
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.hasOwn(value, 'constructor') ||
      Object.hasOwn(value, 'map')
    ) {
      return this.delegate(value, depth);
    }
    this.walk.objects++;
    this.walk.values += length;
    this.arrayHeader(length);
    for (let i = 0; i < length; i++) {
      // map()'s order: whether the element exists, then its value.
      if (i in value) {
        this.value(value[i], depth + 1);
      } else {
        // A hole: map() skips it, and encode() reads it from the copy as undefined.
        this.normalized(undefined, depth + 2);
      }
    }
  }

  private object(value: Record<string, unknown>, depth: number): void {
    const keys = Object.keys(value);
    if (keys.length > this.maxCollectionSize) {
      throw tooLarge('Object key count', keys.length, this.maxCollectionSize);
    }
    for (const key of keys) {
      const c = key.charCodeAt(0);
      if ((c >= 48 && c <= 57 && INDEX_KEY.test(key)) || key === '__proto__') {
        const copy = normalizeObject(
          value,
          keys,
          depth,
          this.maxDepth,
          this.maxCollectionSize,
          this.walk
        );
        return this.late(copy, depth + 1);
      }
    }
    this.walk.objects++;
    this.walk.values += keys.length;
    keys.sort();
    this.mapHeader(keys.length);
    for (const key of keys) {
      this.string(key);
      this.value(value[key], depth + 1);
    }
  }

  private delegate(value: object, depth: number): void {
    const copy = normalize(value, depth, this.maxDepth, this.maxCollectionSize, this.walk);
    // A Date's copy is a string, which nothing can change before encode()
    // reads it; an object or function (a Map's copy, or whatever an array's
    // species built) can be, by a getter later in the walk.
    if (copy !== null && typeof copy === 'object') this.late(copy, depth + 1);
    else if (typeof copy === 'function') this.callable(copy, depth);
    else this.normalized(copy, depth + 1);
  }

  /**
   * A function at depth + 1. encode() asks the codec about it too, and the
   * built-in one encodes a function on Date's or ExtData's prototype, so such
   * a function is read after the walk. Any other is encode()'s Unrecognized
   * object error, held so the rest of a rejected write is never written.
   * Known difference: the prototype is checked here, during the walk, so a
   * function that a later getter moves onto Date's or ExtData's prototype is
   * still rejected, where encode() would have encoded it.
   */
  private callable(fn: unknown, depth: number): void {
    if (fn instanceof Date || fn instanceof ExtData) this.late(fn as object, depth + 1);
    else this.defer(() => unrecognized(fn));
  }

  /**
   * @msgpack/msgpack 3.1.3 Encoder.doEncode with default options, for a value
   * normalize has already copied. It counts nothing and reads only what encode()
   * would read from that copy.
   */
  private normalized(value: unknown, depth: number): void {
    if (depth > MSGPACK_MAX_DEPTH) {
      return this.defer(() => new Error(`Too deep objects in depth ${depth}`));
    }
    if (value == null) return this.u8(0xc0);
    if (typeof value === 'boolean') return this.u8(value ? 0xc3 : 0xc2);
    if (typeof value === 'number') return this.number(value);
    if (typeof value === 'string') return this.string(value);
    // An ExtData, or a Date (the timestamp ext) that an array's species or own
    // map put in normalize's copy, or a function with either prototype.
    const ext = ExtensionCodec.defaultCodec.tryToEncode(value, undefined);
    if (ext != null) return this.extension(ext);
    if (Array.isArray(value)) {
      this.arrayHeader(value.length);
      for (const item of value) this.normalized(item, depth + 1);
    } else if (ArrayBuffer.isView(value)) {
      this.bin(value);
    } else if (typeof value === 'object') {
      const map = value as Record<string, unknown>;
      const keys = Object.keys(map);
      this.mapHeader(keys.length);
      for (const key of keys) {
        this.string(key);
        this.normalized(map[key], depth + 1);
      }
    } else {
      this.defer(() => unrecognized(value));
    }
  }

  /**
   * The walk's bytes with the segments written in, where and as encode()
   * wrote them, in its stream's coordinates. Sized for the walk and the
   * binaries, with slack for object segments; one that needs more grows it.
   * Unless the buffer ends up exactly full, the result is a view of it, as
   * encode()'s was.
   */
  private splice(): Uint8Array {
    const read = this.segments.length;
    const walked = this.bytes;
    const walkedView = this.view;
    const end = this.pos;
    // An object segment's size is unknown until it is written: leave room
    // for small ones, so a large walked prefix is not copied again to grow.
    let size = end;
    let slack = 0;
    for (let i = 0; i < read; i++) {
      const { copy } = this.segments[i];
      if (!ArrayBuffer.isView(copy)) {
        slack = Math.max(1024, end >> 3);
        continue;
      }
      // Through the intrinsic getter: a caller's own byteLength getter runs
      // only when bin() reaches this segment, as in encode().
      const length = intrinsicByteLength(copy);
      if (length >= 0x100000000) break; // bin() throws when it gets there
      size += (length < 0x100 ? 2 : length < 0x10000 ? 3 : 5) + length;
    }
    if (size > this.maxEncodedSize) this.doomed = true;
    // Doomed, every write takes ensure()'s slow path, which only counts.
    if (this.doomed) {
      this.bytes = EMPTY;
      this.view = new DataView(EMPTY.buffer);
    } else {
      this.reset(size + slack);
    }
    this.pos = 0;
    this.skip = false;
    this.finishing = true;
    try {
      let from = 0;
      for (let i = 0; i < read; i++) {
        const { at, copy, depth } = this.segments[i];
        this.raw(walked.subarray(from, at));
        this.toCopy = end - at;
        this.normalized(copy, depth);
        from = at;
      }
      this.toCopy = 0;
      this.raw(walked.subarray(from, end));
      this.size = this.pos;
      if (this.doomed) return EMPTY;
      return this.bytes.length === this.pos ? this.bytes : this.bytes.subarray(0, this.pos);
    } finally {
      this.finishing = false;
      this.bytes = walked;
      this.view = walkedView;
      this.pos = end;
    }
  }

  // The writers below produce @msgpack/msgpack 3.1.3's bytes for each type.

  private number(n: number): void {
    if (this.skip) return;
    if (this.pos + 9 > this.bytes.length && !this.ensure(numberSize(n))) return;
    const view = this.view;
    let pos = this.pos;
    if (Number.isSafeInteger(n)) {
      if (n >= 0) {
        if (n < 0x80) {
          view.setUint8(pos++, n);
        } else if (n < 0x100) {
          view.setUint8(pos++, 0xcc);
          view.setUint8(pos++, n);
        } else if (n < 0x10000) {
          view.setUint8(pos++, 0xcd);
          view.setUint16(pos, n);
          pos += 2;
        } else if (n < 0x100000000) {
          view.setUint8(pos++, 0xce);
          view.setUint32(pos, n);
          pos += 4;
        } else {
          view.setUint8(pos++, 0xcf);
          view.setUint32(pos, n / 0x100000000);
          view.setUint32(pos + 4, n);
          pos += 8;
        }
      } else if (n >= -0x20) {
        view.setUint8(pos++, 0xe0 | (n + 0x20));
      } else if (n >= -0x80) {
        view.setUint8(pos++, 0xd0);
        view.setInt8(pos++, n);
      } else if (n >= -0x8000) {
        view.setUint8(pos++, 0xd1);
        view.setInt16(pos, n);
        pos += 2;
      } else if (n >= -0x80000000) {
        view.setUint8(pos++, 0xd2);
        view.setInt32(pos, n);
        pos += 4;
      } else {
        view.setUint8(pos++, 0xd3);
        view.setUint32(pos, Math.floor(n / 0x100000000));
        view.setUint32(pos + 4, n);
        pos += 8;
      }
    } else {
      view.setUint8(pos++, 0xcb);
      view.setFloat64(pos, n);
      pos += 8;
    }
    this.pos = pos;
  }

  private string(s: string): void {
    if (this.skip) return;
    const byteLength = utf8Count(s);
    if (byteLength >= 0x100000000) {
      throw new Error(`Too long string: ${byteLength} bytes in UTF-8`);
    }
    const header = byteLength < 32 ? 1 : byteLength < 0x100 ? 2 : byteLength < 0x10000 ? 3 : 5;
    if (!this.ensure(header + byteLength)) return;
    if (byteLength < 32) {
      this.bytes[this.pos++] = 0xa0 + byteLength;
    } else if (byteLength < 0x100) {
      this.bytes[this.pos++] = 0xd9;
      this.bytes[this.pos++] = byteLength;
    } else if (byteLength < 0x10000) {
      this.bytes[this.pos++] = 0xda;
      this.view.setUint16(this.pos, byteLength);
      this.pos += 2;
    } else if (byteLength < 0x100000000) {
      this.bytes[this.pos++] = 0xdb;
      this.view.setUint32(this.pos, byteLength);
      this.pos += 4;
    }
    // The two encoders differ on a lone surrogate: TextEncoder writes U+FFFD.
    if (s.length > TEXT_ENCODER_THRESHOLD) {
      textEncoder.encodeInto(s, this.bytes.subarray(this.pos));
    } else {
      utf8EncodeJs(s, this.bytes, this.pos);
    }
    this.pos += byteLength;
  }

  private bin(value: ArrayBufferView): void {
    const size = value.byteLength;
    if (size < 0x100) {
      this.head(0xc4, 1, size);
    } else if (size < 0x10000) {
      this.head(0xc5, 2, size);
    } else if (size < 0x100000000) {
      this.head(0xc6, 4, size);
    } else {
      throw new Error(`Too large binary: ${size}`);
    }
    this.raw(
      value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    );
  }

  private arrayHeader(size: number): void {
    if (size < 16) {
      this.u8(0x90 + size);
    } else if (size < 0x10000) {
      this.head(0xdc, 2, size);
    } else if (size < 0x100000000) {
      this.head(0xdd, 4, size);
    } else {
      throw new Error(`Too large array: ${size}`);
    }
  }

  private mapHeader(size: number): void {
    if (size < 16) {
      this.u8(0x80 + size);
    } else if (size < 0x10000) {
      this.head(0xde, 2, size);
    } else if (size < 0x100000000) {
      this.head(0xdf, 4, size);
    } else {
      throw new Error(`Too large map object: ${size}`);
    }
  }

  private extension(ext: ExtData): void {
    if (typeof ext.data === 'function') {
      // The data may depend on where it lands in the stream.
      const data = ext.data(this.pos + 6);
      const size = data.length; // read as often as encode() reads it
      if (size >= 0x100000000) throw new Error(`Too large extension object: ${size}`);
      this.head(0xc9, 4, size);
      this.i8(ext.type);
      return this.raw(data);
    }
    const size = ext.data.length;
    if (size === 1) this.u8(0xd4);
    else if (size === 2) this.u8(0xd5);
    else if (size === 4) this.u8(0xd6);
    else if (size === 8) this.u8(0xd7);
    else if (size === 16) this.u8(0xd8);
    else if (size < 0x100) this.head(0xc7, 1, size);
    else if (size < 0x10000) this.head(0xc8, 2, size);
    else if (size < 0x100000000) this.head(0xc9, 4, size);
    else throw new Error(`Too large extension object: ${size}`);
    this.i8(ext.type);
    this.raw(ext.data);
  }

  // Every writer the walk reaches is a no-op while `skip` is set, so nothing
  // it writes past encode()'s first error costs a byte; a new walk-path writer
  // must check it too. bin() and extension() are not: they run user code (a
  // length getter, ExtData data) before their first checked write, and are
  // reached only from splice(), where `skip` is off.

  /** A type byte and a big-endian length of `width` bytes. */
  private head(type: number, width: 1 | 2 | 4, size: number): void {
    if (this.skip || !this.ensure(1 + width)) return;
    this.bytes[this.pos++] = type;
    if (width === 1) this.bytes[this.pos] = size;
    else if (width === 2) this.view.setUint16(this.pos, size);
    else this.view.setUint32(this.pos, size);
    this.pos += width;
  }

  private u8(byte: number): void {
    if (this.skip || !this.ensure(1)) return;
    this.bytes[this.pos++] = byte;
  }

  private i8(value: number): void {
    if (this.skip || !this.ensure(1)) return;
    this.view.setInt8(this.pos++, value);
  }

  private raw(bytes: Uint8Array): void {
    if (this.skip) return;
    const size = bytes.length; // read once, as encode()'s writeU8a does
    if (!this.ensure(size)) {
      // encode() would still have copied it: throw as its set() would for a
      // detached view, and read an array-like's elements as set() does.
      if (!ArrayBuffer.isView(bytes)) new Uint8Array(size).set(bytes);
      else if (intrinsicByteLength(bytes) === 0) ONE_BYTE.set(bytes);
      return;
    }
    this.bytes.set(bytes, this.pos);
    this.pos += size;
  }

  /**
   * Room for `size` more bytes, growing the buffer as encode() grew its own.
   * Past maxEncodedSize it only advances `pos` by `size` and returns false:
   * the writer then stores nothing.
   */
  private ensure(size: number): boolean {
    const required = this.pos + size;
    if (required <= this.bytes.length) return true;
    if (this.doomed || required > this.maxEncodedSize) {
      this.doomed = true;
      this.pos = required;
      return false;
    }
    const written = this.bytes.subarray(0, this.pos);
    // A spliced output grows by what is still to come, not by doubling a
    // large prefix again, but at least geometrically, so a large segment is
    // not copied once per write.
    this.reset(this.finishing ? required + Math.max(this.toCopy, required >> 3) : required * 2);
    this.bytes.set(written);
    return true;
  }

  private reset(size: number): void {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
}

/** How many bytes ValueEncoder.number() writes for `n`. */
function numberSize(n: number): number {
  if (!Number.isSafeInteger(n)) return 9;
  if (n >= 0) return n < 0x80 ? 1 : n < 0x100 ? 2 : n < 0x10000 ? 3 : n < 0x100000000 ? 5 : 9;
  return n >= -0x20 ? 1 : n >= -0x80 ? 2 : n >= -0x8000 ? 3 : n >= -0x80000000 ? 5 : 9;
}

/** @msgpack/msgpack 3.1.3's utf8Count: a lone surrogate counts 3 bytes. */
function utf8Count(s: string): number {
  const length = s.length;
  let count = 0;
  let pos = 0;
  while (pos < length) {
    let value = s.charCodeAt(pos++);
    if ((value & 0xffffff80) === 0) {
      count++;
    } else if ((value & 0xfffff800) === 0) {
      count += 2;
    } else {
      if (value >= 0xd800 && value <= 0xdbff && pos < length) {
        const extra = s.charCodeAt(pos);
        if ((extra & 0xfc00) === 0xdc00) {
          ++pos;
          value = ((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000;
        }
      }
      count += (value & 0xffff0000) === 0 ? 3 : 4;
    }
  }
  return count;
}

/** @msgpack/msgpack 3.1.3's utf8EncodeJs: a lone surrogate is written as is (WTF-8). */
function utf8EncodeJs(s: string, output: Uint8Array, offset: number): void {
  const length = s.length;
  let pos = 0;
  while (pos < length) {
    let value = s.charCodeAt(pos++);
    if ((value & 0xffffff80) === 0) {
      output[offset++] = value;
      continue;
    } else if ((value & 0xfffff800) === 0) {
      output[offset++] = ((value >> 6) & 0x1f) | 0xc0;
    } else {
      if (value >= 0xd800 && value <= 0xdbff && pos < length) {
        const extra = s.charCodeAt(pos);
        if ((extra & 0xfc00) === 0xdc00) {
          ++pos;
          value = ((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000;
        }
      }
      if ((value & 0xffff0000) === 0) {
        output[offset++] = ((value >> 12) & 0x0f) | 0xe0;
        output[offset++] = ((value >> 6) & 0x3f) | 0x80;
      } else {
        output[offset++] = ((value >> 18) & 0x07) | 0xf0;
        output[offset++] = ((value >> 12) & 0x3f) | 0x80;
        output[offset++] = ((value >> 6) & 0x3f) | 0x80;
      }
    }
    output[offset++] = (value & 0x3f) | 0x80;
  }
}

const valueEncoder = new ValueEncoder();

/**
 * MessagePackSerializer.encode, adding the value's object and value counts to
 * `count` once the bytes pass the size check. Package-internal.
 */
export function encodeCounted<T>(
  value: T,
  config: SerializerConfig,
  count?: ObjectCount
): Uint8Array {
  // The bytes of encode(normalize(value)), from one walk (also checks depth
  // and collection size)
  const walk = { forKey: false, objects: 0, values: 0 };
  const encoded = valueEncoder.encode(value, config, walk);

  // Check encoded size
  if (encoded.length > config.maxEncodedSize) {
    throw encodedTooLarge(encoded.length, config.maxEncodedSize);
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
 * for good as a cheap post-decode backstop for the hand-rolled pre-scan: if the
 * walker ever under-counts depth, this still catches it before the value is
 * returned.
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
  // collections — the per-collection cap alone lets nested headers
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

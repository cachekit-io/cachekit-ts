import { decode as msgpackDecode } from '@msgpack/msgpack';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ConfigurationError, SerializationError, ValueTooLargeError } from '../errors.js';
import { assertDecodeDepth, boundedDecodeOptions } from './serializer.js';
import {
  DEFAULT_MAX_ENCODED_SIZE,
  DEFAULT_MAX_DECODED_SIZE,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_COLLECTION_SIZE,
  KEY_GEN_MAX_DEPTH,
} from '../constants.js';

/**
 * Interop mode (interop/v1) — protocol/spec/interop-mode.md.
 *
 * Language-neutral key format and plain-MessagePack value format for sharing
 * cache entries across the Python, Rust, and TypeScript SDKs. Byte-verified
 * against protocol/test-vectors/interop-mode.json.
 *
 * Key format: `{namespace}:{operation}:{args_hash}` where args_hash is
 * Blake2b-256 (lowercase hex) over the canonical MessagePack encoding of the
 * flat argument array.
 *
 * JS-specific rules (see spec "The Interop Data Model"):
 * - Integers beyond `Number.isSafeInteger` (|n| > 2^53) MUST be passed as
 *   `BigInt` — a `number` cannot represent them exactly, and the SDK cannot
 *   detect precision already lost at the call site.
 * - A `number` argument has float64 semantics: NaN/±Infinity are rejected;
 *   an integral value in [-2^63, 2^64) encodes as a msgpack int (number
 *   canonicalization — the `float_collapse_lower_bound` vector pins that this
 *   applies to the FULL range, not just safe integers); anything else encodes
 *   as float64.
 * - Strings must be well-formed Unicode (`String.prototype.isWellFormed`) —
 *   a lone surrogate is rejected, never U+FFFD-replaced (silent replacement
 *   would be a silent cross-SDK key collision).
 * - Map keys sort by UTF-8 byte order == Unicode code point order, NOT the
 *   default `Array.prototype.sort` (UTF-16 code-unit order is wrong for
 *   supplementary-plane characters).
 * - Interop-wrapped functions MUST NOT use default parameters; callers MUST
 *   pass the full declared arity (an `undefined` argument is rejected).
 */

/** Segment grammar for interop namespace/operation (full-string match). */
export const INTEROP_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Exact float64 bounds for the integral-collapse range check. Both are powers
// of two, hence exactly representable; 2^64-1 is NOT (it rounds up to 2^64),
// so the upper bound must be 2^64 with a strict less-than.
const F64_UPPER_EXCL = 18446744073709551616.0; // 2^64
const F64_LOWER_INCL = -9223372036854775808.0; // -(2^63)
const UINT64_MAX = 18446744073709551615n;
const INT64_MIN = -9223372036854775808n;

// CK v3 frame magic ("CK") — the Python SDK's private auto-mode container.
// It is NOT a cross-SDK format (protocol wire-format.md "SDK Storage
// Containers"); surfacing it by name beats a generic decode error.
const CK_FRAME_MAGIC_0 = 0x43;
const CK_FRAME_MAGIC_1 = 0x4b;

const textEncoder = new TextEncoder();

/** Profile selector: args are hashed (strict arity), values round-trip. */
type InteropProfile = 'args' | 'value';

/**
 * Declared-float64 wrapper (mirrors the reference implementation's Float
 * class). A bare `number` argument that is integral but beyond
 * `Number.isSafeInteger` is REJECTED — the SDK cannot tell an exact float64
 * quantity from an integer that already lost precision at the call site, and
 * hashing the rounded neighbour of an ID is a silent wrong-key hit. Wrapping
 * in `InteropFloat` declares "this value has float64 semantics", opting into
 * the spec's raw number canonicalization for the full [-2^63, 2^64) collapse
 * range. Not re-exported from the package index; used by the protocol vector
 * harness to express the spec's `$float` inputs.
 */
export class InteropFloat {
  constructor(readonly value: number) {}
}

/**
 * Validate an interop key segment against the interop/v1 grammar.
 *
 * Rejection happens at wrap/registration time, never silently normalized.
 * The pattern uses an anchored full-string match — RegExp.test with ^...$
 * and no `m` flag cannot match past a newline, so `"users\n"` fails here
 * (the `reject_trailing_newline` vector).
 *
 * @throws {ConfigurationError} if the segment does not match the grammar
 */
export function validateInteropSegment(kind: 'namespace' | 'operation', value: string): void {
  if (!INTEROP_SEGMENT_PATTERN.test(value)) {
    throw new ConfigurationError(
      `Invalid interop ${kind} ${JSON.stringify(value)}: must full-string match ` +
        `^[a-z0-9][a-z0-9._-]{0,63}$ (lowercase ASCII letters, digits, '.', '_', '-'; 1-64 chars)`
    );
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return a[i]! - b[i]!;
    }
  }
  return a.length - b.length;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Chunk accumulator with a running byte budget. Oversized payloads are
 * rejected as soon as the budget is crossed — during traversal, before the
 * complete encoded buffer is materialised. All appends MUST go through
 * `pushChunk` so the budget stays exact.
 */
interface ChunkSink {
  chunks: Uint8Array[];
  /**
   * Running budget cursor. Set element sub-encodes seed it with the parent
   * total (so it may exceed the total length of `chunks`), capping any single
   * element; the aggregate across retained elements is charged separately in
   * the Set loop, after dedupe.
   */
  bytes: number;
}

function pushChunk(sink: ChunkSink, c: Uint8Array): void {
  sink.bytes += c.length;
  if (sink.bytes > DEFAULT_MAX_ENCODED_SIZE) {
    throw new ValueTooLargeError(
      `Encoded interop payload exceeds max size ${DEFAULT_MAX_ENCODED_SIZE}`
    );
  }
  sink.chunks.push(c);
}

function uintBE(marker: number, value: number | bigint, byteLength: 1 | 2 | 4 | 8): Uint8Array {
  const out = new Uint8Array(1 + byteLength);
  out[0] = marker;
  const view = new DataView(out.buffer);
  if (byteLength === 1) view.setUint8(1, Number(value));
  else if (byteLength === 2) view.setUint16(1, Number(value), false);
  else if (byteLength === 4) view.setUint32(1, Number(value), false);
  else view.setBigUint64(1, BigInt(value), false);
  return out;
}

function intBE(marker: number, value: number | bigint, byteLength: 1 | 2 | 4 | 8): Uint8Array {
  const out = new Uint8Array(1 + byteLength);
  out[0] = marker;
  const view = new DataView(out.buffer);
  if (byteLength === 1) view.setInt8(1, Number(value));
  else if (byteLength === 2) view.setInt16(1, Number(value), false);
  else if (byteLength === 4) view.setInt32(1, Number(value), false);
  else view.setBigInt64(1, BigInt(value), false);
  return out;
}

/** Shortest-form msgpack int (canonical encoding is normative for hashing). */
function encodeInt(n: bigint, sink: ChunkSink): void {
  if (n < INT64_MIN || n > UINT64_MAX) {
    throw new SerializationError(`Integer out of interop range [-2^63, 2^64-1]: ${n}`);
  }
  if (n >= 0n && n <= 0x7fn) {
    pushChunk(sink, Uint8Array.of(Number(n)));
  } else if (n >= -32n && n < 0n) {
    pushChunk(sink, Uint8Array.of(Number(n) & 0xff));
  } else if (n > 0n) {
    if (n <= 0xffn) pushChunk(sink, uintBE(0xcc, n, 1));
    else if (n <= 0xffffn) pushChunk(sink, uintBE(0xcd, n, 2));
    else if (n <= 0xffffffffn) pushChunk(sink, uintBE(0xce, n, 4));
    else pushChunk(sink, uintBE(0xcf, n, 8));
  } else if (n >= -128n) {
    pushChunk(sink, intBE(0xd0, n, 1));
  } else if (n >= -32768n) {
    pushChunk(sink, intBE(0xd1, n, 2));
  } else if (n >= -2147483648n) {
    pushChunk(sink, intBE(0xd2, n, 4));
  } else {
    pushChunk(sink, intBE(0xd3, n, 8));
  }
}

function encodeFloat64(f: number, sink: ChunkSink): void {
  const out = new Uint8Array(9);
  out[0] = 0xcb;
  new DataView(out.buffer).setFloat64(1, f, false);
  pushChunk(sink, out);
}

function encodeStrBytes(utf8: Uint8Array, sink: ChunkSink): void {
  const n = utf8.length;
  if (n <= 31) pushChunk(sink, Uint8Array.of(0xa0 | n));
  else if (n <= 0xff) pushChunk(sink, uintBE(0xd9, n, 1));
  else if (n <= 0xffff) pushChunk(sink, uintBE(0xda, n, 2));
  else pushChunk(sink, uintBE(0xdb, n, 4));
  pushChunk(sink, utf8);
}

/**
 * UTF-8 encode a string, rejecting lone surrogates. TextEncoder would
 * silently emit U+FFFD for an unpaired surrogate — on the args path that is
 * a silent key collision, so the spec mandates an error instead.
 */
function utf8Strict(s: string): Uint8Array {
  if (!s.isWellFormed()) {
    throw new SerializationError(
      'Interop strings must be well-formed Unicode (no lone surrogates)'
    );
  }
  return textEncoder.encode(s);
}

function encodeBin(b: Uint8Array, sink: ChunkSink): void {
  const n = b.length;
  if (n <= 0xff) pushChunk(sink, uintBE(0xc4, n, 1));
  else if (n <= 0xffff) pushChunk(sink, uintBE(0xc5, n, 2));
  else pushChunk(sink, uintBE(0xc6, n, 4));
  pushChunk(sink, b);
}

// DoS cap on collection sizes, mirroring the auto-mode serializer and the
// decode-side bounds — keeps write/read symmetric (what the SDK writes, the
// SDK can always read back). The spec's *32 width tier stays implemented in
// the ladder; the cap bounds what is reachable through the SDK, exactly as
// auto mode's maxCollectionSize does.
function checkCollectionSize(n: number, kind: 'array' | 'map'): void {
  if (n > DEFAULT_MAX_COLLECTION_SIZE) {
    throw new ValueTooLargeError(
      `Interop ${kind} size ${n} exceeds max collection size ${DEFAULT_MAX_COLLECTION_SIZE}`
    );
  }
}

function encodeArrayHeader(n: number, sink: ChunkSink): void {
  checkCollectionSize(n, 'array');
  if (n <= 15) pushChunk(sink, Uint8Array.of(0x90 | n));
  else if (n <= 0xffff) pushChunk(sink, uintBE(0xdc, n, 2));
  else pushChunk(sink, uintBE(0xdd, n, 4));
}

function encodeMapHeader(n: number, sink: ChunkSink): void {
  checkCollectionSize(n, 'map');
  if (n <= 15) pushChunk(sink, Uint8Array.of(0x80 | n));
  else if (n <= 0xffff) pushChunk(sink, uintBE(0xde, n, 2));
  else pushChunk(sink, uintBE(0xdf, n, 4));
}

/**
 * Number canonicalization for DECLARED float64 semantics (spec:
 * "encode_number") — the path for `InteropFloat` and normalized datetimes.
 * Args profile: integral values in [-2^63, 2^64) collapse to msgpack int
 * (subsumes -0 -> int 0; the collapse bounds are exact powers of two).
 * Value profile: no collapse — floats stay float64 for round-trip fidelity.
 */
function encodeDeclaredFloat(f: number, profile: InteropProfile, sink: ChunkSink): void {
  if (!Number.isFinite(f)) {
    throw new SerializationError('NaN and Infinity are not allowed in interop mode');
  }
  if (profile === 'args' && Number.isInteger(f) && f >= F64_LOWER_INCL && f < F64_UPPER_EXCL) {
    encodeInt(BigInt(f), sink);
  } else {
    encodeFloat64(f, sink);
  }
}

/**
 * Bare JS `number` handling. A JS number IS a float64, so integral values
 * encode as msgpack int in both profiles (JS cannot distinguish 2.0 from 2 —
 * the spec's "a JS-written 2 may come back to Python as int" caveat), with
 * two guards:
 * - Integral values in the collapse range but beyond `Number.isSafeInteger`
 *   are REJECTED (spec: "the SDK MUST error on a non-integral-safe Number
 *   rather than silently rounding") — a snowflake ID that already rounded at
 *   the call site would otherwise hash to its float64 neighbour's key, a
 *   silent wrong-key hit. Exact integers there must be BigInt; exact float64
 *   quantities must be `InteropFloat`. At or above 2^64 there is no int
 *   ambiguity — the value encodes as float64 exactly as Python/Rust encode
 *   the same float (`float_large_integral_out_of_range` vector).
 * - The value profile preserves -0 as float64, the one JS-expressible case
 *   of "the value profile does not collapse floats".
 */
function encodeNumber(f: number, profile: InteropProfile, sink: ChunkSink): void {
  if (!Number.isFinite(f)) {
    throw new SerializationError('NaN and Infinity are not allowed in interop mode');
  }
  if (Number.isInteger(f) && f >= F64_LOWER_INCL && f < F64_UPPER_EXCL) {
    if (!Number.isSafeInteger(f)) {
      throw new SerializationError(
        `Integral number ${f} is beyond Number.isSafeInteger and cannot be trusted for exact ` +
          'hashing — pass integers beyond 2^53 as BigInt (or wrap an exact float64 quantity ' +
          'in InteropFloat)'
      );
    }
    if (profile === 'value' && Object.is(f, -0)) {
      encodeFloat64(f, sink);
      return;
    }
    encodeInt(BigInt(f), sink);
  } else {
    encodeFloat64(f, sink);
  }
}

/**
 * Normalize a JS Date to the interop argument datetime rule: integer
 * microseconds since epoch, then ONE IEEE 754 float64 division by 10^6
 * (bit-deterministic across languages). Date carries integer milliseconds,
 * so the multiply by 1000 is exact in BigInt.
 */
function dateToUnixFloat64(d: Date): number {
  const ms = d.getTime();
  if (Number.isNaN(ms)) {
    throw new SerializationError('Invalid Date is not allowed in interop arguments');
  }
  return Number(BigInt(ms) * 1000n) / 1_000_000.0;
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

function encodeMapEntries(
  entries: [string, unknown][],
  profile: InteropProfile,
  depth: number,
  sink: ChunkSink
): void {
  // Cap BEFORE materialising key encodings: map keys are unique by
  // construction, so the entry count is final up front — unlike Sets, no
  // dedupe can shrink it. Checking here (rather than in encodeMapHeader
  // after the map/sort below) keeps an over-cap map from forcing N
  // Uint8Array allocations plus an O(N log N) sort that never pass through
  // pushChunk's byte budget.
  checkCollectionSize(entries.length, 'map');
  // Sort keys by UTF-8 byte order (== Unicode code point order). The default
  // Array.prototype.sort comparator orders UTF-16 code units and gets
  // supplementary-plane characters backwards (map_key_sort_supplementary).
  const encodedKeys = entries.map(([k, v]) => [utf8Strict(k), v] as [Uint8Array, unknown]);
  encodedKeys.sort((a, b) => compareBytes(a[0], b[0]));
  encodeMapHeader(encodedKeys.length, sink);
  for (const [keyBytes, value] of encodedKeys) {
    encodeStrBytes(keyBytes, sink);
    encodeCanonical(value, profile, depth + 1, sink);
  }
}

function encodeCanonical(
  v: unknown,
  profile: InteropProfile,
  depth: number,
  sink: ChunkSink
): void {
  const maxDepth = profile === 'args' ? KEY_GEN_MAX_DEPTH : DEFAULT_MAX_DEPTH;
  if (depth > maxDepth) {
    throw new SerializationError(`Interop ${profile} structure exceeds max depth of ${maxDepth}`);
  }

  if (v === null) {
    pushChunk(sink, Uint8Array.of(0xc0));
  } else if (v === undefined) {
    // Args are a cross-SDK arity contract: an undefined argument means the
    // caller skipped a declared parameter (interop functions must not use
    // defaults), so it is an error, not nil. Values have no such contract;
    // undefined maps to nil like the auto-mode serializer does.
    if (profile === 'args') {
      throw new SerializationError(
        'undefined is not allowed in interop arguments — interop functions must not use ' +
          'default parameters, and callers must pass the full declared arity'
      );
    }
    pushChunk(sink, Uint8Array.of(0xc0));
  } else if (typeof v === 'boolean') {
    pushChunk(sink, Uint8Array.of(v ? 0xc3 : 0xc2));
  } else if (typeof v === 'bigint') {
    encodeInt(v, sink);
  } else if (typeof v === 'number') {
    encodeNumber(v, profile, sink);
  } else if (v instanceof InteropFloat) {
    encodeDeclaredFloat(v.value, profile, sink);
  } else if (typeof v === 'string') {
    encodeStrBytes(utf8Strict(v), sink);
  } else if (v instanceof Uint8Array) {
    encodeBin(v, sink);
  } else if (v instanceof Date) {
    if (profile === 'args') {
      // Argument datetimes hash by instant: Unix float64 (spec: DateTime
      // determinism), with declared-float semantics — whole seconds collapse
      // to int. JS Date is always an instant — never naive.
      encodeDeclaredFloat(dateToUnixFloat64(v), profile, sink);
    } else {
      // Value datetimes use the wire-format.md sentinel-map convention for
      // round-trip fidelity across SDKs.
      if (Number.isNaN(v.getTime())) {
        throw new SerializationError('Invalid Date is not allowed in interop values');
      }
      const iso = v.toISOString();
      encodeMapEntries(
        [
          ['__datetime__', true],
          ['value', iso],
        ],
        profile,
        depth,
        sink
      );
    }
  } else if (v instanceof Set) {
    // Each element is normalized AND encoded, then elements sort by their
    // encoded bytes (unsigned lexicographic) and dedupe post-normalization —
    // a total, language-neutral order (spec: "Set ordering is not numeric
    // order").
    // Elements encode into isolated sub-sinks (the byte-order sort needs each
    // element's bytes), each seeded from the parent total so no single
    // element can exceed the absolute budget, and dedupe happens on insert.
    // The aggregate byte budget is charged only AFTER an element is confirmed
    // unique — duplicateness is unknowable until encoded, and charging the
    // running total during the re-encode would falsely reject a duplicate
    // bigger than the budget remainder even though the deduped output fits.
    // Both the byte budget and the collection-size cap fail DURING iteration,
    // counting exactly what the output retains: duplicates advance neither
    // total. The parent's own total advances once, on the pushes below.
    const encoded: Uint8Array[] = [];
    const seen = new Set<string>();
    let running = sink.bytes;
    for (const element of v) {
      const sub: ChunkSink = { chunks: [], bytes: sink.bytes };
      encodeCanonical(element, profile, depth + 1, sub);
      const bytes = concatChunks(sub.chunks);
      const key = bytesToHex(bytes);
      if (seen.has(key)) continue;
      seen.add(key);
      checkCollectionSize(seen.size, 'array');
      running += bytes.length;
      if (running > DEFAULT_MAX_ENCODED_SIZE) {
        throw new ValueTooLargeError(
          `Encoded interop payload exceeds max size ${DEFAULT_MAX_ENCODED_SIZE}`
        );
      }
      encoded.push(bytes);
    }
    encoded.sort(compareBytes);
    encodeArrayHeader(encoded.length, sink);
    for (const b of encoded) pushChunk(sink, b);
  } else if (Array.isArray(v)) {
    encodeArrayHeader(v.length, sink);
    for (const item of v) {
      encodeCanonical(item, profile, depth + 1, sink);
    }
  } else if (v instanceof Map) {
    // Map.size is O(1) — reject over-cap maps before iterating at all, so
    // the tuple materialisation below is also bounded.
    checkCollectionSize(v.size, 'map');
    const entries: [string, unknown][] = [];
    for (const [k, val] of v) {
      if (typeof k !== 'string') {
        throw new SerializationError(`Interop map keys must be strings, got ${typeof k}`);
      }
      entries.push([k, val]);
    }
    encodeMapEntries(entries, profile, depth, sink);
  } else if (typeof v === 'object' && isPlainObject(v)) {
    encodeMapEntries(Object.entries(v), profile, depth, sink);
  } else {
    // Closed data model: a value that encodes on one SDK and errors on
    // another is annoying; one that silently encodes DIFFERENTLY is a
    // debugging nightmare. Class instances, functions, symbols etc. are
    // rejected loudly — convert explicitly before caching.
    throw new SerializationError(
      `Type ${typeof v === 'object' ? ((v as object).constructor?.name ?? 'object') : typeof v} ` +
        'is not in the interop data model (spec/interop-mode.md)'
    );
  }
}

function encodeProfile(root: unknown, profile: InteropProfile): Uint8Array {
  const sink: ChunkSink = { chunks: [], bytes: 0 };
  encodeCanonical(root, profile, 0, sink);
  // pushChunk's incremental budget should make this backstop unreachable.
  const out = concatChunks(sink.chunks);
  if (out.length > DEFAULT_MAX_ENCODED_SIZE) {
    throw new ValueTooLargeError(
      `Encoded interop ${profile} size ${out.length} exceeds max ${DEFAULT_MAX_ENCODED_SIZE}`
    );
  }
  return out;
}

/**
 * Canonically encode the flat interop argument array (args profile:
 * number canonicalization applied).
 */
export function encodeInteropArgs(args: readonly unknown[]): Uint8Array {
  return encodeProfile(args, 'args');
}

/** Blake2b-256 (unkeyed, lowercase hex) over the canonical argument array. */
export function interopArgsHash(args: readonly unknown[]): string {
  return bytesToHex(blake2b(encodeInteropArgs(args), { dkLen: 32 }));
}

/**
 * Generate an interop/v1 cache key: `{namespace}:{operation}:{args_hash}`.
 *
 * Identical across the Python, Rust, and TypeScript SDKs for the same
 * operation name and effective argument list. Max length 194 chars — the
 * auto-mode truncation rule never applies.
 *
 * @throws {ConfigurationError} if namespace or operation violate the segment grammar
 * @throws {SerializationError} if an argument is outside the interop data model
 */
export function generateInteropKey(
  namespace: string,
  operation: string,
  args: readonly unknown[]
): string {
  validateInteropSegment('namespace', namespace);
  validateInteropSegment('operation', operation);
  return `${namespace}:${operation}:${interopArgsHash(args)}`;
}

/**
 * Serialize an interop value: one plain MessagePack document in canonical
 * encoding — no ByteStorage envelope, no LZ4, no checksum. Any language with
 * a MessagePack library can read it. Dates become wire-format.md sentinel
 * maps (`{"__datetime__": true, "value": "<ISO-8601>"}`).
 */
export function encodeInteropValue(value: unknown): Uint8Array {
  return encodeProfile(value, 'value');
}

/**
 * One post-decode pass: depth validation, sentinel revival, and int
 * normalization.
 *
 * - Wire-format.md sentinel maps revive: `__datetime__` -> Date. `__date__` /
 *   `__time__` stay as maps — JS has no date-only/time-only type to revive
 *   into, and fabricating a Date instant for them would be wrong.
 * - 64-bit integers decode as BigInt (`useBigInt64`) so a Python-written
 *   integer beyond 2^53 (e.g. a snowflake ID) is never silently rounded on
 *   read; values inside the safe range normalize back to number for
 *   ergonomics. This mirrors the write-side rule (BigInt required beyond
 *   `Number.isSafeInteger`).
 */
function reviveDecoded(v: unknown, depth: number): unknown {
  if (depth > DEFAULT_MAX_DEPTH) {
    throw new SerializationError(
      `Deserialized interop value exceeds max depth of ${DEFAULT_MAX_DEPTH}`
    );
  }
  if (typeof v === 'bigint') {
    return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : v;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = reviveDecoded(v[i], depth + 1);
    return v;
  }
  if (v === null || typeof v !== 'object' || v instanceof Uint8Array) {
    return v;
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 2 && obj['__datetime__'] === true && typeof obj['value'] === 'string') {
    const revived = new Date(obj['value']);
    // Not a parseable instant -> not actually a sentinel; leave the map as-is.
    if (!Number.isNaN(revived.getTime())) {
      return revived;
    }
  }
  for (const k of keys) obj[k] = reviveDecoded(obj[k], depth + 1);
  return obj;
}

/**
 * Deserialize an interop value: exactly one well-formed MessagePack document
 * (canonical or not). Trailing bytes are rejected (@msgpack/msgpack is
 * strict by default). A payload starting with the CK v3 frame magic
 * (`0x43 0x4B`, "CK") gets a targeted diagnostic — it is a
 * Python-SDK-internal auto-mode entry, not an interop value.
 *
 * @throws {SerializationError} on malformed input or a CK-frame payload
 * @throws {ValueTooLargeError} if input exceeds the decode size cap
 */
export function decodeInteropValue<T>(data: Uint8Array): T {
  if (data.length >= 2 && data[0] === CK_FRAME_MAGIC_0 && data[1] === CK_FRAME_MAGIC_1) {
    throw new SerializationError(
      'Payload starts with the CK v3 frame magic ("CK") — this is a Python-SDK-internal ' +
        'auto-mode entry, not an interop value. Write it with interop mode enabled ' +
        '(see protocol wire-format.md "SDK Storage Containers").'
    );
  }
  if (data.length > DEFAULT_MAX_DECODED_SIZE) {
    throw new ValueTooLargeError(
      `Input size ${data.length} exceeds max ${DEFAULT_MAX_DECODED_SIZE}`
    );
  }
  // Bound nesting depth before the decoder eagerly preallocates per-header
  // collections (LAB-2487, full rationale: assertDecodeDepth in serializer.ts).
  assertDecodeDepth(data, DEFAULT_MAX_DEPTH);
  let decoded: unknown;
  try {
    // Backend bytes are untrusted — bound header preallocation (full
    // rationale: boundedDecodeOptions in serializer.ts).
    decoded = msgpackDecode(data, {
      useBigInt64: true,
      ...boundedDecodeOptions(DEFAULT_MAX_COLLECTION_SIZE, DEFAULT_MAX_DECODED_SIZE),
    });
  } catch (error) {
    throw new SerializationError(
      `Failed to decode interop MessagePack: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { cause: error instanceof Error ? error : undefined }
    );
  }
  return reviveDecoded(decoded, 0) as T;
}

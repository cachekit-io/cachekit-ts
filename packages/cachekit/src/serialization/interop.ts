import { ExtensionCodec } from '@msgpack/msgpack';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ConfigurationError, SerializationError, ValueTooLargeError } from '../errors.js';
import { assertDecodeDepth, type ObjectCount } from './serializer.js';
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

// Exact-match, namespace-only reservation (see validateInteropSegment).
const RESERVED_INTEROP_NAMESPACES: ReadonlySet<string> = new Set(['ns', 'nsapi']);

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
// ignoreBOM keeps a leading U+FEFF: it is part of the string, not a byte order
// mark (bom_strings_value). A default TextDecoder strips it.
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
/** Strings up to this many bytes try a pure-JS ASCII decode first. */
const SHORT_STRING_MAX = 64;
/** V8's shortest rope (ConsString::kMinLength): shorter concatenations are flat. */
const FLAT_STRING_MIN = 13;

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
 * A namespace additionally must not be exactly `ns` or `nsapi`: the CachekitIO
 * server parses a key starting `ns:` / `nsapi:` as namespace-prefixed
 * (protocol spec/cache-key-format.md#server-side-requirements), so it would
 * reject or misroute the interop key (the `reject_reserved_namespace_*`
 * vectors). Exact-match and namespace-only: `nsx` is a valid namespace, and
 * `ns` / `nsapi` are valid operations.
 *
 * Neither segment may contain `..`: the pattern admits it, but the server
 * rejects `..` anywhere in a key (the Traversal row of the same spec section),
 * so the key would fail on every request (the `reject_double_dot_*` vectors).
 * The `:` delimiters separate the segments and the hash is hex, so any `..` in
 * a key lies inside one segment. A lone `.` stays valid.
 *
 * A non-string is rejected first: RegExp.test string-coerces its argument but
 * Set.has does not, so an untyped `['ns']` would otherwise pass the grammar
 * and skip the reservation.
 *
 * @throws {ConfigurationError} if the segment is not a string, does not match
 *   the grammar, contains `..`, or is a reserved namespace
 */
export function validateInteropSegment(kind: 'namespace' | 'operation', value: string): void {
  if (typeof value !== 'string') {
    throw new ConfigurationError(`Invalid interop ${kind}: must be a string, got ${typeof value}`);
  }
  if (!INTEROP_SEGMENT_PATTERN.test(value)) {
    throw new ConfigurationError(
      `Invalid interop ${kind} ${JSON.stringify(value)}: must full-string match ` +
        `^[a-z0-9][a-z0-9._-]{0,63}$ (lowercase ASCII letters, digits, '.', '_', '-'; 1-64 chars)`
    );
  }
  if (value.includes('..')) {
    throw new ConfigurationError(
      `Invalid interop ${kind} ${JSON.stringify(value)}: must not contain '..' — ` +
        `the CachekitIO server rejects '..' anywhere in a key`
    );
  }
  if (kind === 'namespace' && RESERVED_INTEROP_NAMESPACES.has(value)) {
    throw new ConfigurationError(
      `Invalid interop namespace ${JSON.stringify(value)}: 'ns' and 'nsapi' are reserved — ` +
        `the CachekitIO server parses a key starting '${value}:' as namespace-prefixed`
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
  /** Arrays, maps and bins written, for L1's memory charge (see ObjectCount). */
  objects: number;
  /** Their elements and entries, for the same charge (see ObjectCount). */
  values: number;
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
  sink.objects++;
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
  sink.objects++;
  sink.values += n;
  if (n <= 15) pushChunk(sink, Uint8Array.of(0x90 | n));
  else if (n <= 0xffff) pushChunk(sink, uintBE(0xdc, n, 2));
  else pushChunk(sink, uintBE(0xdd, n, 4));
}

function encodeMapHeader(n: number, sink: ChunkSink): void {
  // Emitter backstop: never the sole gate on today's callers — encodeMapEntries,
  // the Map branch (.size) and the plain-object branch (Object.keys) all reject
  // over-cap before reaching here, so no test routes an over-cap map through
  // this line. Retained deliberately as the last guard for any future direct
  // caller; do NOT cut on coverage grounds (that reopens the DoS this fix closes).
  checkCollectionSize(n, 'map');
  sink.objects++;
  sink.values += n;
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
  // construction, so the entry count is final up front. Checking here
  // (rather than in encodeMapHeader after the map/sort below) keeps an
  // over-cap map from forcing N Uint8Array allocations plus an O(N log N)
  // sort that never pass through pushChunk's byte budget.
  // Shared chokepoint for every map caller: the Map/plain-object branches
  // pre-check .size/Object.keys upstream and the datetime sentinel is a fixed
  // 2-entry literal, so no current path relies on this as the effective guard
  // (a test won't fail if it's removed). It stays as future-caller insurance —
  // do NOT "prove it dead" by coverage and cut it.
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
    // The parent's own total advances once, on the pushes below.
    // The collection-size cap is different: it counts the caller's Set, not
    // the deduped output, and fires before any element is encoded, as the
    // Map branch and auto mode cap .size. Counting retained elements would
    // walk and encode a Set of any size whose elements collapse to no more
    // canonical forms than the cap.
    checkCollectionSize(v.size, 'array');
    const encoded: Uint8Array[] = [];
    const seen = new Set<string>();
    let running = sink.bytes;
    for (const element of v) {
      const sub: ChunkSink = { chunks: [], bytes: sink.bytes, objects: 0, values: 0 };
      encodeCanonical(element, profile, depth + 1, sub);
      // L1 holds the caller's Set, duplicates and all, so they are charged.
      sink.objects += sub.objects;
      sink.values += sub.values;
      const bytes = concatChunks(sub.chunks);
      const key = bytesToHex(bytes);
      if (seen.has(key)) continue;
      seen.add(key);
      running += bytes.length;
      if (running > DEFAULT_MAX_ENCODED_SIZE) {
        throw new ValueTooLargeError(
          `Encoded interop payload exceeds max size ${DEFAULT_MAX_ENCODED_SIZE}`
        );
      }
      encoded.push(bytes);
    }
    encoded.sort(compareBytes);
    // The header counts the elements kept; the Set holds the rest too.
    sink.values += v.size - encoded.length;
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
    // Plain objects have no O(1) size, and Object.entries materialises a
    // tuple per property before the cap could see the count. Object.keys is
    // the cheapest own-enumerable count V8 offers (one pointer array — a
    // for...in snapshots the same list, it is not lazy), so an over-cap
    // object is rejected before any tuple is built or value read, mirroring
    // the Map branch's .size check. Throw-only: the emitter call is unchanged.
    checkCollectionSize(Object.keys(v).length, 'map');
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

function encodeProfile(root: unknown, profile: InteropProfile, count?: ObjectCount): Uint8Array {
  const sink: ChunkSink = { chunks: [], bytes: 0, objects: 0, values: 0 };
  encodeCanonical(root, profile, 0, sink);
  // pushChunk's incremental budget should make this backstop unreachable.
  const out = concatChunks(sink.chunks);
  if (out.length > DEFAULT_MAX_ENCODED_SIZE) {
    throw new ValueTooLargeError(
      `Encoded interop ${profile} size ${out.length} exceeds max ${DEFAULT_MAX_ENCODED_SIZE}`
    );
  }
  if (count) {
    count.objects += sink.objects;
    count.values += sink.values;
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
 * @throws {ConfigurationError} if namespace or operation violate the segment
 *   grammar or contain `..`, or namespace is reserved (`ns`, `nsapi`)
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
 * encodeInteropValue, adding the value's object and value counts to `count` (see
 * ObjectCount). Package-internal.
 */
export function encodeInteropValueCounted(value: unknown, count: ObjectCount): Uint8Array {
  return encodeProfile(value, 'value', count);
}

/**
 * Materialise the one MessagePack document in `data`. Call only after
 * assertDecodeDepth has accepted `data`: that walk proves every header is
 * backed by the input and the nesting is within bound, so this reader does no
 * bounds checks of its own. It still checks it ended exactly at `data.length`,
 * so a width disagreement between the two parsers throws instead of misreading.
 *
 * The SDK reads interop values itself rather than through @msgpack/msgpack
 * (3.1.3), which rejects the string map key `__proto__` outright and strips a
 * leading U+FEFF from strings longer than 200 bytes. Both are ordinary interop
 * values (proto_key_value, bom_strings_value). Output matches that decoder
 * otherwise (maps become plain objects, a string or number key names the
 * property, 64-bit integers decode as BigInt, bin values are views of `data`,
 * and ext values go through its default codec, so the timestamp ext becomes a
 * Date), with two differences:
 * - An integer key written at 64-bit width names the property like any other
 *   integer key; that decoder threw on it.
 * - Invalid UTF-8 reads as U+FFFD at every length, as WHATWG decoding does;
 *   that decoder did so only above 200 bytes and misread shorter strings (an
 *   overlong `c0 af` came back as "/").
 */
function readInteropDocument(data: Uint8Array): unknown {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;

  /** Advance past an n-byte fixed-width value already read at `pos`. */
  const fixed = <T>(n: number, v: T): T => {
    pos += n;
    return v;
  };
  const length = (bytes: 1 | 2 | 4): number =>
    fixed(
      bytes,
      bytes === 1 ? data[pos]! : bytes === 2 ? view.getUint16(pos) : view.getUint32(pos)
    );
  const take = (n: number): Uint8Array => data.subarray(pos, (pos += n));
  const str = (n: number): string => {
    // Short ASCII (most keys) skips TextDecoder, whose per-call cost dominates
    // at this length. Appending a character at a time is fastest for the
    // shortest strings, but from 13 characters V8 builds a rope (cons string)
    // that the decoded value keeps, many times larger than the bytes; build
    // those in one call instead.
    if (n <= SHORT_STRING_MAX) {
      const end = pos + n;
      for (let i = pos; i < end; i++) {
        if (data[i]! >= 0x80) return textDecoder.decode(take(n));
      }
      if (n >= FLAT_STRING_MIN) {
        return String.fromCharCode.apply(null, take(n) as unknown as number[]);
      }
      let s = '';
      for (; pos < end; pos++) s += String.fromCharCode(data[pos]!);
      return s;
    }
    return textDecoder.decode(take(n));
  };
  const ext = (n: number): unknown => {
    const type = view.getInt8(pos++);
    return ExtensionCodec.defaultCodec.decode(take(n), type, undefined);
  };
  const capped = (n: number, kind: 'array' | 'map'): number => {
    if (n > DEFAULT_MAX_COLLECTION_SIZE) {
      throw new SerializationError(
        `Interop ${kind} of ${n} entries exceeds max ${DEFAULT_MAX_COLLECTION_SIZE}`
      );
    }
    return n;
  };
  const array = (n: number): unknown[] => {
    const out = new Array<unknown>(capped(n, 'array'));
    for (let i = 0; i < n; i++) out[i] = read();
    return out;
  };
  const map = (n: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (let i = capped(n, 'map'); i > 0; i--) {
      const key = read();
      if (typeof key !== 'string' && typeof key !== 'number' && typeof key !== 'bigint') {
        throw new SerializationError(
          `Interop map key must be a string or number, not ${typeof key}`
        );
      }
      const name = String(key);
      if (name === '__proto__') {
        // Assignment would set the prototype and drop the entry.
        Object.defineProperty(out, name, {
          value: read(),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        out[name] = read();
      }
    }
    return out;
  };

  function read(): unknown {
    const b = data[pos++]!;
    if (b <= 0x7f) return b; // positive fixint
    if (b >= 0xe0) return b - 0x100; // negative fixint
    if (b <= 0x8f) return map(b & 0x0f);
    if (b <= 0x9f) return array(b & 0x0f);
    if (b <= 0xbf) return str(b & 0x1f);
    switch (b) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
      case 0xc5:
      case 0xc6:
        return take(length(b === 0xc4 ? 1 : b === 0xc5 ? 2 : 4));
      case 0xc7:
      case 0xc8:
      case 0xc9:
        return ext(length(b === 0xc7 ? 1 : b === 0xc8 ? 2 : 4));
      case 0xca:
        return fixed(4, view.getFloat32(pos));
      case 0xcb:
        return fixed(8, view.getFloat64(pos));
      case 0xcc:
        return length(1);
      case 0xcd:
        return length(2);
      case 0xce:
        return length(4);
      case 0xcf:
        return fixed(8, view.getBigUint64(pos));
      case 0xd0:
        return fixed(1, view.getInt8(pos));
      case 0xd1:
        return fixed(2, view.getInt16(pos));
      case 0xd2:
        return fixed(4, view.getInt32(pos));
      case 0xd3:
        return fixed(8, view.getBigInt64(pos));
      case 0xd4:
        return ext(1);
      case 0xd5:
        return ext(2);
      case 0xd6:
        return ext(4);
      case 0xd7:
        return ext(8);
      case 0xd8:
        return ext(16);
      case 0xd9:
      case 0xda:
      case 0xdb:
        return str(length(b === 0xd9 ? 1 : b === 0xda ? 2 : 4));
      case 0xdc:
      case 0xdd:
        return array(length(b === 0xdc ? 2 : 4));
      case 0xde:
      case 0xdf:
        return map(length(b === 0xde ? 2 : 4));
      default:
        // 0xc1 (never used): assertDecodeDepth rejects it first.
        throw new SerializationError(`Invalid MessagePack head byte 0x${b.toString(16)}`);
    }
  }

  const value = read();
  if (pos !== data.length) {
    throw new SerializationError(
      `Interop reader consumed ${pos} of ${data.length} bytes; the decode pre-scan disagrees`
    );
  }
  return value;
}

/**
 * One post-decode pass: depth validation, sentinel revival, and int
 * normalization.
 *
 * - Wire-format.md sentinel maps revive: `__datetime__` -> Date. `__date__` /
 *   `__time__` stay as maps — JS has no date-only/time-only type to revive
 *   into, and fabricating a Date instant for them would be wrong.
 * - 64-bit integers decode as BigInt (readInteropDocument) so a Python-written
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
  // An own '__proto__' data property shadows the accessor, so assignment is safe here.
  for (const k of keys) obj[k] = reviveDecoded(obj[k], depth + 1);
  return obj;
}

/**
 * Deserialize an interop value: exactly one well-formed MessagePack document
 * (canonical or not). Trailing bytes are rejected (the assertDecodeDepth
 * pre-scan consumes exactly the input). A payload starting with the CK v3 frame magic
 * (`0x43 0x4B`, "CK") gets a targeted diagnostic — it is a
 * Python-SDK-internal auto-mode entry, not an interop value.
 *
 * @throws {SerializationError} on malformed input or a CK-frame payload
 * @throws {ValueTooLargeError} if input exceeds the decode size cap
 */
export function decodeInteropValue<T>(data: Uint8Array): T {
  return decodeInteropValueCounted<T>(data);
}

/**
 * decodeInteropValue, adding the document's object and value counts to `count` (see
 * ObjectCount). Package-internal.
 */
export function decodeInteropValueCounted<T>(data: Uint8Array, count?: ObjectCount): T {
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
  const counted = assertDecodeDepth(data, DEFAULT_MAX_DEPTH);
  let decoded: unknown;
  try {
    decoded = readInteropDocument(data);
  } catch (error) {
    if (error instanceof SerializationError) throw error;
    throw new SerializationError(
      `Failed to decode interop MessagePack: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { cause: error instanceof Error ? error : undefined }
    );
  }
  const value = reviveDecoded(decoded, 0) as T;
  if (count) {
    count.objects += counted.objects;
    count.values += counted.values;
  }
  return value;
}

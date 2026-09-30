import { ValueTooLargeError } from '../errors.js';

/**
 * ByteStorage envelope checks the SDK runs BEFORE handing untrusted bytes to
 * the core codec. cachekit-core's unpack copies `compressed_data` and then
 * allocates the declared `original_size` before it validates the LZ4 stream,
 * capped only by its own limits below — and the xxHash3 checksum is unkeyed,
 * so it does not stop a forged size. Holding an envelope to maxDecodedSize
 * therefore has to happen here, on the header, not after unpack returns.
 */

/** cachekit-core's own caps (`byte_storage.rs`): past these it rejects before allocating the output. */
const CORE_MAX_UNCOMPRESSED_SIZE = 512 * 1024 * 1024;
const CORE_MAX_COMPRESSION_RATIO = 1000;

/**
 * Slack for everything in an envelope besides `compressed_data`: the
 * 4-tuple and length headers, the checksum, `original_size`, and a short
 * `format` string. Real envelopes use about 30 bytes of it.
 */
const ENVELOPE_OVERHEAD_BYTES = 256;

/**
 * Longest `format` string accepted. Writers emit short tokens ("msgpack");
 * the cap keeps the bytes core copies for it inside ENVELOPE_OVERHEAD_BYTES.
 */
const MAX_FORMAT_BYTES = 64;

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** lz4_flex's worst-case block size for `n` input bytes (`get_maximum_output_size`). */
function lz4MaxCompressedSize(n: number): number {
  return 20 + Math.floor((n * 110) / 100);
}

/**
 * The longest bytes that can be an envelope within `maxDecodedSize`: twice
 * lz4's worst case (legacy encoding spends up to 2 bytes per compressed
 * byte) plus the fixed fields. Never less than maxDecodedSize, so it also
 * covers plain serialized values.
 */
export function maxEnvelopeInputSize(maxDecodedSize: number): number {
  return 2 * lz4MaxCompressedSize(maxDecodedSize) + ENVELOPE_OVERHEAD_BYTES;
}

/**
 * Cheap structural sniff for the ByteStorage envelope: a positional msgpack
 * 4-tuple whose first element is `compressed_data` in either encoding —
 * fixarray(4) marker followed by a bin8/bin16/bin32 marker (protocol 1.1) or
 * a fixarray/array16/array32 marker (the legacy array of ints, which older
 * writers still emit). Gates envelope tolerance on compression-off caches so
 * ordinary reads never pay the header read. User values matching this shape
 * are possible — envelopeVerdict and the verified unpack disambiguate.
 */
export function looksLikeEnvelope(bytes: Uint8Array): boolean {
  if (bytes.length <= 2 || bytes[0] !== 0x94) return false;
  const marker = bytes[1];
  return (
    (marker >= 0xc4 && marker <= 0xc6) || // bin8/16/32
    (marker >= 0x90 && marker <= 0x9f) || // fixarray
    marker === 0xdc || // array16
    marker === 0xdd // array32
  );
}

/**
 * The compressed length and `original_size` a ByteStorage envelope carries,
 * read without unpacking it — or null when the bytes are not an envelope in
 * a shape a conforming writer emits: `[bin | legacy array of uint8,
 * [8 x uint8], uint, format]`, every uint an unsigned fixint/uint8/16/32 (no
 * uint64, no signed forms), `format` a str or bin of at most
 * MAX_FORMAT_BYTES valid UTF-8 (core decodes it as a `String`, which takes
 * either), and nothing after it. Stricter than core's lenient rmp_serde
 * decode on purpose: a shape this rejects is never unpacked, so it cannot
 * allocate. And every shape core itself refuses before allocating — a
 * non-string `format` included — is rejected here too, so a plain value of
 * that shape still decodes as itself.
 * Walks a legacy array-of-ints payload byte by byte, so the cost is linear in
 * input size — never in the declared size.
 */
export function readEnvelopeHeader(
  bytes: Uint8Array
): { compressedLength: number; declaredSize: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const take = (width: 1 | 2 | 4): number | null => {
    if (pos + width > view.byteLength) return null;
    const value =
      width === 1 ? view.getUint8(pos) : width === 2 ? view.getUint16(pos) : view.getUint32(pos);
    pos += width;
    return value;
  };
  const uint = (): number | null => {
    const marker = take(1);
    if (marker === null) return null;
    if (marker <= 0x7f) return marker;
    if (marker === 0xcc) return take(1);
    if (marker === 0xcd) return take(2);
    if (marker === 0xce) return take(4);
    return null;
  };
  const arrayLength = (marker: number): number | null => {
    if (marker >= 0x90 && marker <= 0x9f) return marker & 0x0f;
    if (marker === 0xdc) return take(2);
    if (marker === 0xdd) return take(4);
    return null;
  };
  // A run of uint8 as rmp_serde writes them: fixint, or 0xcc + one byte.
  // Indexes the bytes directly — this is the per-byte loop on legacy reads.
  const byteArray = (length: number): boolean => {
    for (let i = 0; i < length; i++) {
      const marker = bytes[pos];
      if (marker <= 0x7f) pos += 1;
      else if (marker === 0xcc) pos += 2;
      else return false; // also past the end: bytes[pos] is undefined
    }
    return pos <= view.byteLength;
  };

  const outer = take(1);
  if (outer === null || arrayLength(outer) !== 4) return null;

  // [0] compressed_data: bin since protocol 1.1, an array of uint8 before it.
  const data = take(1);
  if (data === null) return null;
  let compressedLength: number | null;
  const binWidth = ({ 0xc4: 1, 0xc5: 2, 0xc6: 4 } as const)[data];
  if (binWidth !== undefined) {
    compressedLength = take(binWidth);
    if (compressedLength === null || pos + compressedLength > view.byteLength) return null;
    pos += compressedLength;
  } else {
    compressedLength = arrayLength(data);
    if (compressedLength === null || !byteArray(compressedLength)) return null;
  }

  // [1] checksum: always an array of 8 uint8.
  const checksum = take(1);
  if (checksum === null || arrayLength(checksum) !== 8 || !byteArray(8)) return null;

  // [2] original_size.
  const declaredSize = uint();
  if (declaredSize === null) return null;

  // [3] format: str or bin, short, valid UTF-8, and the last bytes of the input.
  const format = take(1);
  if (format === null) return null;
  let formatLength: number | null;
  if (format >= 0xa0 && format <= 0xbf) formatLength = format & 0x1f;
  else if (format === 0xd9 || format === 0xc4) formatLength = take(1);
  else if (format === 0xda || format === 0xc5) formatLength = take(2);
  else if (format === 0xdb || format === 0xc6) formatLength = take(4);
  else return null;
  if (
    formatLength === null ||
    formatLength > MAX_FORMAT_BYTES ||
    pos + formatLength !== view.byteLength
  ) {
    return null;
  }
  try {
    UTF8.decode(bytes.subarray(pos));
  } catch {
    return null;
  }
  return { compressedLength, declaredSize };
}

/**
 * Whether untrusted bytes may be handed to the core codec's unpack, under a
 * `maxDecodedSize` ceiling:
 *
 * - `'unpack'` — a conforming envelope within the ceiling. Everything unpack
 *   allocates is then a small multiple of maxDecodedSize: the input, the
 *   compressed payload (at most lz4's worst case for the declared size), and
 *   the output (at most maxDecodedSize).
 * - `'not-envelope'` — no envelope core would accept: the bytes are not in a
 *   shape readEnvelopeHeader admits, core's own caps would reject them, or the
 *   compressed length exceeds what any LZ4 writer emits for the declared
 *   size. Never unpack these.
 *
 * @throws {ValueTooLargeError} for an envelope core would accept that
 *   declares more than `maxDecodedSize`, or bytes longer than
 *   maxEnvelopeInputSize. Such bytes are over maxDecodedSize either way, so a
 *   plain decode would reject them too.
 */
export function envelopeVerdict(
  bytes: Uint8Array,
  maxDecodedSize: number
): 'unpack' | 'not-envelope' {
  const maxInput = maxEnvelopeInputSize(maxDecodedSize);
  if (bytes.length > maxInput) {
    throw new ValueTooLargeError(
      `Envelope input size ${bytes.length} exceeds max ${maxInput} for maxDecodedSize ${maxDecodedSize}`
    );
  }

  const header = readEnvelopeHeader(bytes);
  if (header === null) return 'not-envelope';
  const { compressedLength, declaredSize } = header;
  if (
    compressedLength === 0 ||
    declaredSize > CORE_MAX_UNCOMPRESSED_SIZE ||
    declaredSize > CORE_MAX_COMPRESSION_RATIO * compressedLength ||
    compressedLength > lz4MaxCompressedSize(declaredSize)
  ) {
    return 'not-envelope';
  }

  if (declaredSize > maxDecodedSize) {
    throw new ValueTooLargeError(
      `Envelope declares ${declaredSize} bytes, exceeds maxDecodedSize ${maxDecodedSize}`
    );
  }
  return 'unpack';
}

/**
 * A hand-built ByteStorage envelope: `[bin compressed_data, [8 x 0],
 * original_size, "msgpack"]`, with garbage LZ4 bytes. By default the
 * compressed length is the smallest cachekit-core's 1000:1 ratio cap admits
 * for `declaredSize`, so core would allocate the declared size before it
 * found the LZ4 stream invalid.
 */
export function forgedEnvelope(
  declaredSize: number,
  compressedLength = Math.ceil(declaredSize / 1000)
): Uint8Array {
  const binHeader = compressedLength <= 0xffff ? 3 : 5;
  const bytes = new Uint8Array(1 + binHeader + compressedLength + 9 + 5 + 8);
  const view = new DataView(bytes.buffer);
  let pos = 0;
  bytes[pos++] = 0x94; // fixarray(4)
  if (binHeader === 3) {
    bytes[pos++] = 0xc5; // bin16
    view.setUint16(pos, compressedLength);
  } else {
    bytes[pos++] = 0xc6; // bin32
    view.setUint32(pos, compressedLength);
  }
  pos += binHeader - 1 + compressedLength;
  bytes[pos++] = 0x98; // checksum: fixarray(8) of zero bytes
  pos += 8;
  bytes[pos++] = 0xce; // original_size: uint32
  view.setUint32(pos, declaredSize);
  pos += 4;
  bytes[pos++] = 0xa7; // format: fixstr(7)
  bytes.set(new TextEncoder().encode('msgpack'), pos);
  return bytes;
}

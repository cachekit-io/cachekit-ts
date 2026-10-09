/**
 * Other SDKs' containers (protocol spec/wire-format.md, SDK Storage Containers)
 *
 * An SDK must not decode another SDK's auto-mode container (WIRE-21). Five
 * error vectors of test-vectors/python-frame.json (vendored in ./fixtures/,
 * sha256-pinned below) are fed to this SDK's readers: the whole CK frames in
 * `ck_frame_fed_to_interop_reader`, `serializer_name_missing` and
 * `serializer_name_empty`, and the two containers named below. The
 * frame-check vectors (truncated, wrong version, header overrun) test
 * cachekit-py's frame parser, which this SDK does not have; the
 * serializer-name vectors test its name check, which this SDK never reaches,
 * because it refuses the frame first.
 *
 * Two of them name cachekit-py's frame reader, but their bytes are this SDK's
 * own containers: `bare_envelope_fed_to_frame_reader` is its default
 * (compression-on) entry and `plain_msgpack_fed_to_frame_reader` its
 * compression-off entry. So the first is recorded as read, not refused.
 *
 * Provenance: cachekit-io/protocol @ 4ce84e1d (the merge of
 * cachekit-io/protocol#180, the revision that last touched the fixture; the
 * file carries no version field).
 *
 * Re-vendor: copy test-vectors/python-frame.json byte-for-byte from the
 * protocol revision you then name in `Provenance` above, then update
 * FIXTURE_SHA256.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { createCache } from '../../src/index.js';
import { decodeInteropValue } from '../../src/serialization/interop.js';
import {
  hexToBytes,
  readRejection,
  readValue,
  storedReadConfig,
} from '../fixtures/wire-vectors.js';

/** sha256 of test-vectors/python-frame.json at the provenance above. */
const FIXTURE_SHA256 = 'b677d5f14de4a3cd1fa5307d4b46eae0545a20e51e9163f96495ee7ad15600d0'; // pragma: allowlist secret

interface ErrorVector {
  name: string;
  frame_hex: string;
}

const raw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'python-frame.json')
);
const { error_vectors } = JSON.parse(raw.toString('utf8')) as { error_vectors: ErrorVector[] };

function frame(name: string): Uint8Array {
  const vector = error_vectors.find((v) => v.name === name);
  if (!vector) throw new Error(`python-frame.json has no error vector ${name}`);
  return hexToBytes(vector.frame_hex);
}

/** The value default_saas_write_msgpack_bytestorage_bin stores. */
const VALUE = { user_id: 42, name: 'cachekit', active: true };

/** Error vectors that are whole CK v3 frames, refused here as foreign. */
const CK_FRAMES = [
  'ck_frame_fed_to_interop_reader',
  'serializer_name_missing',
  'serializer_name_empty',
] as const;

/** Error vectors only cachekit-py's frame parser meets. */
const FRAME_CHECKS = [
  'truncated_frame',
  'unsupported_frame_version',
  'header_overrun',
  'truncated_frame_one_short',
  'unsupported_frame_version_2',
  'header_overrun_by_one',
  'unsupported_frame_version_4',
];

describe('Protocol python-frame.json: other SDKs containers (WIRE-21)', () => {
  it('fixture is the pinned upstream file, unedited since vendoring', () => {
    expect(
      createHash('sha256').update(raw).digest('hex'),
      'fixture differs from the pinned protocol revision; if intentional, follow the re-vendor note above'
    ).toBe(FIXTURE_SHA256);
  });

  it('every error vector is fed to a reader below or is a cachekit-py frame check', () => {
    expect(error_vectors.map((v) => v.name).sort()).toEqual(
      [
        ...CK_FRAMES,
        'plain_msgpack_fed_to_frame_reader',
        'bare_envelope_fed_to_frame_reader',
        ...FRAME_CHECKS,
      ].sort()
    );
  });

  describe.each(CK_FRAMES)('%s (a cachekit-py CK frame)', (name) => {
    it('the envelope read path refuses it before unpack', async () => {
      const error = await readRejection(createCache(storedReadConfig(frame(name))));
      expect(error.message).toMatch(/not an envelope core would accept; refused before unpack/);
    });

    it('the interop reader refuses it, naming the CK frame', () => {
      expect(() => decodeInteropValue(frame(name))).toThrow(/CK v3 frame magic/);
    });
  });

  it('plain_msgpack_fed_to_frame_reader: the envelope read path refuses plain MessagePack', async () => {
    const error = await readRejection(
      createCache(storedReadConfig(frame('plain_msgpack_fed_to_frame_reader')))
    );
    expect(error.message).toMatch(/not an envelope core would accept; refused before unpack/);
  });

  // Not a foreign container here: these bytes are what this SDK itself
  // writes by default, so no cachekit-ts reader refuses them. Both auto-mode
  // reads return the value (compression-off through its envelope tolerance);
  // the interop reader takes them as the 4-element array they are.
  describe('bare_envelope_fed_to_frame_reader: no cachekit-ts reader refuses it', () => {
    const bytes = frame('bare_envelope_fed_to_frame_reader');

    it('the compression-on read returns the value', async () => {
      expect(await readValue(createCache(storedReadConfig(bytes)))).toEqual(VALUE);
    });

    it('the compression-off read returns the value', async () => {
      const config = { ...storedReadConfig(bytes), compression: false };
      expect(await readValue(createCache(config))).toEqual(VALUE);
    });

    it('the interop reader decodes it as a 4-element array', () => {
      const value = decodeInteropValue<unknown[]>(bytes);
      expect(value).toHaveLength(4);
      expect(value[3]).toBe('msgpack');
    });
  });
});

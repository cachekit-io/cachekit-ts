/**
 * Decode Bounds — Workers lane
 *
 * Runs protocol/test-vectors/decode-bounds.json (vendored in
 * test/protocol/fixtures/ and sha256-pinned by the Node lane,
 * test/protocol/decode-bounds.protocol.test.ts) through the wasm ByteStorage
 * `unpack` inside real workerd: the Workers build's envelope entry point must
 * apply cachekit-core's envelope pre-scan exactly as the NAPI one does. The
 * assertions are shared with the Node lane (test/fixtures/decode-bounds-vectors.ts).
 */

import { describe, it } from 'vitest';
import { ByteStorage } from '../../src/workers/runtime.js';
import {
  expectEnvelopePreScanAccepts,
  expectEnvelopePreScanRejects,
  vectors,
} from '../fixtures/decode-bounds-vectors.js';

describe('decode-bounds vectors (wasm ByteStorage.unpack)', () => {
  const storage = new ByteStorage();

  it.each(vectors.reject_vectors)('rejects $name at the envelope pre-scan', (v) => {
    expectEnvelopePreScanRejects((b) => storage.unpack(b), v);
  });

  it.each(vectors.accept_vectors)('gets $name past the envelope pre-scan', (v) => {
    expectEnvelopePreScanAccepts((b) => storage.unpack(b), v);
  });
});

/**
 * Pins the vendored protocol/test-vectors/encryption.json. The vectors run in
 * the Workers lane (test/workers/encryption.protocol.workers.test.ts); workerd
 * has no fs to read the raw bytes, so the pin lives here, as the
 * wire-format.json pin does.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * sha256 of test-vectors/encryption.json (fixture version 1.2.0).
 * Provenance: cachekit-io/protocol @ 0090bc9. Re-vendoring means copying the
 * file byte-for-byte from a named protocol revision, then changing together:
 * the version and revision in this docblock, FIXTURE_SHA256, and the vector
 * name guards in the Workers lane.
 */
const FIXTURE_SHA256 = '15286cbab2eef236376b18f2be0c3b0a2123faf79cb4c1e4885c19f4a2dc34e0'; // pragma: allowlist secret

const raw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'workers', 'fixtures', 'encryption.json')
);

describe('protocol encryption.json fixture', () => {
  it('is the pinned upstream file, unedited since vendoring', () => {
    expect(
      createHash('sha256').update(raw).digest('hex'),
      'fixture differs from the pinned protocol revision; if intentional, follow the re-vendor list in the FIXTURE_SHA256 docblock'
    ).toBe(FIXTURE_SHA256);
  });
});

/**
 * File Backend Format Protocol Tests
 *
 * Executes protocol/test-vectors/file-backend.json (vendored in ./fixtures/,
 * sha256-pinned below) against FileBackend. Spec:
 * protocol/spec/file-backend-format.md. Each vector is read with the clock
 * frozen at its `reader_now_unix_seconds` (default 0), as the fixture's own
 * `format` field requires, so `expired_entry` is read at exactly its expiry.
 *
 * Provenance: cachekit-io/protocol @ 4b8fddb2 (the merge of
 * cachekit-io/protocol#171, the revision that last touched the fixture;
 * fixture version 1.2.0).
 *
 * Re-vendor: copy test-vectors/file-backend.json byte-for-byte from the
 * protocol revision you then name in `Provenance` above, then update
 * FIXTURE_SHA256 and the expected actions in the first test.
 */

import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { file, type FileBackend } from '../../src/backends/file.js';
import { assertFixture, oneOf, table } from '../fixtures/fixture-shape.js';

/** sha256 of test-vectors/file-backend.json at the provenance above. */
const FIXTURE_SHA256 = 'b7b0c51935a3a00ab340005ae1e091797b14938f92eecae23346bdccf0d12af4'; // pragma: allowlist secret

interface Vector {
  name: string;
  key_utf8: string;
  filename: string;
  file_hex: string;
  payload_hex: string;
  reader_now_unix_seconds?: number;
  reader_action: 'return_payload' | 'miss_preserve' | 'miss_expired';
}

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, 'fixtures', 'file-backend.json'));

function assertVectorFile(value: unknown): asserts value is { vectors: Vector[] } {
  assertFixture(
    value,
    {
      vectors: table({
        name: 'string',
        key_utf8: 'string',
        filename: 'string',
        file_hex: 'string',
        payload_hex: 'string',
        reader_now_unix_seconds: ['number', 'undefined'],
        reader_action: oneOf('return_payload', 'miss_preserve', 'miss_expired'),
      }),
    },
    'file-backend.json'
  );
}

const parsed: unknown = JSON.parse(raw.toString('utf8'));
assertVectorFile(parsed);
const { vectors } = parsed;
const byAction = (action: Vector['reader_action']) =>
  vectors.filter((v) => v.reader_action === action);

/** Every read path, with the value it returns on a miss. */
const READ_PATHS: Array<[string, (b: FileBackend, key: string) => Promise<unknown>, unknown]> = [
  ['get', (b, k) => b.get(k), null],
  ['exists', (b, k) => b.exists(k), false],
  ['getTTL', (b, k) => b.getTTL(k), null],
  ['refreshTTL', (b, k) => b.refreshTTL(k, 3600), false],
];

describe('Protocol file-backend vectors (spec/file-backend-format.md)', () => {
  let dir: string;
  let backend: FileBackend;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'cachekit-file-vectors-'));
    backend = file({ cacheDir: dir });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await backend.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Write the vector's file bytes under its filename and freeze the clock at its reader time. */
  async function place(v: Vector): Promise<string> {
    const filePath = join(dir, v.filename);
    await fs.writeFile(filePath, Buffer.from(v.file_hex, 'hex'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((v.reader_now_unix_seconds ?? 0) * 1000);
    return filePath;
  }

  it('fixture is the pinned upstream file, unedited since vendoring', () => {
    expect(
      createHash('sha256').update(raw).digest('hex'),
      'fixture differs from the pinned protocol revision; if intentional, refresh FIXTURE_SHA256 AND the actions'
    ).toBe(FIXTURE_SHA256);
    expect(Object.fromEntries(vectors.map((v) => [v.name, v.reader_action]))).toEqual({
      permanent_ascii: 'return_payload',
      future_expiry: 'return_payload',
      unknown_flag_preserved: 'miss_preserve',
      reserved_nonzero_preserved: 'miss_preserve',
      expired_entry: 'miss_expired',
      empty_payload: 'return_payload',
      binary_payload: 'return_payload',
      unknown_flag_high_bit: 'miss_preserve',
      reserved_one_preserved: 'miss_preserve',
      reserved_ff_preserved: 'miss_preserve',
      // Expired AND unknown: the reader keeps the file for the newer writer
      // that understands it, rather than deleting it as expired.
      unknown_flag_expired: 'miss_preserve',
      reserved_nonzero_expired: 'miss_preserve',
    });
  });

  it.each(byAction('return_payload').map((v) => [v.name, v] as const))(
    '%s: returns the payload',
    async (_, v) => {
      await place(v);
      expect(Buffer.from((await backend.get(v.key_utf8))!)).toEqual(
        Buffer.from(v.payload_hex, 'hex')
      );
    }
  );

  describe.each(READ_PATHS)('%s', (_, read, miss) => {
    it.each(byAction('miss_preserve').map((v) => [v.name, v] as const))(
      '%s: misses and leaves the file untouched',
      async (_, v) => {
        const filePath = await place(v);
        const before = await fs.stat(filePath);

        expect(await read(backend, v.key_utf8)).toBe(miss);

        expect((await fs.readFile(filePath)).toString('hex')).toBe(v.file_hex);
        const after = await fs.stat(filePath);
        expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
      }
    );

    it.each(byAction('miss_expired').map((v) => [v.name, v] as const))(
      '%s: misses at its reader clock',
      async (_, v) => {
        await place(v);
        expect(await read(backend, v.key_utf8)).toBe(miss);
      }
    );
  });
});

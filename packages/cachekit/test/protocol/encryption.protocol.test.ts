/**
 * Pins the vendored protocol/test-vectors/encryption.json. The vectors run in
 * the Workers lane (test/workers/encryption.protocol.workers.test.ts); workerd
 * has no fs to read the raw bytes, so the pin lives here, as the
 * wire-format.json pin does.
 *
 * The 1.3.0 master_key_input rows run here instead, through the Node
 * createCache.secure: the hex validator and decoder they exercise are shared
 * by both platforms (src/encryption/manager-core.ts).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCache } from '../../src/index.js';
import { ConfigurationError } from '../../src/errors.js';
import { generateInteropKey, encodeInteropValue } from '../../src/serialization/interop.js';
import type { Backend } from '../../src/backends/types.js';

/**
 * sha256 of test-vectors/encryption.json (fixture version 1.3.0).
 * Provenance: cachekit-io/protocol @ 4b34c01. Re-vendoring means copying the
 * file byte-for-byte from a named protocol revision, then changing together:
 * the version and revision in this docblock, FIXTURE_SHA256, the vector name
 * guards in the Workers lane, and the master_key_input name guards below.
 */
const FIXTURE_SHA256 = 'f701951147a47c42a968850fe6cb73a544313728e46f45fec3d811c20ed4b377'; // pragma: allowlist secret

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

interface MasterKeyInput {
  tenant_id: string;
  accept_vectors: {
    name: string;
    master_key_hex: string;
    plaintext_hex: string;
    cache_key: string;
    format: string;
    compressed: boolean;
    ciphertext_hex: string;
  }[];
  reject_vectors: { name: string; master_key_hex: string }[];
}

const masterKeyInput = (JSON.parse(raw.toString('utf8')) as { master_key_input: MasterKeyInput })
  .master_key_input;

class InMemoryBackend implements Backend {
  store = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: Uint8Array, _ttl: number): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async close(): Promise<void> {
    this.store.clear();
  }
}

// The key reaches the preset as an option or through the environment; both
// must judge every row alike.
const KEY_SOURCES = [
  ['masterKey', (key: string) => ({ masterKey: key })],
  [
    'CACHEKIT_MASTER_KEY',
    (key: string) => {
      vi.stubEnv('CACHEKIT_MASTER_KEY', key);
      return {};
    },
  ],
] as const;

describe('encryption.json master_key_input (protocol 1.3.0) — createCache.secure', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('vendors the accept row, all eleven hex rejects, and the "default" tenant', () => {
    expect(masterKeyInput.tenant_id).toBe('default');
    expect(masterKeyInput.accept_vectors.map((v) => v.name)).toEqual([
      'master_key_every_hex_digit',
    ]);
    expect(masterKeyInput.reject_vectors.map((v) => v.name)).toEqual([
      'master_key_odd_65_digits',
      'master_key_odd_63_digits',
      'master_key_non_hex_digit',
      'master_key_trailing_non_hex',
      'master_key_plus_sign',
      'master_key_31_bytes',
      'master_key_24_bytes',
      'master_key_16_bytes',
      'master_key_31_bytes_and_crlf',
      'master_key_31_bytes_with_spaces',
      'master_key_0x_and_31_bytes',
    ]);
  });

  describe.each(KEY_SOURCES)('key via %s', (_source, supplyKey) => {
    it.each(masterKeyInput.accept_vectors.map((v) => [v.name, v] as const))(
      '%s: no tenant, reads the sealed interop entry',
      async (_name, vector) => {
        expect([vector.format, vector.compressed]).toEqual(['msgpack', false]);
        // The sealed entry is interop-mode.json's empty_args key.
        expect(generateInteropKey('users', 'get_all', [])).toBe(vector.cache_key);

        vi.stubEnv('CACHEKIT_PREVIOUS_MASTER_KEYS', undefined);
        const backend = new InMemoryBackend();
        backend.store.set(vector.cache_key, Buffer.from(vector.ciphertext_hex, 'hex'));
        const cache = createCache.secure({
          backend,
          l1: { enabled: false },
          ...supplyKey(vector.master_key_hex),
        });
        try {
          const compute = vi.fn(async (): Promise<unknown> => {
            throw new Error('the sealed entry must be read, not recomputed');
          });
          const getAll = cache.wrap(compute, {
            namespace: 'users',
            interop: 'get_all',
            interopArity: 0,
            ttl: 60,
          });

          const value = await getAll();
          expect(compute).not.toHaveBeenCalled();
          expect(value).toEqual([1, 'two', 3.5, null, true]);
          expect(Buffer.from(encodeInteropValue(value)).toString('hex')).toBe(vector.plaintext_hex);
        } finally {
          await cache.close();
        }
      }
    );

    it.each(masterKeyInput.reject_vectors.map((v) => [v.name, v] as const))(
      '%s: throws at construction',
      (_name, vector) => {
        const construct = () =>
          createCache.secure({
            backend: new InMemoryBackend(),
            l1: { enabled: false },
            ...supplyKey(vector.master_key_hex),
          });
        expect(construct).toThrow(ConfigurationError);
        // The key itself is refused, not some other option.
        expect(construct).toThrow(/^Master key must be /);
      }
    );
  });
});

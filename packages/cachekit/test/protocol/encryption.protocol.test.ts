/**
 * Pins the vendored protocol/test-vectors/encryption.json. The vectors run in
 * the Workers lane (test/workers/encryption.protocol.workers.test.ts); workerd
 * has no fs to read the raw bytes, so the pin lives here, as the
 * wire-format.json pin does.
 *
 * The tables that judge a configured cache, not the bindings, run here
 * instead, through the Node createCache: the 1.3.0/1.4.0 master_key_input
 * rows and the 1.5.0 keyring.configuration rows (the hex validator, decoder
 * and keyring checks they exercise are shared by both platforms,
 * src/encryption/manager-core.ts), and the 1.5.0 aad_reject_vectors and
 * decrypted_container rows (the read path, src/cache-core.ts).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCache } from '../../src/index.js';
import { ConfigurationError, EncryptionError, SerializationError } from '../../src/errors.js';
import { generateInteropKey } from '../../src/serialization/interop.js';
import type { Backend } from '../../src/backends/types.js';
import { assertFixture, oneOf, table, type ObjectShape } from '../fixtures/fixture-shape.js';

/**
 * sha256 of test-vectors/encryption.json (fixture version 1.5.0).
 * Provenance: cachekit-io/protocol @ b1b1679 (the merge of
 * cachekit-io/protocol#181, the revision that last touched the fixture).
 * Re-vendoring means copying the file byte-for-byte from a named protocol
 * revision, then changing together: the version and revision in this
 * docblock, FIXTURE_SHA256, the vector name guards in the Workers lane, and
 * the name guards below.
 */
const FIXTURE_SHA256 = '1a8a3735408675bf9660ce1372f77723a9ffda8084010fa52eb756a330961589'; // pragma: allowlist secret

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

interface SealedRow {
  name: string;
  cache_key: string;
  format: string;
  compressed: boolean;
  original_type?: string;
  ciphertext_hex: string;
}

interface Fixture {
  master_key_hex: string;
  tenant_id: string;
  vectors: (SealedRow & { plaintext_hex: string })[];
  master_key_input: {
    tenant_id: string;
    accept_vectors: (SealedRow & { master_key_hex: string; plaintext_hex: string })[];
    reject_vectors: { name: string; master_key_hex: string }[];
  };
  keyring: {
    configuration: {
      vectors: {
        name: string;
        current_master_key_hex: string;
        decrypt_only_master_keys_hex: string[];
        verdict: 'accept' | 'reject';
      }[];
    };
  };
  aad_reject_vectors: (SealedRow & { sealed_as: string })[];
  decrypted_container: {
    vectors: (SealedRow & { reader: string; plaintext_hex: string; outcome: string })[];
  };
}

const SEALED_ROW_SHAPE: ObjectShape = {
  name: 'string',
  cache_key: 'string',
  format: 'string',
  compressed: 'boolean',
  original_type: ['string', 'undefined'],
  ciphertext_hex: 'string',
};

function assertFixtureFile(value: unknown): asserts value is Fixture {
  assertFixture(
    value,
    {
      master_key_hex: 'string',
      tenant_id: 'string',
      vectors: table({ ...SEALED_ROW_SHAPE, plaintext_hex: 'string' }),
      master_key_input: {
        tenant_id: 'string',
        accept_vectors: table({
          ...SEALED_ROW_SHAPE,
          master_key_hex: 'string',
          plaintext_hex: 'string',
        }),
        reject_vectors: table({ name: 'string', master_key_hex: 'string' }),
      },
      keyring: {
        configuration: {
          vectors: table({
            name: 'string',
            current_master_key_hex: 'string',
            decrypt_only_master_keys_hex: table('string'),
            verdict: oneOf('accept', 'reject'),
          }),
        },
      },
      aad_reject_vectors: table({ ...SEALED_ROW_SHAPE, sealed_as: 'string' }),
      decrypted_container: {
        vectors: table({
          ...SEALED_ROW_SHAPE,
          reader: 'string',
          plaintext_hex: 'string',
          outcome: 'string',
        }),
      },
    },
    'encryption.json'
  );
}

const parsed: unknown = JSON.parse(raw.toString('utf8'));
assertFixtureFile(parsed);
const fixture: Fixture = parsed;
const masterKeyInput = fixture.master_key_input;

class InMemoryBackend implements Backend {
  store = new Map<string, Uint8Array>();

  /** Prepended to every key on the way to `store`, as ioredis keyPrefix does. */
  constructor(readonly keyPrefix = '') {}

  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(this.keyPrefix + key) ?? null;
  }
  async set(key: string, value: Uint8Array): Promise<void> {
    this.store.set(this.keyPrefix + key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.store.delete(this.keyPrefix + key);
  }
  async exists(key: string): Promise<boolean> {
    return this.store.has(this.keyPrefix + key);
  }
  async close(): Promise<void> {
    this.store.clear();
  }
}

/** A backend holding each row's ciphertext under the key the store sees. */
function plant(rows: SealedRow[], keyPrefix = ''): InMemoryBackend {
  const backend = new InMemoryBackend(keyPrefix);
  for (const row of rows) backend.store.set(row.cache_key, Buffer.from(row.ciphertext_hex, 'hex'));
  return backend;
}

/**
 * A compute function that must never run, for an interop wrap of `arity`
 * arguments: the interop guard reads fn.length, which a mock's rest
 * parameters report as 0.
 */
function computeOfArity(arity: number) {
  const compute = vi.fn(async (..._args: unknown[]): Promise<unknown> => {
    throw new Error('the sealed entry must be read, not recomputed');
  });
  Object.defineProperty(compute, 'length', { value: arity });
  return compute;
}

/**
 * Asserts that `read` failed after authentication: decryption succeeded and
 * the plaintext was refused, with `message`.
 */
async function expectRefusedAfterDecrypt(read: Promise<unknown>, message: RegExp): Promise<void> {
  await expect(read).rejects.toBeInstanceOf(SerializationError);
  await expect(read).rejects.toThrow(message);
}

/** The read-path refusal of a plaintext that holds bytes after its one document. */
const TRAILING_BYTES = /^Trailing bytes after MessagePack document: /;

/** The read-path refusal of a plaintext that is no ByteStorage envelope. */
const NOT_AN_ENVELOPE = /not an envelope core would accept; refused before unpack$/;

/** A cache under the fixture's main key and tenant, with nothing absorbing a read's error. */
function vectorCache(backend: Backend, compression: boolean) {
  return createCache({
    backend,
    l1: { enabled: false },
    encryption: { masterKey: fixture.master_key_hex, tenantId: fixture.tenant_id },
    reliability: { degradation: false },
    compression,
  });
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

/**
 * The interop read that reaches each accept row's sealed entry, and the value
 * it holds. Every row is an interop-mode.json key holding one of its values.
 */
const ACCEPT_READS: Record<
  string,
  { namespace: string; op: string; args: unknown[]; value: unknown }
> = {
  // empty_args, holding [1, "two", 3.5, null, true].
  master_key_every_hex_digit: {
    namespace: 'users',
    op: 'get_all',
    args: [],
    value: [1, 'two', 3.5, null, true],
  },
  // uuid_lowercased (a UUID is passed as its lowercase string), holding
  // float_value_stays_float64, which reads back as a plain number.
  master_key_first_byte_80: {
    namespace: 'users',
    op: 'get_by_uuid',
    args: ['550e8400-e29b-41d4-a716-446655440000'],
    value: 2,
  },
};

describe('encryption.json master_key_input (protocol 1.4.0) — createCache.secure', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('vendors both accept rows, all eleven hex rejects, and the "default" tenant', () => {
    expect(masterKeyInput.tenant_id).toBe('default');
    expect(masterKeyInput.accept_vectors.map((v) => v.name)).toEqual(Object.keys(ACCEPT_READS));
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
      async (name, vector) => {
        const read = ACCEPT_READS[name]!;
        expect([vector.format, vector.compressed]).toEqual(['msgpack', false]);
        expect(generateInteropKey(read.namespace, read.op, read.args)).toBe(vector.cache_key);

        vi.stubEnv('CACHEKIT_PREVIOUS_MASTER_KEYS', undefined);
        // Every accept row in one backend, so a read that reached another
        // row's entry would not decrypt.
        const backend = plant(masterKeyInput.accept_vectors);
        const cache = createCache.secure({
          backend,
          l1: { enabled: false },
          ...supplyKey(vector.master_key_hex),
        });
        try {
          const compute = computeOfArity(read.args.length);
          const wrapped = cache.wrap(compute, {
            namespace: read.namespace,
            interop: read.op,
            interopArity: read.args.length,
            ttl: 60,
          });

          expect(await wrapped(...read.args)).toEqual(read.value);
          expect(compute).not.toHaveBeenCalled();
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

describe('encryption.json keyring.configuration (protocol 1.5.0) — loaded at construction', () => {
  const rows = fixture.keyring.configuration.vectors;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('vendors the four configuration rows', () => {
    expect(rows.map((v) => v.name)).toEqual([
      'keyring_three_decrypt_only_keys',
      'keyring_four_decrypt_only_keys',
      'keyring_current_key_decrypt_only',
      'keyring_current_key_decrypt_only_uppercase',
    ]);
  });

  // The decrypt-only keys reach createCache.secure as an option or as
  // CACHEKIT_PREVIOUS_MASTER_KEYS, comma-separated; createCache takes them
  // only as an option.
  const SOURCES = [
    [
      'createCache encryption.previousMasterKeys',
      (current: string, previous: string[]) =>
        createCache({
          backend: new InMemoryBackend(),
          l1: { enabled: false },
          encryption: { masterKey: current, previousMasterKeys: previous },
        }),
    ],
    [
      'createCache.secure previousMasterKeys',
      (current: string, previous: string[]) =>
        createCache.secure({
          backend: new InMemoryBackend(),
          l1: { enabled: false },
          masterKey: current,
          previousMasterKeys: previous,
        }),
    ],
    [
      'createCache.secure CACHEKIT_PREVIOUS_MASTER_KEYS',
      (current: string, previous: string[]) => {
        vi.stubEnv('CACHEKIT_PREVIOUS_MASTER_KEYS', previous.join(','));
        return createCache.secure({
          backend: new InMemoryBackend(),
          l1: { enabled: false },
          masterKey: current,
        });
      },
    ],
  ] as const;

  describe.each(SOURCES)('via %s', (_source, construct) => {
    it.each(rows.map((v) => [v.name, v] as const))('%s', async (_name, row) => {
      const load = () => construct(row.current_master_key_hex, row.decrypt_only_master_keys_hex);
      if (row.verdict === 'reject') {
        expect(load).toThrow(ConfigurationError);
        return;
      }
      // The keyring reaches the native binding lazily, on first use, so only
      // an encrypted round trip shows the binding accepted it.
      const cache = load();
      try {
        await cache.set('keyring:probe', 1);
        expect(await cache.get('keyring:probe')).toBe(1);
      } finally {
        await cache.close();
      }
    });
  });
});

/**
 * The cachekit-ts reader that presents each aad_reject_vectors row it can
 * build. Its AAD carries no original_type and the format msgpack, so it
 * builds only the four-component rows, the compressed flag from its
 * compression setting, and the key with the backend's prefix in front. The
 * rest take an original_type or another format, which only cachekit-py's
 * frame-header reader presents.
 */
const AAD_READERS: Record<string, { compression: boolean; keyPrefix: string }> = {
  aad_compressed_false_sealed_true: { compression: false, keyPrefix: '' },
  aad_without_original_type_sealed_with: { compression: false, keyPrefix: '' },
  aad_compressed_true_sealed_false: { compression: true, keyPrefix: '' },
  aad_without_original_type_sealed_with_msgpack: { compression: true, keyPrefix: '' },
  aad_key_with_prefix_sealed_without: { compression: false, keyPrefix: 'app:' },
};

const AAD_NOT_BUILT = [
  'aad_format_msgpack_sealed_arrow',
  'aad_with_original_type_sealed_without',
  'aad_compressed_false_sealed_true_five_components',
  'aad_compressed_true_sealed_false_five_components',
  'aad_format_arrow_sealed_msgpack',
];

describe('encryption.json aad_reject_vectors (protocol 1.5.0, ENC-1) — no retry with another AAD', () => {
  const rows = fixture.aad_reject_vectors;

  it('every row is either presented below or one no cachekit-ts reader builds', () => {
    expect(rows.map((v) => v.name).sort()).toEqual(
      [...Object.keys(AAD_READERS), ...AAD_NOT_BUILT].sort()
    );
  });

  // Controls: each reader authenticates an entry sealed under the AAD it
  // builds, so the failures below are the AAD, not the key, tenant or
  // prefix handling. Neither plaintext is a value these readers decode, so
  // each read fails after decryption, with the error that names its bytes.
  // The prefixed control reads basic_bytes's key test:vector:1 as vector:1
  // behind the prefix test:, so it authenticates only if the AAD carries
  // the prefix exactly once.
  it.each([
    ['compression off', 'basic_bytes', false, '', TRAILING_BYTES],
    ['compression on', 'compressed_basic', true, '', NOT_AN_ENVELOPE],
    ['compression off, key prefix test:,', 'basic_bytes', false, 'test:', TRAILING_BYTES],
  ] as const)(
    'control: the %s reader authenticates %s',
    async (_reader, name, compression, keyPrefix, refusal) => {
      const sealed = fixture.vectors.find((v) => v.name === name)!;
      expect([sealed.format, sealed.compressed, sealed.original_type]).toEqual([
        'msgpack',
        compression,
        undefined,
      ]);
      expect(sealed.cache_key.startsWith(keyPrefix)).toBe(true);
      const cache = vectorCache(plant([sealed], keyPrefix), compression);
      try {
        await expectRefusedAfterDecrypt(
          cache.get(sealed.cache_key.slice(keyPrefix.length)),
          refusal
        );
      } finally {
        await cache.close();
      }
    }
  );

  it.each(rows.filter((v) => v.name in AAD_READERS).map((v) => [v.name, v] as const))(
    '%s: fails authentication',
    async (name, row) => {
      const { compression, keyPrefix } = AAD_READERS[name]!;
      // The row's AAD inputs are exactly the ones this reader builds.
      expect(row.format).toBe('msgpack');
      expect(row.original_type).toBeUndefined();
      expect(row.compressed).toBe(compression);
      expect(row.cache_key.startsWith(keyPrefix)).toBe(true);

      const cache = vectorCache(plant([row], keyPrefix), compression);
      try {
        const read = cache.get(row.cache_key.slice(keyPrefix.length));
        // Most rows' plaintexts are no value after a retry either, so only
        // the authentication failure itself shows that none was attempted.
        await expect(read).rejects.toBeInstanceOf(EncryptionError);
        await expect(read).rejects.toThrow(/^Decryption failed: /);
      } finally {
        await cache.close();
      }
    }
  );
});

describe('encryption.json decrypted_container (protocol 1.5.0, ENC-3) — the configured container only', () => {
  const rows = fixture.decrypted_container.vectors;
  const row = (name: string) => {
    const found = rows.find((v) => v.name === name);
    if (found === undefined) throw new Error(`decrypted_container has no row ${name}`);
    return found;
  };

  it('vendors four rows for the readers cachekit-ts has, and two for cachekit-py readers', () => {
    expect(rows.map((v) => [v.name, v.reader])).toEqual([
      ['container_envelope_to_plain_reader', 'plain_msgpack'],
      ['container_trailing_byte_to_interop_reader', 'interop'],
      ['container_plain_to_envelope_reader', 'bytestorage_envelope'],
      ['container_bare_arrow_to_arrow_reader', 'arrow_checksummed'],
      ['container_plain_json_to_orjson_reader', 'orjson_checksummed'],
      ['container_incomplete_tail_to_interop_reader', 'interop'],
    ]);
  });

  it('container_envelope_to_plain_reader: compression off returns the envelope array, not the map inside it', async () => {
    const vector = row('container_envelope_to_plain_reader');
    expect([vector.compressed, vector.outcome]).toEqual([false, 'not_unwrapped']);
    const cache = vectorCache(plant([vector]), false);
    try {
      // The envelope is a positional 4-tuple ending in its format string.
      const value = await cache.get<unknown[]>(vector.cache_key);
      expect(value).toHaveLength(4);
      expect(value![3]).toBe('msgpack');
    } finally {
      await cache.close();
    }
  });

  it('container_plain_to_envelope_reader: compression on refuses plain MessagePack', async () => {
    const vector = row('container_plain_to_envelope_reader');
    expect([vector.compressed, vector.outcome]).toEqual([true, 'error']);
    const cache = vectorCache(plant([vector]), true);
    try {
      await expectRefusedAfterDecrypt(cache.get(vector.cache_key), NOT_AN_ENVELOPE);
    } finally {
      await cache.close();
    }
  });

  // The interop read of each row's interop-mode.json key: bool_null and
  // issue_example_mixed.
  it.each([
    ['container_trailing_byte_to_interop_reader', [true, false, null]],
    ['container_incomplete_tail_to_interop_reader', [42, 'hello', { b: 2, a: 1 }]],
  ] as const)('%s: the interop read returns no value', async (name, args) => {
    const vector = row(name);
    expect([vector.compressed, vector.outcome]).toEqual([false, 'error']);
    expect(generateInteropKey('t', 'op', [...args])).toBe(vector.cache_key);

    // An interop read builds AAD compressed=False whatever this setting is,
    // which is how the row (asserted false above) was sealed.
    const cache = vectorCache(plant([vector]), vector.compressed);
    try {
      const compute = computeOfArity(args.length);
      const wrapped = cache.wrap(compute, {
        namespace: 't',
        interop: 'op',
        interopArity: args.length,
        ttl: 60,
      });
      // Refused after authentication, by the one-document check.
      await expectRefusedAfterDecrypt(wrapped(...args), TRAILING_BYTES);
      expect(compute).not.toHaveBeenCalled();
    } finally {
      await cache.close();
    }
  });
});

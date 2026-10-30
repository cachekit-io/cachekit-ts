/**
 * WebCrypto AES-256-GCM bindings — Workers lane
 *
 * The Workers EncryptionManager encrypts and decrypts through crypto.subtle
 * (src/workers/webcrypto.ts) on keys wasm cachekit-core derives. These tests
 * pin, inside real workerd:
 * - byte parity with the protocol vectors (encrypt reproduces every
 *   ciphertext_hex from its nonce; every vector decrypts; fingerprints match);
 * - interop with the wasm bindings at 64 KiB and 1 MB, both directions;
 * - the counter-nonce scheme: instance id ‖ counter, reserved before any
 *   await, never rolled back, exhausted at 2^32−1;
 * - tenant bounds from core, the input limits, error mapping, the keyring
 *   loop, and how key material is held and wiped.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as wasm from '@cachekit-io/cachekit-core-wasm';
import { EncryptionManager } from '../../src/workers/runtime.js';
import {
  setInstanceCounterForTesting,
  webCryptoEncryptionBindings,
  type KeyDerivationCore,
  type WebCryptoTenantKeys,
} from '../../src/workers/webcrypto.js';
import {
  EncryptionManagerCore,
  type EncryptionBindings,
} from '../../src/encryption/manager-core.js';
import { ConfigurationError, EncryptionError, NonceExhaustedError } from '../../src/errors.js';
import fixture from './fixtures/encryption.json' with { type: 'json' };

interface EncryptionVector {
  name: string;
  plaintext_hex: string;
  cache_key: string;
  compressed: boolean;
  aad_hex: string;
  ciphertext_hex: string;
}

const vectors = fixture.vectors as EncryptionVector[];
const masterKeyHex = fixture.master_key_hex as string;
const tenantId = fixture.tenant_id as string;
const keyring = fixture.keyring as {
  tenant_id: string;
  entries: { id: string; master_key_hex: string; derived_key_fingerprint_hex: string }[];
  vectors: (EncryptionVector & { encrypted_with: string })[];
};
const defaultTenant = fixture.default_tenant as {
  tenant_id: string;
  derived_key_fingerprint_hex: string;
  vectors: EncryptionVector[];
};
const keyringEntry = (id: string) => keyring.entries.find((e) => e.id === id)!;

const K1_HEX = '11'.repeat(32);
const K2_HEX = '22'.repeat(32);
const K3_HEX = '33'.repeat(32);
const MiB = 1024 * 1024;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function realCore(): KeyDerivationCore {
  wasm.ensureInitialized();
  return { deriveKey: wasm.deriveKey, deriveTenantKeys: wasm.deriveTenantKeys };
}

/** Byte equality without toEqual, whose element-wise diff takes seconds on 1 MB. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Deterministic, cheap filler bytes for large payloads. */
function payload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

/**
 * A manager over the WebCrypto bindings with spies on the wasm derive calls,
 * exposing the tenant keys the bindings built.
 */
function spiedManager(
  masterHex = masterKeyHex,
  tenant: string | undefined = tenantId,
  previous: string[] = []
) {
  const core = realCore();
  const derives: { master: number[]; tenant: string }[] = [];
  const handles: { free: ReturnType<typeof vi.fn> }[] = [];
  const derivedCopies: Uint8Array[] = [];
  const masterArgs: Uint8Array[] = [];
  const spiedCore: KeyDerivationCore = {
    deriveTenantKeys: (masterKey, t) => {
      masterArgs.push(masterKey);
      const handle = core.deriveTenantKeys(masterKey, t);
      const realFree = handle.free.bind(handle);
      const spied = {
        encryptionFingerprint: () => handle.encryptionFingerprint(),
        free: vi.fn(realFree),
      };
      handles.push(spied);
      return spied;
    },
    deriveKey: (masterKey, domain, salt) => {
      masterArgs.push(masterKey);
      derives.push({ master: Array.from(masterKey), tenant: salt });
      const out = core.deriveKey(masterKey, domain, salt);
      derivedCopies.push(out);
      return out;
    },
  };
  const bindings = webCryptoEncryptionBindings(spiedCore);
  let tenantKeys: WebCryptoTenantKeys | undefined;
  const capturing: EncryptionBindings = {
    ...bindings,
    deriveTenantKeys: async (...args) => {
      tenantKeys = (await bindings.deriveTenantKeys(...args)) as WebCryptoTenantKeys;
      return tenantKeys;
    },
  };
  const manager = new EncryptionManagerCore(masterHex, tenant, async () => capturing, previous);
  return {
    manager,
    derives,
    handles,
    derivedCopies,
    masterArgs,
    tenantKeys: () => tenantKeys!,
  };
}

/** Raw bindings plus tenant keys for (master, tenant), for vector-level tests. */
async function rawBindings(masterHex: string, tenant: string, previous: string[] = []) {
  const bindings = webCryptoEncryptionBindings(realCore());
  const tk = (await bindings.deriveTenantKeys(
    hexToBytes(masterHex),
    tenant,
    previous.map(hexToBytes)
  )) as WebCryptoTenantKeys;
  return { bindings, tk };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('byte parity with the protocol vectors', () => {
  it.each(vectors.map((v) => [v.name, v] as const))(
    'encrypt reproduces %s exactly from its nonce and aad_hex',
    async (_name, vector) => {
      const ciphertext = hexToBytes(vector.ciphertext_hex);
      const nonce = new DataView(ciphertext.buffer);
      // Steer the real nonce path to the vector's nonce: its first 8 bytes are
      // the instance id, its last 4 the counter.
      setInstanceCounterForTesting(nonce.getBigUint64(0, false));
      const { bindings, tk } = await rawBindings(masterKeyHex, tenantId);
      tk.nonceCounter = nonce.getUint32(8, false);
      const out = await bindings.encryptWithTenantKeys(
        hexToBytes(vector.plaintext_hex),
        hexToBytes(vector.aad_hex),
        tk
      );
      expect(bytesToHex(out)).toBe(vector.ciphertext_hex);
      setInstanceCounterForTesting();
    }
  );

  it.each(vectors.map((v) => [v.name, v] as const))(
    'decrypts vector %s with its aad_hex',
    async (_name, vector) => {
      const { bindings, tk } = await rawBindings(masterKeyHex, tenantId);
      const plaintext = await bindings.decryptWithTenantKeys(
        hexToBytes(vector.ciphertext_hex),
        hexToBytes(vector.aad_hex),
        tk
      );
      expect(bytesToHex(plaintext)).toBe(vector.plaintext_hex);
    }
  );

  it.each(keyring.vectors.map((v) => [v.name, v] as const))(
    'decrypts keyring vector %s through masterKey=k2, previousMasterKeys=[k1]',
    async (_name, vector) => {
      const { bindings, tk } = await rawBindings(
        keyringEntry('k2').master_key_hex,
        keyring.tenant_id,
        [keyringEntry('k1').master_key_hex]
      );
      const plaintext = await bindings.decryptWithTenantKeys(
        hexToBytes(vector.ciphertext_hex),
        hexToBytes(vector.aad_hex),
        tk
      );
      expect(bytesToHex(plaintext)).toBe(vector.plaintext_hex);
    }
  );

  it.each(defaultTenant.vectors.map((v) => [v.name, v] as const))(
    'decrypts default-tenant vector %s',
    async (_name, vector) => {
      const { bindings, tk } = await rawBindings(masterKeyHex, defaultTenant.tenant_id);
      const plaintext = await bindings.decryptWithTenantKeys(
        hexToBytes(vector.ciphertext_hex),
        hexToBytes(vector.aad_hex),
        tk
      );
      expect(bytesToHex(plaintext)).toBe(vector.plaintext_hex);
    }
  );

  it('getKeyFingerprint matches the main, default-tenant and keyring fingerprints', async () => {
    const cases: [EncryptionManager, string][] = [
      [new EncryptionManager(masterKeyHex, tenantId), fixture.derived_key_fingerprint_hex],
      [new EncryptionManager(masterKeyHex), defaultTenant.derived_key_fingerprint_hex],
      ...keyring.entries.map(
        (e) =>
          [
            new EncryptionManager(e.master_key_hex, keyring.tenant_id),
            e.derived_key_fingerprint_hex,
          ] as [EncryptionManager, string]
      ),
    ];
    for (const [manager, expected] of cases) {
      await manager.encrypt(new Uint8Array([1]), 'ns:fp');
      expect(bytesToHex((await manager.getKeyFingerprint())!)).toBe(expected);
      manager.dispose();
    }
  });
});

describe('large-payload interop with the wasm bindings', () => {
  const aad = new TextEncoder().encode('cachekit large-payload interop aad');

  it.each([
    ['64 KiB', 64 * 1024],
    ['1 MB', MiB],
  ])('%s: WebCrypto → wasm and wasm → WebCrypto', async (_label, size) => {
    const data = payload(size);
    const { bindings, tk } = await rawBindings(masterKeyHex, tenantId);
    wasm.ensureInitialized();
    const wasmKeys = wasm.deriveTenantKeys(hexToBytes(masterKeyHex), tenantId);
    try {
      const fromWebCrypto = await bindings.encryptWithTenantKeys(data, aad, tk);
      expect(sameBytes(wasm.decryptWithTenantKeys(fromWebCrypto, aad, wasmKeys), data)).toBe(true);

      const fromWasm = wasm.encryptWithTenantKeys(data, aad, wasmKeys);
      expect(sameBytes(await bindings.decryptWithTenantKeys(fromWasm, aad, tk), data)).toBe(true);
    } finally {
      wasmKeys.free();
    }
  });
});

describe('counter nonces', () => {
  const nonceHex = (ciphertext: Uint8Array) => bytesToHex(ciphertext.subarray(0, 12));

  it(
    'never repeats over 100,000 sequential encrypts on one manager',
    { timeout: 120_000 },
    async () => {
      const manager = new EncryptionManager(masterKeyHex, tenantId);
      const seen = new Set<string>();
      const data = new Uint8Array([1, 2, 3]);
      for (let i = 0; i < 100_000; i++) {
        seen.add(nonceHex(await manager.encrypt(data, 'ns:seq')));
      }
      expect(seen.size).toBe(100_000);
      expect(await manager.getEncryptionCount()).toBe(100_000);
      manager.dispose();
    }
  );

  it(
    'gives 10,000 concurrent encrypts on one manager 10,000 distinct nonces',
    { timeout: 60_000 },
    async () => {
      const manager = new EncryptionManager(masterKeyHex, tenantId);
      const data = new Uint8Array([4, 5, 6]);
      const out = await Promise.all(
        Array.from({ length: 10_000 }, () => manager.encrypt(data, 'ns:par'))
      );
      expect(new Set(out.map(nonceHex)).size).toBe(10_000);
      manager.dispose();
    }
  );

  it('advances the counter on a failed encrypt and never rolls it back', async () => {
    const { manager } = spiedManager();
    await manager.encrypt(new Uint8Array([1]), 'ns:k');
    expect(await manager.getEncryptionCount()).toBe(1);

    vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('stubbed failure'));
    await expect(manager.encrypt(new Uint8Array([1]), 'ns:k')).rejects.toThrow(EncryptionError);
    expect(await manager.getEncryptionCount()).toBe(2);

    const next = await manager.encrypt(new Uint8Array([1]), 'ns:k');
    expect(new DataView(next.buffer, next.byteOffset).getUint32(8, false)).toBe(2);
    expect(await manager.getEncryptionCount()).toBe(3);
    manager.dispose();
  });

  it('builds each nonce from the 8-byte instance id and the 4-byte big-endian counter', async () => {
    setInstanceCounterForTesting(0x0102030405060708n);
    const manager = new EncryptionManager(masterKeyHex, tenantId);
    expect(await manager.getEncryptionCount()).toBe(0);
    const first = await manager.encrypt(new Uint8Array([1]), 'ns:k');
    expect(await manager.getEncryptionCount()).toBe(1);
    const second = await manager.encrypt(new Uint8Array([1]), 'ns:k');
    expect(await manager.getEncryptionCount()).toBe(2);
    expect(nonceHex(first)).toBe('010203040506070800000000');
    expect(nonceHex(second)).toBe('010203040506070800000001');
    manager.dispose();
    setInstanceCounterForTesting();
  });

  it('gives two managers consecutive instance ids, wrapping mod 2^64', async () => {
    setInstanceCounterForTesting(2n ** 64n - 1n);
    const a = new EncryptionManager(masterKeyHex, tenantId);
    const b = new EncryptionManager(masterKeyHex, tenantId);
    const fromA = await a.encrypt(new Uint8Array([1]), 'ns:k');
    const fromB = await b.encrypt(new Uint8Array([1]), 'ns:k');
    expect(nonceHex(fromA)).toBe('ffffffffffffffff00000000');
    expect(nonceHex(fromB)).toBe('000000000000000000000000');
    a.dispose();
    b.dispose();
    setInstanceCounterForTesting();
  });

  it('seeds the instance-id counter once per isolate from 8 random bytes', async () => {
    // Warm up first, so cachekit-core's own wasm instance counter is already
    // seeded and only the adapter's seed can draw 8 bytes below.
    const warm = new EncryptionManager(masterKeyHex, tenantId);
    await warm.encrypt(new Uint8Array([1]), 'ns:k');
    warm.dispose();
    setInstanceCounterForTesting();

    const realGetRandomValues = crypto.getRandomValues.bind(crypto);
    const seedDraws: number[] = [];
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array && array.length === 8) {
          seedDraws.push(array.length);
          array.set([0xaa, 0xbb, 0xcc, 0xdd, 0x00, 0x00, 0x00, 0x10]);
          return array;
        }
        return realGetRandomValues(array as unknown as Uint8Array<ArrayBuffer>) as unknown as T;
      }
    );

    const a = new EncryptionManager(masterKeyHex, tenantId);
    const b = new EncryptionManager(masterKeyHex, tenantId);
    const fromA = await a.encrypt(new Uint8Array([1]), 'ns:k');
    const fromB = await b.encrypt(new Uint8Array([1]), 'ns:k');
    expect(seedDraws).toEqual([8]);
    expect(nonceHex(fromA)).toBe('aabbccdd0000001000000000');
    expect(nonceHex(fromB)).toBe('aabbccdd0000001100000000');
    a.dispose();
    b.dispose();
    setInstanceCounterForTesting();
  });

  it('throws NonceExhaustedError at counter 2^32−1, and again on the next encrypt', async () => {
    const { manager, tenantKeys } = spiedManager();
    await manager.encrypt(new Uint8Array([1]), 'ns:k');
    tenantKeys().nonceCounter = 2 ** 32 - 1;

    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await manager.encrypt(new Uint8Array([1]), 'ns:k').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NonceExhaustedError);
      // The binding's error carries the contract string the manager classifies.
      expect((error as Error & { cause?: Error }).cause?.message).toContain(
        'Nonce counter exhausted'
      );
    }
    manager.dispose();
  });
});

describe('tenant bounds come from cachekit-core', () => {
  it('derives keys for a tenant id of exactly 1,024 UTF-8 bytes', async () => {
    const manager = new EncryptionManager(masterKeyHex, 'a'.repeat(1024));
    const ct = await manager.encrypt(new Uint8Array([1]), 'ns:k');
    expect(await manager.decrypt(ct, 'ns:k')).toEqual(new Uint8Array([1]));
    manager.dispose();
  });

  it.each([
    ['1,025 ASCII bytes', 'a'.repeat(1025)],
    // 513 UTF-16 units, 1,026 UTF-8 bytes: a UTF-16 length check would pass it.
    ['a multibyte tenant under 1,025 UTF-16 units', 'é'.repeat(513)],
  ])('fails the first operation with EncryptionError for %s', async (_label, tenant) => {
    const manager = new EncryptionManager(masterKeyHex, tenant);
    await expect(manager.encrypt(new Uint8Array([1]), 'ns:k')).rejects.toThrow(EncryptionError);
    manager.dispose();
  });

  it('rejects an empty tenant id at construction', () => {
    expect(() => new EncryptionManager(masterKeyHex, '')).toThrow(ConfigurationError);
  });
});

describe('input limits are checked before crypto.subtle', () => {
  // A real 100 MiB buffer would crowd the isolate's memory, so the oversize
  // plaintext and ciphertext are views that only report their length: the
  // limit is checked before anything reads the bytes.
  const oversize = (length: number) => ({ length }) as Uint8Array;

  it('rejects plaintext over 100 MiB and AAD over 64 KiB without calling encrypt', async () => {
    const { bindings, tk } = await rawBindings(masterKeyHex, tenantId);
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt');
    await expect(
      bindings.encryptWithTenantKeys(oversize(100 * MiB + 1), new Uint8Array(1), tk)
    ).rejects.toThrow(/Plaintext exceeds maximum size/);
    await expect(
      bindings.encryptWithTenantKeys(new Uint8Array(1), new Uint8Array(64 * 1024 + 1), tk)
    ).rejects.toThrow(/AAD exceeds maximum size/);
    expect(encrypt).not.toHaveBeenCalled();
    // Rejected inputs consume no nonce.
    expect(tk.getNonceCounter()).toBe(0);
  });

  it('rejects ciphertext over 100 MiB + 1024, under 28 bytes, or AAD over 64 KiB without calling decrypt', async () => {
    const { bindings, tk } = await rawBindings(masterKeyHex, tenantId);
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    await expect(
      bindings.decryptWithTenantKeys(oversize(100 * MiB + 1025), new Uint8Array(1), tk)
    ).rejects.toThrow(/Ciphertext exceeds maximum size/);
    await expect(
      bindings.decryptWithTenantKeys(new Uint8Array(28), new Uint8Array(64 * 1024 + 1), tk)
    ).rejects.toThrow(/AAD exceeds maximum size/);
    await expect(
      bindings.decryptWithTenantKeys(new Uint8Array(27), new Uint8Array(1), tk)
    ).rejects.toThrow(/Ciphertext too short/);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('accepts AAD of exactly 64 KiB', async () => {
    const { bindings, tk } = await rawBindings(masterKeyHex, tenantId);
    const aad = new Uint8Array(64 * 1024);
    const ct = await bindings.encryptWithTenantKeys(new Uint8Array([9]), aad, tk);
    expect(await bindings.decryptWithTenantKeys(ct, aad, tk)).toEqual(new Uint8Array([9]));
  });
});

describe('error mapping through the manager', () => {
  it('maps a rejected crypto.subtle.encrypt to EncryptionError, not NonceExhaustedError', async () => {
    const manager = new EncryptionManager(masterKeyHex, tenantId);
    vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('stubbed failure'));
    const error = await manager.encrypt(new Uint8Array([1]), 'ns:k').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EncryptionError);
    expect(error).not.toBeInstanceOf(NonceExhaustedError);
    manager.dispose();
  });

  it('maps a rejected decrypt to EncryptionError', async () => {
    const manager = new EncryptionManager(masterKeyHex, tenantId);
    await expect(manager.decrypt(new Uint8Array(27), 'ns:k')).rejects.toThrow(EncryptionError);
    await expect(manager.decrypt(new Uint8Array(64), 'ns:k')).rejects.toThrow(EncryptionError);
    manager.dispose();
  });
});

describe('keyring decrypt loop', () => {
  const CACHE_KEY = 'ns:workers:keyring';

  async function writtenWith(masterHex: string, data: Uint8Array): Promise<Uint8Array> {
    const writer = new EncryptionManager(masterHex, tenantId);
    const ct = await writer.encrypt(data, CACHE_KEY);
    writer.dispose();
    return ct;
  }

  it('tries the current key, then each previous key in order, with the same AAD', async () => {
    const data = new TextEncoder().encode('rotated');
    const fromK1 = await writtenWith(K1_HEX, data);
    const fromK2 = await writtenWith(K2_HEX, data);
    const reader = new EncryptionManager(K3_HEX, tenantId, [K2_HEX, K1_HEX]);
    await reader.encrypt(new Uint8Array([0]), CACHE_KEY); // init outside the spy

    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    expect(await reader.decrypt(fromK2, CACHE_KEY)).toEqual(data);
    expect(decrypt).toHaveBeenCalledTimes(2);
    decrypt.mockClear();

    expect(await reader.decrypt(fromK1, CACHE_KEY)).toEqual(data);
    expect(decrypt).toHaveBeenCalledTimes(3);
    const keys = decrypt.mock.calls.map(([, key]) => key);
    // The current key alone may encrypt; the k2 attempt precedes the k1 one
    // (k2 is the second call here and decrypted fromK2 above as the second).
    expect(keys[0].usages.slice().sort()).toEqual(['decrypt', 'encrypt']);
    expect(keys[1].usages).toEqual(['decrypt']);
    expect(keys[2].usages).toEqual(['decrypt']);
    expect(new Set(keys).size).toBe(3);
    const aads = decrypt.mock.calls.map(([params]) =>
      bytesToHex((params as { additionalData: Uint8Array }).additionalData)
    );
    expect(new Set(aads).size).toBe(1);
    reader.dispose();
  });

  it('stops at a non-authentication error instead of trying the next key', async () => {
    const reader = new EncryptionManager(K3_HEX, tenantId, [K2_HEX, K1_HEX]);
    const fromK1 = await writtenWith(K1_HEX, new Uint8Array([1]));
    await reader.encrypt(new Uint8Array([0]), CACHE_KEY);
    const decrypt = vi
      .spyOn(crypto.subtle, 'decrypt')
      .mockRejectedValueOnce(new TypeError('structural failure'));
    await expect(reader.decrypt(fromK1, CACHE_KEY)).rejects.toThrow(EncryptionError);
    expect(decrypt).toHaveBeenCalledTimes(1);
    reader.dispose();
  });

  it('makes no attempt with any key for a ciphertext under 28 bytes', async () => {
    const reader = new EncryptionManager(K3_HEX, tenantId, [K2_HEX, K1_HEX]);
    await reader.encrypt(new Uint8Array([0]), CACHE_KEY);
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    await expect(reader.decrypt(new Uint8Array(27), CACHE_KEY)).rejects.toThrow(EncryptionError);
    expect(decrypt).not.toHaveBeenCalled();
    reader.dispose();
  });

  it('derives and imports each keyring key once per manager across 10 decrypts', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fromK1 = await writtenWith(K1_HEX, data);
    const importKey = vi.spyOn(crypto.subtle, 'importKey');
    const { manager, derives, tenantKeys } = spiedManager(K3_HEX, tenantId, [K2_HEX, K1_HEX]);
    for (let i = 0; i < 10; i++) {
      expect(await manager.decrypt(fromK1, CACHE_KEY)).toEqual(data);
    }
    expect(derives.map((d) => bytesToHex(Uint8Array.from(d.master)))).toEqual([
      K3_HEX,
      K2_HEX,
      K1_HEX,
    ]);
    expect(importKey).toHaveBeenCalledTimes(3);
    expect(tenantKeys().keyringEntryCount()).toBe(3);
    manager.dispose();
  });
});

describe('key material', () => {
  it('imports every key non-extractable: current encrypt+decrypt, previous decrypt only', async () => {
    const importKey = vi.spyOn(crypto.subtle, 'importKey');
    const manager = new EncryptionManager(K3_HEX, tenantId, [K2_HEX, K1_HEX]);
    await manager.encrypt(new Uint8Array([1]), 'ns:k');
    const keys = await Promise.all(
      importKey.mock.results.map((r) => r.value as Promise<CryptoKey>)
    );
    expect(keys).toHaveLength(3);
    for (const call of importKey.mock.calls) expect(call[3]).toBe(false);
    for (const key of keys) expect(key.extractable).toBe(false);
    expect(keys[0].usages.slice().sort()).toEqual(['decrypt', 'encrypt']);
    expect(keys[1].usages).toEqual(['decrypt']);
    expect(keys[2].usages).toEqual(['decrypt']);
    manager.dispose();
  });

  it('wipes the derived bytes and the master-key bytes after init', async () => {
    const { manager, derives, derivedCopies, masterArgs } = spiedManager(K3_HEX, tenantId, [
      K2_HEX,
    ]);
    await manager.encrypt(new Uint8Array([1]), 'ns:k');
    // Every derive saw the real key bytes: none ran after the zero-fill.
    expect(derives.map((d) => d.master.every((b) => b === 0))).toEqual([false, false]);
    expect(derivedCopies).toHaveLength(2);
    for (const bytes of [...derivedCopies, ...masterArgs]) {
      expect(bytes.every((b) => b === 0)).toBe(true);
    }
    manager.dispose();
  });

  it('wipes the derived bytes and the master-key bytes when importKey rejects', async () => {
    vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new Error('import refused'));
    const { manager, derives, derivedCopies, masterArgs } = spiedManager(K3_HEX, tenantId, [
      K2_HEX,
    ]);
    await expect(manager.encrypt(new Uint8Array([1]), 'ns:k')).rejects.toThrow(EncryptionError);
    expect(derives).toHaveLength(2);
    expect(derives.map((d) => d.master.every((b) => b === 0))).toEqual([false, false]);
    for (const bytes of [...derivedCopies, ...masterArgs]) {
      expect(bytes.every((b) => b === 0)).toBe(true);
    }
    manager.dispose();
  });

  it('frees the wasm TenantKeys handle before init resolves, and keeps the fingerprint', async () => {
    const { manager, handles } = spiedManager();
    await manager.encrypt(new Uint8Array([1]), 'ns:k');
    expect(handles).toHaveLength(1);
    expect(handles[0].free).toHaveBeenCalledTimes(1);
    expect(bytesToHex((await manager.getKeyFingerprint())!)).toBe(
      fixture.derived_key_fingerprint_hex
    );
    manager.dispose();
  });

  it('reports isHardwareAccelerated() as null (unknown) on Workers', async () => {
    const manager = new EncryptionManager(masterKeyHex, tenantId);
    expect(await manager.isHardwareAccelerated()).toBeNull();
    manager.dispose();
  });
});

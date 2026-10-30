/**
 * EncryptionManagerCore contract tests over mock bindings — the logic here
 * is shared verbatim by the Node (NAPI) and Workers (wasm) entrypoints.
 * Covers single-derive under concurrent first
 * use, deterministic zeroize on dispose (including dispose racing init),
 * and the nonce-exhaustion error-message classification contract.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  EncryptionManagerCore,
  type EncryptionBindings,
  type EncryptionTenantKeys,
} from './manager-core.js';
import { ConfigurationError, EncryptionError, NonceExhaustedError } from '../errors.js';
import { MAX_AAD_SIZE } from '../constants.js';

const MASTER_KEY_HEX = 'ab'.repeat(32);

function mockBindings(overrides?: Partial<EncryptionBindings>) {
  const freed: EncryptionTenantKeys[] = [];
  const derived: EncryptionTenantKeys[] = [];
  const bindings: EncryptionBindings = {
    deriveTenantKeys: vi.fn(
      (_masterKey: Uint8Array, tenantId: string, previousMasterKeys?: Uint8Array[]) => {
        const keys: EncryptionTenantKeys = {
          tenantId,
          encryptionFingerprint: () => new Uint8Array(16),
          getNonceCounter: () => 0,
          keyringEntryCount: () => 1 + (previousMasterKeys?.length ?? 0),
          hardwareAccelerationEnabled: () => true,
          free() {
            freed.push(keys);
          },
        };
        derived.push(keys);
        return keys;
      }
    ),
    encryptWithTenantKeys: vi.fn(() => new Uint8Array([1])),
    decryptWithTenantKeys: vi.fn(() => new Uint8Array([2])),
    ...overrides,
  };
  return { bindings, freed, derived };
}

class TestManager extends EncryptionManagerCore {
  constructor(loader: () => Promise<EncryptionBindings>, tenantId?: string) {
    super(MASTER_KEY_HEX, tenantId, loader);
  }
}

describe('EncryptionManagerCore', () => {
  it('derives exactly one TenantKeys under concurrent first use', async () => {
    const { bindings, derived } = mockBindings();
    const manager = new TestManager(async () => bindings);

    await Promise.all([
      manager.encrypt(new Uint8Array([1]), 'ns:a'),
      manager.encrypt(new Uint8Array([2]), 'ns:b'),
      manager.decrypt(new Uint8Array(new Array(28).fill(0)), 'ns:c'),
    ]);

    expect(derived.length).toBe(1);
    manager.dispose();
  });

  it('retries initialization after a failed loader', async () => {
    const { bindings } = mockBindings();
    let attempts = 0;
    const manager = new TestManager(async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient load failure');
      return bindings;
    });

    await expect(manager.encrypt(new Uint8Array([1]), 'ns:k')).rejects.toThrow(EncryptionError);
    await expect(manager.encrypt(new Uint8Array([1]), 'ns:k')).resolves.toBeInstanceOf(Uint8Array);
    manager.dispose();
  });

  it('zeroizes on dispose, including a dispose that races initialization', async () => {
    const { bindings, freed, derived } = mockBindings();
    let releaseLoader!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLoader = resolve;
    });
    const manager = new TestManager(async () => {
      await gate;
      return bindings;
    });

    const inFlight = manager.encrypt(new Uint8Array([1]), 'ns:k');
    manager.dispose(); // dispose while the loader is still pending
    releaseLoader();

    await expect(inFlight).rejects.toThrow(EncryptionError);
    // The handle derived after dispose must be zeroized immediately, not parked
    expect(derived.length).toBe(1);
    expect(freed.length).toBe(1);
  });

  it('classifies the core nonce-exhaustion message into NonceExhaustedError', async () => {
    // Contract documented on EncryptionBindings: both bindings surface
    // cachekit-core's "Nonce counter exhausted - key rotation required".
    const { bindings } = mockBindings({
      encryptWithTenantKeys: vi.fn(() => {
        throw new Error('Encryption failed: Nonce counter exhausted - key rotation required');
      }),
    });
    const manager = new TestManager(async () => bindings);

    await expect(manager.encrypt(new Uint8Array([1]), 'ns:k')).rejects.toThrow(NonceExhaustedError);
    manager.dispose();
  });

  it('frees the TenantKeys handle exactly once on repeated dispose', async () => {
    const { bindings, freed } = mockBindings();
    const manager = new TestManager(async () => bindings);
    await manager.encrypt(new Uint8Array([1]), 'ns:k');

    manager.dispose();
    manager.dispose();
    expect(freed.length).toBe(1);
  });

  it('validateKey rejects a key longer than MAX_AAD_SIZE UTF-16 units without encoding it', () => {
    const manager = new TestManager(async () => mockBindings().bindings);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      expect(() => manager.validateKey('k'.repeat(MAX_AAD_SIZE + 1))).toThrow(ConfigurationError);
      expect(encode).not.toHaveBeenCalled();
      // Control: the spy does see the measured path, so the assertion above is not vacuous.
      manager.validateKey('k'.repeat(MAX_AAD_SIZE - 100));
      expect(encode).toHaveBeenCalled();
    } finally {
      encode.mockRestore();
      manager.dispose();
    }
  });

  // AAD overhead for the default tenant: version byte + four 4-byte lengths +
  // 'default' + 'msgpack' + 'True' (4) or 'False' (5).
  const overhead = (compressed: boolean) => 1 + 16 + 7 + 7 + (compressed ? 4 : 5);

  it.each([true, false])(
    'validateKey encodes no key that fits at 3 UTF-8 bytes per UTF-16 unit (compressed=%s)',
    (compressed) => {
      const manager = new TestManager(async () => mockBindings().bindings);
      const atBound = Math.floor((MAX_AAD_SIZE - overhead(compressed)) / 3);
      const encode = vi.spyOn(TextEncoder.prototype, 'encode');
      try {
        // The worst case at the bound: every unit a lone surrogate, 3 bytes as U+FFFD.
        manager.validateKey('\uD800'.repeat(atBound), compressed);
        expect(encode).not.toHaveBeenCalled();
        // One unit past the bound is measured, and still fits as ASCII.
        manager.validateKey('k'.repeat(atBound + 1), compressed);
        expect(encode).toHaveBeenCalledTimes(1);
      } finally {
        encode.mockRestore();
        manager.dispose();
      }
    }
  );

  it('validateKey and encrypt on a short key encode only the cache key, once', async () => {
    const { bindings } = mockBindings();
    const manager = new TestManager(async () => bindings);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      manager.validateKey('ns:k', true);
      await manager.encrypt(new Uint8Array([1]), 'ns:k', true);
      expect(encode.mock.calls.map(([text]) => text)).toEqual(['ns:k']);
    } finally {
      encode.mockRestore();
      manager.dispose();
    }
  });

  /** Reads the tenant_id component (component 1) back out of a built AAD buffer. */
  function decodeAadTenantId(aad: Uint8Array): string {
    const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);
    const len = view.getUint32(1, false);
    return new TextDecoder().decode(aad.slice(5, 5 + len));
  }

  it('HKDF derivation and AAD construction resolve the identical tenant_id', async () => {
    // Regression for the mismatch: manager-core.ts used `tenantId ?? 'default'`
    // for HKDF but `tenantId ?? ''` for AAD, so an unset tenant derived keys
    // for "default" while binding AAD to "" — ciphertext could never
    // authenticate against a conformant reader.
    const { bindings } = mockBindings();
    const manager = new TestManager(async () => bindings);

    await manager.encrypt(new Uint8Array([1]), 'ns:k');

    const [, derivedTenantId] = vi.mocked(bindings.deriveTenantKeys).mock.calls[0];
    const [, aad] = vi.mocked(bindings.encryptWithTenantKeys).mock.calls[0];
    expect(derivedTenantId).toBe('default');
    expect(decodeAadTenantId(aad)).toBe('default');
    manager.dispose();
  });

  it('with a configured tenantId, HKDF and AAD both use it', async () => {
    const { bindings } = mockBindings();
    const manager = new TestManager(async () => bindings, 'acme-corp');

    await manager.encrypt(new Uint8Array([1]), 'ns:k');

    const [, derivedTenantId] = vi.mocked(bindings.deriveTenantKeys).mock.calls[0];
    const [, aad] = vi.mocked(bindings.encryptWithTenantKeys).mock.calls[0];
    expect(derivedTenantId).toBe('acme-corp');
    expect(decodeAadTenantId(aad)).toBe('acme-corp');
    manager.dispose();
  });

  it.each([null, 42, {}])(
    'rejects a tenantId that is set but not a string (%j) at construction',
    (tenantId) => {
      const { bindings } = mockBindings();
      const build = () => new TestManager(async () => bindings, tenantId as never);

      expect(build).toThrow(ConfigurationError);
      expect(build).toThrow(/tenantId must be a string/);
    }
  );

  it('rejects an empty tenantId at construction', () => {
    const { bindings } = mockBindings();
    const build = () => new TestManager(async () => bindings, '');

    expect(build).toThrow(ConfigurationError);
    expect(build).toThrow(/tenantId must not be empty/);
  });
});

describe('EncryptionManagerCore keyring config (previousMasterKeys)', () => {
  const K2_HEX = 'cd'.repeat(32);

  function makeManager(previousMasterKeys?: readonly string[]) {
    const mocks = mockBindings();
    const manager = new EncryptionManagerCore(
      MASTER_KEY_HEX,
      undefined,
      async () => mocks.bindings,
      previousMasterKeys
    );
    return { manager, ...mocks };
  }

  it('rejects more than 3 previous keys at load — never truncates', () => {
    const four = ['11', '22', '33', '44'].map((b) => b.repeat(32));
    expect(() => makeManager(four)).toThrow(ConfigurationError);
    expect(() => makeManager(four)).toThrow(/at most 3 keys, got 4/);
  });

  it('accepts exactly 3 previous keys', () => {
    const three = ['11', '22', '33'].map((b) => b.repeat(32));
    expect(() => makeManager(three)).not.toThrow();
  });

  it('rejects masterKey appearing in previousMasterKeys (forward-only rule)', () => {
    expect(() => makeManager([MASTER_KEY_HEX])).toThrow(ConfigurationError);
    expect(() => makeManager([K2_HEX, MASTER_KEY_HEX])).toThrow(/forward-only/);
  });

  it('rejects masterKey collision case-insensitively — hex case is not key identity', () => {
    expect(() => makeManager([MASTER_KEY_HEX.toUpperCase()])).toThrow(ConfigurationError);
  });

  it('validates previous keys with rules identical to masterKey', () => {
    expect(() => makeManager(['zz'.repeat(32)])).toThrow(/hex-encoded/);
    expect(() => makeManager(['ab'.repeat(16)])).toThrow(/exactly 32 bytes/);
    expect(() => makeManager([''])).toThrow(ConfigurationError);
  });

  it('hands decoded previous-key bytes to the bindings exactly once, then wipes them', async () => {
    const { manager, bindings } = makeManager([K2_HEX]);
    // Snapshot at call time — the manager zeroizes its staging buffers as
    // soon as the binding has consumed them, so the retained mock.calls
    // reference reads zeros afterwards.
    const original = vi.mocked(bindings.deriveTenantKeys).getMockImplementation()!;
    const seenAtCallTime: number[][] = [];
    vi.mocked(bindings.deriveTenantKeys).mockImplementation((masterKey, tenantId, previous) => {
      for (const bytes of previous ?? []) seenAtCallTime.push(Array.from(bytes.slice(0, 2)));
      return original(masterKey, tenantId, previous);
    });
    await manager.encrypt(new Uint8Array([1]), 'ns:k');

    expect(bindings.deriveTenantKeys).toHaveBeenCalledTimes(1);
    const [, , previous] = vi.mocked(bindings.deriveTenantKeys).mock.calls[0];
    expect(previous![0]).toBeInstanceOf(Uint8Array);
    expect(seenAtCallTime).toEqual([[0xcd, 0xcd]]);
    // Staging buffers hold plaintext key bytes — wiped once the keyring is built.
    expect(Array.from(previous![0].slice(0, 2))).toEqual([0, 0]);
    manager.dispose();
  });

  it('omits the keyring argument entirely when no previous keys are configured', async () => {
    const { manager, bindings } = makeManager();
    await manager.encrypt(new Uint8Array([1]), 'ns:k');

    const [, , previous] = vi.mocked(bindings.deriveTenantKeys).mock.calls[0];
    expect(previous).toBeUndefined();
    manager.dispose();
  });

  it('rejects duplicate previousMasterKeys entries (case-insensitive)', () => {
    expect(() => makeManager([K2_HEX, K2_HEX])).toThrow(ConfigurationError);
    expect(() => makeManager([K2_HEX, K2_HEX.toUpperCase()])).toThrow(/duplicates/);
  });

  it('refuses to init when a version-skewed binding drops the keyring (no attestation method)', async () => {
    // An older native binary predates keyringEntryCount AND silently ignores
    // the third deriveTenantKeys argument — absence of the method must fail
    // loud instead of silently decrypting with the current key only.
    const { bindings, freed } = mockBindings();
    vi.mocked(bindings.deriveTenantKeys).mockImplementation(
      (_masterKey: Uint8Array, tenantId: string) => {
        const keys: EncryptionTenantKeys = {
          tenantId,
          encryptionFingerprint: () => new Uint8Array(16),
          getNonceCounter: () => 0,
          // no keyringEntryCount — pre-keyring binding
          free() {
            freed.push(keys);
          },
        };
        return keys;
      }
    );
    const manager = new EncryptionManagerCore(MASTER_KEY_HEX, undefined, async () => bindings, [
      K2_HEX,
    ]);

    await expect(manager.encrypt(new Uint8Array([1]), 'ns:k')).rejects.toThrow(
      /version skew|keyring/
    );
    // The orphaned handle must be zeroized, not parked
    expect(freed.length).toBe(1);
    manager.dispose();
  });

  it('refuses to init when the binding reports a wrong keyring entry count', async () => {
    const { bindings, freed } = mockBindings();
    // Reuse the factory mock but drop the previous-keys argument — the handle
    // then reports keyringEntryCount() === 1 despite the keyring config.
    const original = vi.mocked(bindings.deriveTenantKeys).getMockImplementation()!;
    vi.mocked(bindings.deriveTenantKeys).mockImplementation((masterKey, tenantId) =>
      original(masterKey, tenantId)
    );
    const manager = new EncryptionManagerCore(MASTER_KEY_HEX, undefined, async () => bindings, [
      K2_HEX,
    ]);

    await expect(manager.decrypt(new Uint8Array(28), 'ns:k')).rejects.toThrow(/version skew/);
    // The orphaned handle must be zeroized, not parked
    expect(freed.length).toBe(1);
    manager.dispose();
  });

  it('reports hardware acceleration from the binding, initialising on demand', async () => {
    const { bindings, derived } = mockBindings();
    const manager = new TestManager(async () => bindings);

    // Answers at startup, before any encrypt — and derives exactly once.
    expect(await manager.isHardwareAccelerated()).toBe(true);
    expect(derived.length).toBe(1);
    manager.dispose();
  });

  it('reports null (unknown), not false, when the binding predates the accessor', async () => {
    const { bindings } = mockBindings();
    vi.mocked(bindings.deriveTenantKeys).mockImplementation(
      (_masterKey: Uint8Array, tenantId: string) => ({
        tenantId,
        encryptionFingerprint: () => new Uint8Array(16),
        getNonceCounter: () => 0,
        // no hardwareAccelerationEnabled — older binding
      })
    );
    const manager = new TestManager(async () => bindings);

    expect(await manager.isHardwareAccelerated()).toBeNull();
    manager.dispose();
  });

  it('rejects with EncryptionError, not TypeError, when dispose races an initialised read', async () => {
    const { bindings } = mockBindings();
    const manager = new TestManager(async () => bindings);

    // Initialise first, so ensureInitialized() takes its early-return path and
    // the read below resumes only after dispose() has nulled tenantKeys.
    expect(await manager.isHardwareAccelerated()).toBe(true);

    const inFlight = manager.isHardwareAccelerated();
    manager.dispose();

    await expect(inFlight).rejects.toThrow(EncryptionError);
  });
});

// The Workers bindings are asynchronous (WebCrypto); the seam accepts a
// Promise from every method and must classify its rejection exactly as it
// classifies a synchronous throw.
describe('EncryptionManagerCore over asynchronous bindings', () => {
  it('maps a rejected encrypt to NonceExhaustedError on exhaustion, EncryptionError otherwise', async () => {
    const exhausted = mockBindings({
      encryptWithTenantKeys: vi.fn(() =>
        Promise.reject(new Error('Nonce counter exhausted - key rotation required'))
      ),
    });
    const other = mockBindings({
      encryptWithTenantKeys: vi.fn(() => Promise.reject(new Error('boom'))),
    });
    const a = new TestManager(async () => exhausted.bindings);
    const b = new TestManager(async () => other.bindings);

    const error = await a.encrypt(new Uint8Array([1]), 'ns:k').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonceExhaustedError);
    expect((error as Error & { cause?: Error }).cause?.message).toContain(
      'Nonce counter exhausted'
    );
    const otherError = await b.encrypt(new Uint8Array([1]), 'ns:k').catch((e: unknown) => e);
    expect(otherError).toBeInstanceOf(EncryptionError);
    expect(otherError).not.toBeInstanceOf(NonceExhaustedError);
    a.dispose();
    b.dispose();
  });

  it('maps a rejected decrypt to EncryptionError', async () => {
    const { bindings } = mockBindings({
      decryptWithTenantKeys: vi.fn(() =>
        Promise.reject(new Error('Authentication verification failed'))
      ),
    });
    const manager = new TestManager(async () => bindings);

    await expect(manager.decrypt(new Uint8Array(28), 'ns:k')).rejects.toThrow(EncryptionError);
    manager.dispose();
  });

  it('returns the value an asynchronous encrypt and decrypt resolve to', async () => {
    const { bindings } = mockBindings({
      encryptWithTenantKeys: vi.fn(async () => new Uint8Array([7])),
      decryptWithTenantKeys: vi.fn(async () => new Uint8Array([8])),
    });
    const manager = new TestManager(async () => bindings);

    expect(await manager.encrypt(new Uint8Array([1]), 'ns:k')).toEqual(new Uint8Array([7]));
    expect(await manager.decrypt(new Uint8Array([1]), 'ns:k')).toEqual(new Uint8Array([8]));
    manager.dispose();
  });

  it('zero-fills the master-key bytes only after an asynchronous derive settles, on success and on rejection', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const { bindings } = mockBindings();
      const original = vi.mocked(bindings.deriveTenantKeys).getMockImplementation()!;
      let seen: Uint8Array | undefined;
      let settle!: () => void;
      vi.mocked(bindings.deriveTenantKeys).mockImplementation((masterKey, tenantId, previous) => {
        seen = masterKey;
        return new Promise<EncryptionTenantKeys>((resolve, reject) => {
          settle = () =>
            outcome === 'resolve'
              ? resolve(original(masterKey, tenantId, previous) as EncryptionTenantKeys)
              : reject(new Error('importKey failed'));
        });
      });
      const manager = new TestManager(async () => bindings);

      const pending = manager.encrypt(new Uint8Array([1]), 'ns:k');
      await vi.waitFor(() => expect(seen).toBeDefined());
      // Still pending: the bytes must be intact for the binding.
      expect(Array.from(seen!.slice(0, 2))).toEqual([0xab, 0xab]);
      settle();
      if (outcome === 'resolve') await pending;
      else await expect(pending).rejects.toThrow(EncryptionError);
      expect(seen!.every((b) => b === 0)).toBe(true);
      manager.dispose();
    }
  });
});

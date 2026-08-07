/**
 * EncryptionManagerCore contract tests over mock bindings — the logic here
 * is shared verbatim by the Node (NAPI) and Workers (wasm) entrypoints.
 * Covers the LAB-595 panel findings: single-derive under concurrent first
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

  it('hands decoded previous-key bytes to the bindings exactly once', async () => {
    const { manager, bindings } = makeManager([K2_HEX]);
    await manager.encrypt(new Uint8Array([1]), 'ns:k');

    expect(bindings.deriveTenantKeys).toHaveBeenCalledTimes(1);
    const [, , previous] = vi.mocked(bindings.deriveTenantKeys).mock.calls[0];
    expect(previous).toHaveLength(1);
    expect(previous![0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(previous![0].slice(0, 2))).toEqual([0xcd, 0xcd]);
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
    const { bindings } = mockBindings();
    vi.mocked(bindings.deriveTenantKeys).mockImplementation(
      (_masterKey: Uint8Array, tenantId: string) => ({
        tenantId,
        encryptionFingerprint: () => new Uint8Array(16),
        getNonceCounter: () => 0,
        keyringEntryCount: () => 1, // built no keyring despite the argument
      })
    );
    const manager = new EncryptionManagerCore(MASTER_KEY_HEX, undefined, async () => bindings, [
      K2_HEX,
    ]);

    await expect(manager.decrypt(new Uint8Array(28), 'ns:k')).rejects.toThrow(/version skew/);
    manager.dispose();
  });
});

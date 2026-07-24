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
import { EncryptionError, NonceExhaustedError } from '../errors.js';

const MASTER_KEY_HEX = 'ab'.repeat(32);

function mockBindings(overrides?: Partial<EncryptionBindings>) {
  const freed: EncryptionTenantKeys[] = [];
  const derived: EncryptionTenantKeys[] = [];
  const bindings: EncryptionBindings = {
    deriveTenantKeys: vi.fn((_masterKey: Uint8Array, tenantId: string) => {
      const keys: EncryptionTenantKeys = {
        tenantId,
        encryptionFingerprint: () => new Uint8Array(16),
        getNonceCounter: () => 0,
        free() {
          freed.push(keys);
        },
      };
      derived.push(keys);
      return keys;
    }),
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

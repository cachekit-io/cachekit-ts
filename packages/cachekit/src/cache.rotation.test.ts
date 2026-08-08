/**
 * End-to-end master-key rotation round-trip (LAB-685).
 *
 * Exercises the full operator flow from protocol decisions/key-rotation.md:
 * a value written under k₁ stays readable after k₂ is promoted to masterKey
 * with k₁ in previousMasterKeys — without re-encryption — and dropping k₁
 * makes the entry fail per the configured reliability policy (miss under
 * degradation, EncryptionError without it).
 */

import { describe, it, expect, vi } from 'vitest';
import { createCache } from './cache.js';
import { EncryptionError } from './errors.js';
import type { Backend } from './backends/types.js';

/**
 * Deterministic test fixture, not a secret: a single byte repeated to the
 * 32-byte master-key length. Real key material is never a repeated byte.
 */
const testMasterKeyHex = (byte: string): string => byte.repeat(32);

const K1_HEX = testMasterKeyHex('11');
const K2_HEX = testMasterKeyHex('22');

/**
 * In-memory backend shared across cache instances. close() is deliberately
 * a no-op: several caches share one store here, and the first cache.close()
 * must not wipe the entries the next cache is about to read.
 */
class SharedBackend implements Backend {
  private store = new Map<string, Uint8Array>();

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
    // no-op: shared across cache instances
  }

  snapshot(key: string): Uint8Array | undefined {
    return this.store.get(key);
  }
}

describe('E2E key rotation round-trip', () => {
  it('reads a k1 entry through the k2+[k1] keyring without re-encryption, then fails once k1 is dropped', async () => {
    const backend = new SharedBackend();
    const setSpy = vi.spyOn(backend, 'set');
    const key = 'rotate:entry';
    const value = { user: 'ada', roles: ['admin'] };

    // Phase 0: write under k1.
    const before = createCache({
      backend,
      encryption: { masterKey: K1_HEX },
      l1: { enabled: false },
    });
    await before.set(key, value);
    await before.close();

    const storedUnderK1 = backend.snapshot(key)!;
    expect(setSpy).toHaveBeenCalledTimes(1);

    // Phase 1: rotation grace window — k2 current, k1 decrypt-only.
    const during = createCache({
      backend,
      encryption: { masterKey: K2_HEX, previousMasterKeys: [K1_HEX] },
      l1: { enabled: false },
    });
    await expect(during.get(key)).resolves.toEqual(value);
    await during.close();

    // No re-encryption on read: the backend saw no further write and the
    // stored bytes are untouched (old entries age out via TTL by design).
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(backend.snapshot(key)).toBe(storedUnderK1);

    // Phase 2: k1 dropped — degradation (default) turns the decrypt
    // failure into a miss.
    const after = createCache({
      backend,
      encryption: { masterKey: K2_HEX },
      l1: { enabled: false },
    });
    await expect(after.get(key)).resolves.toBeNull();
    await after.close();

    // Same drop, fail-closed policy: the decrypt failure surfaces.
    const afterStrict = createCache({
      backend,
      encryption: { masterKey: K2_HEX },
      l1: { enabled: false },
      reliability: { degradation: false, retry: { maxAttempts: 1 } },
    });
    await expect(afterStrict.get(key)).rejects.toThrow(EncryptionError);
    await afterStrict.close();
  });

  it('serves a previous-key entry from L1 during the grace window', async () => {
    // L1 holds ciphertext for a secure cache (LAB-238), so an L2 read under a
    // previous key repopulates L1 with bytes the CURRENT key cannot open —
    // every subsequent hit has to run the keyring loop again. If it did not,
    // decodeL1Entry would drop the entry and fall through to L2 on every read
    // for the whole grace window: a silent L1 bypass under degradation, and a
    // throw on every old-key read without it.
    const backend = new SharedBackend();
    const key = 'rotate:l1-entry';
    const value = { user: 'grace', roles: ['reader'] };

    const before = createCache({
      backend,
      encryption: { masterKey: K1_HEX },
      l1: { enabled: false },
    });
    await before.set(key, value);
    await before.close();

    const during = createCache({
      backend,
      encryption: { masterKey: K2_HEX, previousMasterKeys: [K1_HEX] },
      l1: { enabled: true },
    });
    const getSpy = vi.spyOn(backend, 'get');

    // First read comes from L2 and seeds L1 with the k1 ciphertext.
    await expect(during.get(key)).resolves.toEqual(value);
    expect(getSpy).toHaveBeenCalledTimes(1);

    // Second read is served from L1 — decrypted through the keyring, so the
    // backend is never consulted again.
    await expect(during.get(key)).resolves.toEqual(value);
    expect(getSpy).toHaveBeenCalledTimes(1);

    await during.close();
  });

  it('keeps new writes on the current key during the grace window', async () => {
    const backend = new SharedBackend();
    const key = 'rotate:new-write';

    const during = createCache({
      backend,
      encryption: { masterKey: K2_HEX, previousMasterKeys: [K1_HEX] },
      l1: { enabled: false },
    });
    await during.set(key, 'fresh');
    await during.close();

    // Readable with k2 alone — proof the write used the current key, not k1.
    const cutOver = createCache({
      backend,
      encryption: { masterKey: K2_HEX },
      l1: { enabled: false },
    });
    await expect(cutOver.get(key)).resolves.toBe('fresh');
    await cutOver.close();
  });
});

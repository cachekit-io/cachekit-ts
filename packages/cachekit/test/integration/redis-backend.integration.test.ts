import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { redis } from '../../src/backends/redis.js';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { execSync } from 'node:child_process';

// Skip if Docker is not available or on Windows (Testcontainers volume mount issues)
let dockerAvailable = false;
try {
  if (process.platform !== 'win32') {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    dockerAvailable = true;
  }
} catch {
  dockerAvailable = false;
}

/**
 * Redis Integration Tests using Testcontainers
 *
 * These tests spin up a real Redis instance in Docker, similar to pytest-redis.
 * Requires Docker to be running.
 */
describe.skipIf(!dockerAvailable)('RedisBackend Integration (Testcontainers)', () => {
  let container: StartedRedisContainer;
  let client: Redis;
  let backend: ReturnType<typeof redis>;
  const testPrefix = `test:${Date.now()}:`;

  beforeAll(async () => {
    // Start Redis container (takes ~2-5 seconds)
    container = await new RedisContainer('redis:7-alpine').start();
    const redisUrl = container.getConnectionUrl();

    client = new Redis(redisUrl);
    backend = redis({ url: redisUrl, keyPrefix: testPrefix });
  }, 60000); // 60s timeout for container startup

  afterAll(async () => {
    // Cleanup
    await client?.quit();
    await backend?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    // Clear test keys before each test
    const keys = await client.keys(`${testPrefix}*`);
    if (keys.length > 0) {
      await client.del(...keys);
    }
  });

  it('set and get round-trip', async () => {
    const value = new Uint8Array([1, 2, 3, 4, 5]);
    await backend.set('test-key', value, 60);

    const result = await backend.get('test-key');
    expect(result).toEqual(value);
  });

  it('exposes the configured keyPrefix (interop fail-closed contract)', () => {
    // The Backend interface requires key-transforming backends to expose the
    // transform so wrap({ interop }) can refuse a prefixed client — a hidden
    // prefix would silently diverge interop keys from the other SDKs.
    expect(backend.keyPrefix).toBe(testPrefix);
  });

  it('get returns null for missing key', async () => {
    const result = await backend.get('nonexistent');
    expect(result).toBeNull();
  });

  it('delete removes key', async () => {
    await backend.set('to-delete', new Uint8Array([1]), 60);
    expect(await backend.exists('to-delete')).toBe(true);

    const deleted = await backend.delete('to-delete');
    expect(deleted).toBe(true);
    expect(await backend.exists('to-delete')).toBe(false);
  });

  it('delete returns false for missing key', async () => {
    const deleted = await backend.delete('never-existed');
    expect(deleted).toBe(false);
  });

  it('respects TTL', async () => {
    await backend.set('short-ttl', new Uint8Array([1]), 1);
    expect(await backend.get('short-ttl')).not.toBeNull();

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 1100));
    expect(await backend.get('short-ttl')).toBeNull();
  });

  it('handles large values', async () => {
    // 1MB of data
    const largeValue = new Uint8Array(1024 * 1024);
    for (let i = 0; i < largeValue.length; i++) {
      largeValue[i] = i % 256;
    }

    await backend.set('large-key', largeValue, 60);
    const result = await backend.get('large-key');

    expect(result).toEqual(largeValue);
  });

  it('handles concurrent operations', async () => {
    const ops = Array.from({ length: 100 }, (_, i) =>
      backend.set(`concurrent-${i}`, new Uint8Array([i % 256]), 60)
    );

    await Promise.all(ops);

    // Verify all keys exist
    for (let i = 0; i < 100; i++) {
      const result = await backend.get(`concurrent-${i}`);
      expect(result).toEqual(new Uint8Array([i % 256]));
    }
  });

  describe('getWithTtl (LAB-1388)', () => {
    it('returns the value and remaining TTL in one round trip', async () => {
      await backend.set('gwt-key', new Uint8Array([7, 8]), 60);
      const result = await backend.getWithTtl('gwt-key');
      expect(result).not.toBeNull();
      expect(result!.value).toEqual(new Uint8Array([7, 8]));
      expect(result!.ttlSeconds).toBeGreaterThan(0);
      expect(result!.ttlSeconds).toBeLessThanOrEqual(60);
    });

    it('returns null for a missing key', async () => {
      expect(await backend.getWithTtl('gwt-missing')).toBeNull();
    });

    it('returns null TTL for a key without expiry', async () => {
      await client.set(`${testPrefix}gwt-persistent`, 'v');
      const result = await backend.getWithTtl('gwt-persistent');
      expect(result).not.toBeNull();
      expect(result!.ttlSeconds).toBeNull();
    });

    it('respects the keyPrefix (pipeline commands are prefixed like get/set)', async () => {
      await backend.set('gwt-prefixed', new Uint8Array([9]), 60);
      // The raw client sees the prefixed key; getWithTtl reads it back
      // through the same prefixing.
      expect(await client.exists(`${testPrefix}gwt-prefixed`)).toBe(1);
      const result = await backend.getWithTtl('gwt-prefixed');
      expect(result!.value).toEqual(new Uint8Array([9]));
    });
  });

  describe('TTLBackend', () => {
    it('getTTL returns remaining seconds for a key with expiry', async () => {
      await backend.set('ttl-key', new Uint8Array([1]), 60);
      const ttl = await backend.getTTL('ttl-key');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    });

    it('getTTL returns null for a missing key', async () => {
      expect(await backend.getTTL('no-such-key')).toBeNull();
    });

    it('getTTL returns null for a key without expiry (py parity: -1 collapses to null)', async () => {
      await client.set(`${testPrefix}persistent-key`, 'v');
      expect(await backend.getTTL('persistent-key')).toBeNull();
    });

    it('refreshTTL resets the TTL and returns true', async () => {
      await backend.set('refresh-key', new Uint8Array([1]), 30);
      expect(await backend.refreshTTL('refresh-key', 120)).toBe(true);
      const ttl = await backend.getTTL('refresh-key');
      expect(ttl).toBeGreaterThan(30);
      expect(ttl).toBeLessThanOrEqual(120);
    });

    it('refreshTTL returns false for a missing key', async () => {
      expect(await backend.refreshTTL('no-such-key', 60)).toBe(false);
    });

    it('refreshTTL rejects ttl <= 0 instead of deleting the key (EXPIRE 0 deletes)', async () => {
      await backend.set('guard-key', new Uint8Array([1]), 60);
      await expect(backend.refreshTTL('guard-key', 0)).rejects.toThrow(/ttl >= 1/);
      // The data survived the rejected call.
      expect(await backend.get('guard-key')).toEqual(new Uint8Array([1]));
    });

    it('refreshTTL floors fractional ttl to whole seconds', async () => {
      await backend.set('frac-key', new Uint8Array([1]), 30);
      expect(await backend.refreshTTL('frac-key', 90.9)).toBe(true);
      const ttl = await backend.getTTL('frac-key');
      expect(ttl).toBeGreaterThan(30);
      expect(ttl).toBeLessThanOrEqual(90);
    });
  });

  describe('LockableBackend', () => {
    it('acquireLock returns a lockId and holds the lease for timeoutMs', async () => {
      const lockId = await backend.acquireLock('lock-key', 5000);
      expect(lockId).toBeTruthy();

      // The lease lives under the derived lock key with a PX expiry.
      const pttl = await client.pttl(`${testPrefix}lock-key:lock`);
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(5000);
    });

    it('acquireLock returns null when contested (never blocks, never throws — LAB-240 shape)', async () => {
      const first = await backend.acquireLock('contested-key', 5000);
      expect(first).toBeTruthy();

      const second = await backend.acquireLock('contested-key', 5000);
      expect(second).toBeNull();

      // The original holder's lease is untouched by the failed attempt.
      expect(await client.get(`${testPrefix}contested-key:lock`)).toBe(first);
    });

    it('releaseLock with the holder lockId frees the lock and returns true', async () => {
      const lockId = await backend.acquireLock('release-key', 5000);
      expect(await backend.releaseLock('release-key', lockId!)).toBe(true);
      expect(await client.exists(`${testPrefix}release-key:lock`)).toBe(0);

      // Freed lock is immediately acquirable again.
      expect(await backend.acquireLock('release-key', 5000)).toBeTruthy();
    });

    it('releaseLock with a stale lockId returns false and never deletes the current lease', async () => {
      const holder = await backend.acquireLock('cad-key', 5000);
      expect(await backend.releaseLock('cad-key', 'not-the-holder')).toBe(false);
      expect(await client.get(`${testPrefix}cad-key:lock`)).toBe(holder);
    });

    it('acquireLock floors fractional timeoutMs (PX requires an integer) and rejects <= 0', async () => {
      const lockId = await backend.acquireLock('float-key', 5000.7);
      expect(lockId).toBeTruthy();
      expect(await client.pttl(`${testPrefix}float-key:lock`)).toBeLessThanOrEqual(5000);

      await expect(backend.acquireLock('float-key-2', 0)).rejects.toThrow(/timeoutMs >= 1/);
    });

    it('lock auto-expires after timeoutMs (best-effort lease, not a permanent lock)', async () => {
      const lockId = await backend.acquireLock('expiry-key', 100);
      expect(lockId).toBeTruthy();

      await new Promise((r) => setTimeout(r, 250));
      expect(await backend.acquireLock('expiry-key', 5000)).toBeTruthy();
    });

    // Pins the bare-key contract on LockableBackend (types.ts) — the
    // cachekit-py#135 / cachekit-ts#70 regression class.
    describe('bare-key lock contract', () => {
      const canonicalKey = 'ns:app:func:mod.fn:args:' + 'a'.repeat(64) + ':v1';

      it('derives exactly one on-wire `:lock` suffix from the bare canonical key', async () => {
        const lockId = await backend.acquireLock(canonicalKey, 5000);
        expect(lockId).toBeTruthy();

        // Exactly `<prefix><key>:lock` — no double suffix, no other shape.
        expect(await client.get(`${testPrefix}${canonicalKey}:lock`)).toBe(lockId);
        const lockKeys = await client.keys(`${testPrefix}*lock*`);
        expect(lockKeys).toEqual([`${testPrefix}${canonicalKey}:lock`]);
      });

      it('locking never touches the data key, and release leaves zero :lock residue', async () => {
        await backend.set(canonicalKey, new Uint8Array([42]), 60);
        const lockId = await backend.acquireLock(canonicalKey, 5000);

        // Data key untouched by the lock lifecycle.
        expect(await backend.get(canonicalKey)).toEqual(new Uint8Array([42]));

        expect(await backend.releaseLock(canonicalKey, lockId!)).toBe(true);
        expect(await client.keys(`${testPrefix}*:lock`)).toEqual([]);
        expect(await backend.get(canonicalKey)).toEqual(new Uint8Array([42]));
      });

      it('tripwire: the decoded data keyspace never contains `:lock` after normal cache ops', async () => {
        await backend.set('plain-key', new Uint8Array([1]), 60);
        await backend.get('plain-key');
        await backend.exists('plain-key');

        const allKeys = await client.keys(`${testPrefix}*`);
        expect(allKeys.some((k) => k.includes(':lock'))).toBe(false);
      });
    });
  });
});

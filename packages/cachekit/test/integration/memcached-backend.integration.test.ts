import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import { memcached } from '../../src/backends/memcached.js';
import type { MemcachedBackend } from '../../src/backends/memcached.js';

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
 * Memcached Integration Tests using Testcontainers
 *
 * Spins up a real memcached instance in Docker (same pattern as the Redis
 * integration tests). Requires Docker; unit coverage for CI environments
 * without Docker lives in src/backends/memcached.test.ts (documented mock).
 */
describe.skipIf(!dockerAvailable)('MemcachedBackend Integration (Testcontainers)', () => {
  let container: StartedTestContainer;
  let backend: MemcachedBackend;

  beforeAll(async () => {
    container = await new GenericContainer('memcached:1.6-alpine').withExposedPorts(11211).start();
    backend = memcached({
      servers: [`${container.getHost()}:${container.getMappedPort(11211)}`],
      keyPrefix: `test:${Date.now()}:`,
    });
  }, 60000); // 60s timeout for container startup

  afterAll(async () => {
    await backend?.close();
    await container?.stop();
  });

  it('set and get round-trip', async () => {
    const value = new Uint8Array([1, 2, 3, 4, 5]);
    await backend.set('round-trip', value, 60);
    expect(await backend.get('round-trip')).toEqual(value);
  });

  it('binary payloads survive intact', async () => {
    const value = new Uint8Array(256).map((_, i) => i);
    await backend.set('binary', value, 60);
    expect(await backend.get('binary')).toEqual(value);
  });

  it('get returns null for missing key', async () => {
    expect(await backend.get('does-not-exist')).toBeNull();
  });

  it('delete removes the key and reports prior existence', async () => {
    await backend.set('to-delete', new Uint8Array([1]), 60);
    expect(await backend.delete('to-delete')).toBe(true);
    expect(await backend.delete('to-delete')).toBe(false);
    expect(await backend.get('to-delete')).toBeNull();
  });

  it('exists reflects presence', async () => {
    expect(await backend.exists('exists-check')).toBe(false);
    await backend.set('exists-check', new Uint8Array([1]), 60);
    expect(await backend.exists('exists-check')).toBe(true);
  });

  it('TTL expires entries', async () => {
    await backend.set('short-lived', new Uint8Array([1]), 1);
    expect(await backend.exists('short-lived')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(await backend.get('short-lived')).toBeNull();
  }, 10000);

  it('refreshTTL extends a dying key', async () => {
    await backend.set('refresh-me', new Uint8Array([1]), 1);
    expect(await backend.refreshTTL('refresh-me', 60)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(await backend.get('refresh-me')).toEqual(new Uint8Array([1])); // survived original TTL
  }, 10000);

  it('refreshTTL returns false for a missing key', async () => {
    expect(await backend.refreshTTL('never-existed', 60)).toBe(false);
  });

  it('oversized values are rejected client-side', async () => {
    // memcached default -I is 1 MiB; cachekit guards before sending
    const big = new Uint8Array(1024 * 1024 + 1);
    await expect(backend.set('too-big', big)).rejects.toThrow(/max\s+item size/);
  });
});

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
  }, 60000);  // 60s timeout for container startup

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
});

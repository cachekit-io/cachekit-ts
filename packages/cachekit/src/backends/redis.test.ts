import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The Redis backend loads ioredis when it is constructed, not when this
 * module is imported. These tests pin that lifecycle against a mocked
 * ioredis; the integration suite runs the real client against a real Redis.
 */

class FakeClient {
  static instances: FakeClient[] = [];
  readonly on = vi.fn();
  readonly getBuffer = vi.fn(async () => Buffer.from([7]));
  readonly quit = vi.fn(async () => 'OK');
  constructor(
    readonly url: string,
    readonly options: Record<string, unknown>
  ) {
    FakeClient.instances.push(this);
  }
}

/** Fresh redis.js (and the error and logger modules it uses) over a mocked ioredis. */
async function loadBackend(ioredisFactory: () => object | Promise<object>) {
  vi.resetModules();
  vi.doMock('ioredis', ioredisFactory);
  const { redis } = await import('./redis.js');
  const { ConfigurationError } = await import('../errors.js');
  const { setLogger } = await import('../logger.js');
  const logs: string[] = [];
  setLogger((message) => logs.push(message));
  return { redis, ConfigurationError, logs };
}

const failingIoredis = () => {
  throw new Error("Cannot find package 'ioredis'");
};

afterEach(() => {
  vi.doUnmock('ioredis');
  FakeClient.instances = [];
});

describe('RedisBackend ioredis lifecycle', () => {
  it('creates the client on construction, before any command', async () => {
    const { redis } = await loadBackend(() => ({ Redis: FakeClient }));
    const backend = redis({ url: 'redis://localhost:6379', keyPrefix: 'app:' });

    await vi.waitFor(() => expect(FakeClient.instances).toHaveLength(1));
    const [client] = FakeClient.instances;
    expect(client.url).toBe('redis://localhost:6379');
    expect(client.options).toMatchObject({ keyPrefix: 'app:', lazyConnect: false });
    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));

    expect(await backend.get('k')).toEqual(new Uint8Array([7]));
    await backend.close();
    expect(client.quit).toHaveBeenCalledTimes(1);
  });

  it('close() before ioredis has loaded never opens a connection', async () => {
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => (release = resolve));
    const { redis } = await loadBackend(async () => {
      await loaded;
      return { Redis: FakeClient };
    });
    const backend = redis({ url: 'redis://localhost:6379' });

    const closing = backend.close();
    release();
    await closing;

    expect(FakeClient.instances).toHaveLength(0);
    await expect(backend.get('k')).rejects.toThrow('Redis backend is closed');
  });

  it('a failed load rejects every command with a ConfigurationError, reported once', async () => {
    const { redis, ConfigurationError, logs } = await loadBackend(failingIoredis);
    const backend = redis({ url: 'redis://localhost:6379' });

    await expect(backend.get('k')).rejects.toBeInstanceOf(ConfigurationError);
    await expect(backend.set('k', new Uint8Array([1]), 60)).rejects.toThrow(
      /^The Redis backend could not load ioredis: /
    );
    await expect(backend.acquireLock('k')).rejects.toBeInstanceOf(ConfigurationError);
    expect(logs.filter((m) => m.includes('could not load ioredis'))).toHaveLength(1);
    await expect(backend.close()).resolves.toBeUndefined();
  });

  it('an unused backend whose load fails raises no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { redis, logs } = await loadBackend(failingIoredis);
      redis({ url: 'redis://localhost:6379' });

      await vi.waitFor(() => expect(logs).toHaveLength(1));
      // Node reports unhandled rejections once the microtask queue drains.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

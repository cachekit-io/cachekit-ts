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

  it('a client ioredis cannot build rejects every command with a ConfigurationError, reported once', async () => {
    const { redis, ConfigurationError, logs } = await loadBackend(() => ({
      Redis: class {
        constructor() {
          throw new TypeError('Invalid URL');
        }
      },
    }));
    const backend = redis({ url: 'redis://localhost:6379' });

    await expect(backend.get('k')).rejects.toBeInstanceOf(ConfigurationError);
    await expect(backend.exists('k')).rejects.toThrow(
      /^The Redis backend could not create its ioredis client: Invalid URL$/
    );
    expect(logs.filter((m) => m.includes('could not create its ioredis client'))).toHaveLength(1);
    await expect(backend.close()).resolves.toBeUndefined();
  });
});

describe('RedisBackend url check', () => {
  // Inputs ioredis 5 parses differently: a port, a socket path, no scheme, a
  // protocol-relative url, an over-large "port" it parses as a host, and bad
  // urls (a space, a non-numeric port, broken percent-encoding of a password).
  const URLS = [
    'redis://localhost:6379',
    'redis://user:pw@localhost:6379/2', // pragma: allowlist secret
    'rediss://cache.example.com',
    'redis://[::1]:6379',
    '6379',
    '/tmp/redis.sock',
    '/tmp/redis.sock?db=2',
    '127.0.0.1:6379',
    'localhost',
    '//cache.example.com:6379',
    '10000000000',
    'not a url',
    'redis://cache.example.com:abc',
    'redis://:p%ZZ@cache.example.com:6379',
    'redis://user:s3cret@cache.example.com:abc', // pragma: allowlist secret
  ];

  it.each(URLS)('redis(%j) throws exactly when ioredis rejects the url', async (url) => {
    const { Redis: RealRedis } = await vi.importActual<typeof import('ioredis')>('ioredis');
    let ioredisRejects = false;
    try {
      new RealRedis(url, { lazyConnect: true }).disconnect();
    } catch {
      ioredisRejects = true;
    }
    const { redis, ConfigurationError } = await loadBackend(() => ({ Redis: FakeClient }));

    if (ioredisRejects) {
      expect(() => redis({ url })).toThrow(ConfigurationError);
    } else {
      await redis({ url }).close();
    }
  });

  it('a bad url fails at redis() without echoing the url or its password', async () => {
    const { redis } = await loadBackend(() => ({ Redis: FakeClient }));
    let error: unknown;
    try {
      redis({ url: 'redis://user:s3cret@cache.example.com:abc' }); // pragma: allowlist secret
    } catch (caught) {
      error = caught;
    }

    expect((error as Error).message).toBe("The Redis backend's url is not valid: Invalid URL");
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('s3cret');
    expect((error as Error).cause).toBeUndefined();
    expect(FakeClient.instances).toHaveLength(0);
  });
});

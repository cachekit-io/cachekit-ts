/**
 * The telemetry switch and the L1 hit-latency report on the CachekitIO
 * backend (protocol spec/saas-api.md § Optional Metrics Headers). Each test
 * names the requirement it pins.
 */
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cachekitio,
  cachekitioFull,
  cachekitioWithLocking,
  cachekitioWithTTL,
} from './cachekitio-factory.js';
import { CachekitIOCore } from './cachekitio.js';
import {
  L1_LATENCY_ONE_IN,
  L1LatencyReport,
  _resetTelemetryWarningForTesting,
  resolveTelemetry,
  setTelemetryBindingsReader,
} from './telemetry.js';
import { ConfigurationError } from '../errors.js';
import { setLogger } from '../logger.js';

const API_URL = 'https://api.test.cachekit.io';
const API_KEY = 'ck_test_fake-not-a-secret'; // pragma: allowlist secret
const CONFIG = { apiKey: API_KEY, apiUrl: API_URL, allowCustomHost: true };

const SESSION_AND_COUNTERS = [
  'X-CacheKit-Session-ID',
  'X-CacheKit-Session-Start',
  'X-CacheKit-L1-Hits',
  'X-CacheKit-L2-Hits',
  'X-CacheKit-Misses',
  'X-CacheKit-L1-Hit-Rate',
];
const LATENCY = [
  'X-CacheKit-L1-Latency-Buckets',
  'X-CacheKit-L1-Latency-Sum-Ns',
  'X-CacheKit-L1-Latency-One-In',
];
const OPTIONAL_METRICS = [...SESSION_AND_COUNTERS, ...LATENCY];

const COUNTERS = { l1Hits: 3, l2Hits: 1, misses: 1, l1Enabled: true };

let fetchSpy: ReturnType<typeof vi.fn>;
const nodeFetch = globalThis.fetch;

interface Closable {
  close(): Promise<void>;
}
interface Composable extends Closable {
  compose(interceptor: unknown): Closable;
}
interface Undici {
  Agent: new (options?: object) => Composable;
  RetryAgent: new (agent: Closable, options: object) => Closable;
  Pool: new (origin: string, options: object) => Composable;
  MockAgent: new () => Closable & {
    disableNetConnect(): void;
    get(origin: string): {
      intercept(options: object): { reply(status: number, body: string): void };
    };
  };
  interceptors: { retry(options: object): unknown };
  setGlobalDispatcher(dispatcher: Closable): void;
}
// The npm undici that miniflare (from @cloudflare/vitest-plugin) brings: the
// public API a user installs a global dispatcher with.
const undici = createRequire(
  createRequire(import.meta.resolve('@cloudflare/vitest-plugin')).resolve('miniflare')
)('undici') as Undici;
const RETRY_ONCE = { maxRetries: 1, minTimeout: 1, maxTimeout: 1 };
const DISPATCHER_SLOTS = [
  Symbol.for('undici.globalDispatcher.1'),
  Symbol.for('undici.globalDispatcher.2'),
];

/** Run `body`, then put undici's global dispatcher slots back as they were. */
async function keepingGlobalDispatcher(body: () => Promise<void>): Promise<void> {
  void globalThis.Headers; // loads Node's undici, which sets its global dispatcher
  const saved: unknown[] = DISPATCHER_SLOTS.map((key) => Reflect.get(globalThis, key));
  try {
    await body();
  } finally {
    DISPATCHER_SLOTS.forEach((key, i) => Reflect.set(globalThis, key, saved[i]));
  }
}

/**
 * Answer `statuses` in turn from a real HTTP server, with `dispatcher` as
 * undici's global dispatcher if given, and run `body` with Node's own fetch
 * routed there. Only the destination changes: the backend's options, its
 * dispatcher included, reach fetch unchanged. Returns what each attempt on the
 * wire carried.
 */
async function onTheWire(
  statuses: number[],
  body: () => Promise<void>,
  dispatcher?: Closable
): Promise<{ sumNs?: string; authorization?: string }[]> {
  const seen: { sumNs?: string; authorization?: string }[] = [];
  const server = createServer((request, response) => {
    seen.push({
      sumNs: request.headers['x-cachekit-l1-latency-sum-ns'] as string | undefined,
      authorization: request.headers.authorization,
    });
    response.writeHead(statuses[seen.length - 1] ?? 404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
    nodeFetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init)
  );
  try {
    await keepingGlobalDispatcher(async () => {
      if (dispatcher) undici.setGlobalDispatcher(dispatcher);
      await body();
    });
  } finally {
    await dispatcher?.close();
    server.closeAllConnections();
    server.close();
  }
  return seen;
}

function sentHeaders(call = -1): Record<string, string> {
  const calls = fetchSpy.mock.calls;
  const [, init] = calls[call < 0 ? calls.length + call : call] as [string, RequestInit];
  return init.headers as Record<string, string>;
}

function latencyOf(headers: Record<string, string>) {
  return LATENCY.map((name) => headers[name]);
}

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubEnv('CACHEKIT_TELEMETRY', undefined);
  _resetTelemetryWarningForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setTelemetryBindingsReader(undefined);
  setLogger(null);
});

describe('L1LatencyReport encoding (API-87)', () => {
  it("encodes the spec's worked example: 90, 300, 300 and 40,000 ns at N = 1", () => {
    const report = new L1LatencyReport(1);
    for (const ns of [90, 300, 300, 40_000]) report.record(ns);
    expect(report.take()).toEqual({
      'X-CacheKit-L1-Latency-Buckets': '1,0,2,0,0,0,0,0,0,1,0,0,0,0,0,0',
      'X-CacheKit-L1-Latency-Sum-Ns': '40690',
      'X-CacheKit-L1-Latency-One-In': '1',
    });
  });

  it('puts each bound in its own bucket and the next nanosecond in the next', () => {
    // Bucket i (from 1) holds up to 2^(i+6) ns; bucket 16 up to 60 s.
    const bounds = Array.from({ length: 15 }, (_, i) => 2 ** (i + 7));
    for (const [i, bound] of bounds.entries()) {
      const report = new L1LatencyReport(1);
      report.record(bound);
      report.record(bound + 1);
      const buckets = report.take()!['X-CacheKit-L1-Latency-Buckets'].split(',').map(Number);
      const expected = new Array(16).fill(0);
      expected[i] = 1;
      expected[i + 1] = 1;
      expect(buckets, `bound ${bound}`).toEqual(expected);
    }
  });

  it('counts 0 ns in bucket 1, and 60 s in bucket 16', () => {
    const report = new L1LatencyReport(1);
    report.record(0);
    report.record(60_000_000_000);
    expect(report.take()!['X-CacheKit-L1-Latency-Buckets']).toBe('1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1');
  });

  it('discards a duration over 60 s, counting it nowhere', () => {
    const report = new L1LatencyReport(1);
    report.record(60_000_000_001);
    expect(report.take()).toBeUndefined();
    report.record(7);
    expect(report.take()!['X-CacheKit-L1-Latency-Sum-Ns']).toBe('7');
  });

  it('keeps every value within the grammar: no hit takes the sum past 2^53 - 1', () => {
    const report = new L1LatencyReport(1_000_000);
    for (let i = 0; i < 200_000; i++) report.record(59_999_999_999);
    const headers = report.take()!;
    for (const value of [
      ...headers['X-CacheKit-L1-Latency-Buckets'].split(','),
      headers['X-CacheKit-L1-Latency-Sum-Ns'],
      headers['X-CacheKit-L1-Latency-One-In'],
    ]) {
      expect(value).toMatch(/^(0|[1-9][0-9]{0,15})$/);
      expect(Number(value)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    }
    expect(headers['X-CacheKit-L1-Latency-Buckets'].split(',')).toHaveLength(16);
  });
});

describe('L1LatencyReport take (API-85)', () => {
  it('takes every value and resets in one step', () => {
    const report = new L1LatencyReport(4);
    report.record(500);
    expect(report.take()!['X-CacheKit-L1-Latency-Sum-Ns']).toBe('500');
    expect(report.take()).toBeUndefined();
  });

  it('attaches nothing while the sum is 0, and keeps the 0 ns hits for the next report', () => {
    const report = new L1LatencyReport(1);
    report.record(0);
    expect(report.take()).toBeUndefined();
    report.record(3);
    expect(report.take()).toEqual({
      'X-CacheKit-L1-Latency-Buckets': '2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0',
      'X-CacheKit-L1-Latency-Sum-Ns': '3',
      'X-CacheKit-L1-Latency-One-In': '1',
    });
  });
});

describe('telemetry switch: CACHEKIT_TELEMETRY parsing (API-95)', () => {
  it.each([
    ['false', false],
    ['0', false],
    ['off', false],
    ['no', false],
    [' OFF ', false],
    ['No', false],
    ['true', true],
    ['1', true],
    ['on', true],
    ['yes', true],
    ['  Yes\t', true],
    ['TRUE', true],
    ['', true],
    ['   ', true],
  ])('reads %j as %s', (value, on) => {
    vi.stubEnv('CACHEKIT_TELEMETRY', value);
    expect(resolveTelemetry(undefined)).toBe(on);
  });

  it('reads an unknown value as off and warns once per process', () => {
    const logged: string[] = [];
    setLogger((message) => logged.push(message));
    vi.stubEnv('CACHEKIT_TELEMETRY', 'disabled');
    expect(resolveTelemetry(undefined)).toBe(false);
    expect(resolveTelemetry(true)).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('CACHEKIT_TELEMETRY');
  });

  it('reads a process environment it cannot read as off, warning once (Deno without --allow-env)', () => {
    const logged: string[] = [];
    setLogger((message) => logged.push(message));
    const env = process.env;
    process.env = new Proxy(
      {},
      {
        get() {
          throw new Error('Requires env access to "CACHEKIT_TELEMETRY"');
        },
      }
    );
    try {
      expect(resolveTelemetry(undefined)).toBe(false);
      expect(resolveTelemetry(true)).toBe(false);
    } finally {
      process.env = env;
    }
    expect(logged).toEqual([
      '[cachekit] CACHEKIT_TELEMETRY could not be read ' +
        '(Requires env access to "CACHEKIT_TELEMETRY"): telemetry is off',
    ]);
  });

  it('reads bindings it cannot see as off, warning once (disallow_importable_env)', async () => {
    const logged: string[] = [];
    setLogger((message) => logged.push(message));
    setTelemetryBindingsReader(() => {
      throw new Error("disallow_importable_env hides the Worker's bindings");
    });
    const backend = cachekitio({ ...CONFIG, telemetry: true, metricsProvider: () => COUNTERS });
    expect(resolveTelemetry(undefined)).toBe(false);
    await backend.get('ns:key');
    for (const name of OPTIONAL_METRICS) expect(sentHeaders()[name], name).toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('disallow_importable_env');
  });

  it('refuses a telemetry setting that is not a boolean', () => {
    expect(() => resolveTelemetry('false')).toThrow(ConfigurationError);
    expect(() => new CachekitIOCore({ ...CONFIG, telemetry: 0 as unknown as boolean })).toThrow(
      ConfigurationError
    );
  });
});

describe('telemetry switch: the truth table (API-94, API-95)', () => {
  const env = { unset: undefined, on: 'on', off: 'off' } as const;
  const setting = { unset: undefined, on: true, off: false } as const;
  const table: [keyof typeof setting, keyof typeof env, boolean][] = [
    ['unset', 'unset', true],
    ['unset', 'on', true],
    ['unset', 'off', false],
    ['on', 'unset', true],
    ['on', 'on', true],
    ['on', 'off', false],
    ['off', 'unset', false],
    ['off', 'on', false],
    ['off', 'off', false],
  ];

  it.each(table)('setting %s, environment %s: on is %s', async (s, e, on) => {
    vi.stubEnv('CACHEKIT_TELEMETRY', env[e]);
    const backend = cachekitio({
      ...CONFIG,
      telemetry: setting[s],
      metricsProvider: () => COUNTERS,
    });
    await backend.get('ns:key');
    const headers = sentHeaders();
    for (const name of SESSION_AND_COUNTERS) {
      expect(headers[name] !== undefined, name).toBe(on);
    }
    expect(backend.l1Latency !== undefined).toBe(on);
  });

  it.each(table)('on Workers bindings: setting %s, binding %s: on is %s', async (s, e, on) => {
    setTelemetryBindingsReader(() => env[e]);
    const backend = cachekitio({
      ...CONFIG,
      telemetry: setting[s],
      metricsProvider: () => COUNTERS,
    });
    await backend.get('ns:key');
    expect(sentHeaders()['X-CacheKit-Session-ID'] !== undefined).toBe(on);
  });

  it('takes off from either the process environment or the bindings', () => {
    vi.stubEnv('CACHEKIT_TELEMETRY', 'on');
    setTelemetryBindingsReader(() => 'off');
    expect(resolveTelemetry(true)).toBe(false);
    vi.stubEnv('CACHEKIT_TELEMETRY', 'off');
    setTelemetryBindingsReader(() => 'on');
    expect(resolveTelemetry(true)).toBe(false);
  });

  it('reads a non-string binding by its string form: a JSON var `false` is off', () => {
    setTelemetryBindingsReader(() => false);
    expect(resolveTelemetry(undefined)).toBe(false);
  });

  it('reads both controls once, at construction', async () => {
    const backend = cachekitio({ ...CONFIG, metricsProvider: () => COUNTERS });
    vi.stubEnv('CACHEKIT_TELEMETRY', 'off');
    await backend.get('ns:key');
    expect(sentHeaders()['X-CacheKit-Session-ID']).toBeDefined();

    const off = cachekitio({ ...CONFIG, metricsProvider: () => COUNTERS });
    vi.stubEnv('CACHEKIT_TELEMETRY', 'on');
    await off.get('ns:key');
    expect(sentHeaders()['X-CacheKit-Session-ID']).toBeUndefined();
  });
});

describe('telemetry off (API-96)', () => {
  it.each([
    ['the setting', { telemetry: false }, undefined],
    ['CACHEKIT_TELEMETRY', {}, 'off'],
  ])('off through %s: none of the nine optional headers, on any request', async (_, extra, e) => {
    vi.stubEnv('CACHEKIT_TELEMETRY', e);
    const backend = cachekitioFull({ ...CONFIG, ...extra, metricsProvider: () => COUNTERS });
    fetchSpy.mockImplementation(async () => new Response('{}', { status: 200 }));
    await backend.get('ns:key');
    await backend.set('ns:key', new Uint8Array([1]), 60);
    await backend.exists('ns:key');
    await backend.delete('ns:key');
    await backend.getTTL('ns:key');
    await backend.acquireLock('ns:key');
    await new CachekitIOCore({ ...CONFIG, ...extra, metricsProvider: () => COUNTERS }).health();
    expect(fetchSpy).toHaveBeenCalledTimes(7);
    for (let i = 0; i < 7; i++) {
      const headers = sentHeaders(i);
      for (const name of OPTIONAL_METRICS) expect(headers[name], name).toBeUndefined();
      // Kept: API-1 requires L1-Status on every ck_sdk_ request.
      expect(headers['X-CacheKit-L1-Status']).toBe('miss');
      expect(headers['User-Agent']).toMatch(/cachekit/i);
    }
  });

  it('keeps L1-Status disabled for a cache without L1', async () => {
    const backend = cachekitio({
      ...CONFIG,
      telemetry: false,
      metricsProvider: () => ({ ...COUNTERS, l1Enabled: false }),
    });
    await backend.get('ns:key');
    expect(sentHeaders()['X-CacheKit-L1-Status']).toBe('disabled');
  });
});

describe('latency report on the wire (API-84 to API-86)', () => {
  it('rides the next request, and only that one', async () => {
    const backend = new CachekitIOCore(CONFIG);
    backend.l1Latency!.record(300);
    await backend.get('ns:a');
    expect(latencyOf(sentHeaders())).toEqual([
      '0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0',
      '300',
      String(L1_LATENCY_ONE_IN),
    ]);
    await backend.get('ns:b');
    expect(latencyOf(sentHeaders())).toEqual([undefined, undefined, undefined]);
  });

  it('never rides GET /v1/cache/health, and stays for the next request (API-84)', async () => {
    const backend = new CachekitIOCore(CONFIG);
    backend.l1Latency!.record(300);
    fetchSpy.mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));
    await backend.health();
    expect(fetchSpy.mock.calls[0][0]).toBe(`${API_URL}/v1/cache/health`);
    expect(latencyOf(sentHeaders())).toEqual([undefined, undefined, undefined]);
    await backend.get('ns:a');
    expect(sentHeaders()['X-CacheKit-L1-Latency-Sum-Ns']).toBe('300');
  });

  it('is consumed by an attempt that may have reached the server, whatever the outcome (API-86)', async () => {
    const backend = new CachekitIOCore(CONFIG);
    backend.l1Latency!.record(300);
    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed: socket hang up'));
    await expect(backend.get('ns:a')).rejects.toThrow();
    expect(sentHeaders()['X-CacheKit-L1-Latency-Sum-Ns']).toBe('300');
    // The retry, or any later request, carries none of it.
    await backend.get('ns:a');
    expect(latencyOf(sentHeaders())).toEqual([undefined, undefined, undefined]);
  });

  describe('rides one attempt on the wire, whatever resends the request', () => {
    const auth = `Bearer ${API_KEY}`;
    let backend: CachekitIOCore;
    const get = async () => {
      backend = new CachekitIOCore(CONFIG);
      backend.l1Latency!.record(300);
      expect(await backend.get('ns:a')).toBeNull();
    };

    it("fetch's own resend after a 421 carries none of it", async () => {
      // A 421 makes Node's fetch resend the request on a new connection, without
      // returning to the backend (the Fetch standard's misdirected-request retry).
      expect(await onTheWire([421, 404], get)).toEqual([
        { sumNs: '300', authorization: auth },
        { sumNs: undefined, authorization: auth },
      ]);
      expect(backend.l1Latency!.take()).toBeUndefined();
    });

    it("a retry inside the Agent, by undici's retry interceptor, carries none of it", async () => {
      const agent = new undici.Agent({
        factory: (origin: string, options: object) =>
          new undici.Pool(origin, options).compose(undici.interceptors.retry(RETRY_ONCE)),
      });
      expect(await onTheWire([503, 404], get, agent)).toEqual([
        { sumNs: '300', authorization: auth },
        { sumNs: undefined, authorization: auth },
      ]);
    });

    it('rides the one attempt of an uncontended request through undici’s Agent', async () => {
      expect(await onTheWire([404], get, new undici.Agent())).toEqual([
        { sumNs: '300', authorization: auth },
      ]);
      expect(backend.l1Latency!.take()).toBeUndefined();
    });

    it.each([
      ['a RetryAgent', () => new undici.RetryAgent(new undici.Agent(), RETRY_ONCE)],
      [
        'an Agent composed with retry',
        () => new undici.Agent().compose(undici.interceptors.retry(RETRY_ONCE)),
      ],
    ])('waits while the global dispatcher is %s, which may resend', async (_, make) => {
      expect(await onTheWire([503, 404], get, make())).toEqual([
        { sumNs: undefined, authorization: auth },
        { sumNs: undefined, authorization: auth },
      ]);
      // Not taken: it rides a later request, through undici's Agent.
      expect(backend.l1Latency!.take()?.['X-CacheKit-L1-Latency-Sum-Ns']).toBe('300');
    });

    it('leaves a MockAgent alone: a body-matching intercept still sees the bytes of a set', async () => {
      vi.stubGlobal('fetch', nodeFetch);
      const mock = new undici.MockAgent();
      mock.disableNetConnect();
      const bodies: unknown[] = [];
      mock
        .get(API_URL)
        .intercept({
          path: (path: string) => path.startsWith('/v1/cache/'),
          method: 'PUT',
          body: (body: unknown) => bodies.push(body) > 0,
        })
        .reply(200, '{}');
      try {
        await keepingGlobalDispatcher(async () => {
          undici.setGlobalDispatcher(mock);
          backend = new CachekitIOCore(CONFIG);
          backend.l1Latency!.record(300);
          await backend.set('ns:a', new TextEncoder().encode('payload'), 60);
        });
      } finally {
        await mock.close();
      }
      // The bytes themselves, not a stream: fetch read the mock's isMockActive.
      const decoded = bodies.map((body) =>
        body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body)
      );
      expect(new Set(decoded)).toEqual(new Set(['payload']));
      // Not undici's Agent: the report is not taken, and waits.
      expect(backend.l1Latency!.take()?.['X-CacheKit-L1-Latency-Sum-Ns']).toBe('300');
    });

    it('a pipelining Agent never writes it again after the connection drops', async () => {
      // A raw server, to see every byte. On the first connection it answers
      // the first request's headers but holds its body: once fetch has read
      // those headers, undici may pipeline a GET behind it. The connection
      // drops as soon as a second request arrives on it, and undici fails the
      // head and requeues whatever it wrote behind it.
      let wire = '';
      let firstSocket: Socket | undefined;
      const sockets: Socket[] = [];
      const server = createTcpServer((socket) => {
        sockets.push(socket);
        const first = firstSocket === undefined;
        firstSocket ??= socket;
        let heads = 0;
        socket.on('error', () => {});
        socket.on('data', (chunk) => {
          const text = chunk.toString('latin1');
          wire += text;
          const count = text.split('\r\n\r\n').length - 1;
          if (!first) {
            for (let i = 0; i < count; i++) {
              socket.write('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n');
            }
            return;
          }
          if (heads === 0 && count > 0) {
            socket.write('HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nabc');
          }
          heads += count;
          if (heads >= 2) socket.destroy();
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      let headersRead: Promise<unknown> | undefined;
      vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
        const response = nodeFetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init);
        headersRead ??= response.catch(() => undefined);
        return response;
      });
      const agent = new undici.Agent({ pipelining: 2, connections: 1 });
      try {
        await keepingGlobalDispatcher(async () => {
          undici.setGlobalDispatcher(agent);
          backend = new CachekitIOCore(CONFIG);
          const plain = backend.get('ns:x'); // takes no report: there is none yet
          await vi.waitFor(() => expect(headersRead).toBeDefined());
          await headersRead; // fetch resolves once the response headers are read
          backend.l1Latency!.record(300);
          const carrying = backend.get('ns:a');
          // Not pipelined, it waits behind the held response: drop the
          // connection under it, so it goes out on the next one.
          const drop = setTimeout(() => firstSocket?.destroy(), 500);
          await Promise.allSettled([plain, carrying]);
          clearTimeout(drop);
        });
      } finally {
        await agent.close();
        for (const socket of sockets) socket.destroy();
        server.close();
      }
      expect(wire.match(/x-cachekit-l1-latency-sum-ns: 300/gi)).toHaveLength(1);
    });

    it('a fetch wrapper that retries with the same init carries none of it', async () => {
      const seen = await onTheWire([503, 404], async () => {
        const routed = globalThis.fetch;
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
          const response = await routed(url, init);
          return response.status === 503 ? routed(url, init) : response;
        });
        await get();
      });
      expect(seen).toEqual([
        { sumNs: '300', authorization: auth },
        { sumNs: undefined, authorization: auth },
      ]);
    });
  });

  it('stays in place while no dispatcher can keep it to one attempt', async () => {
    await keepingGlobalDispatcher(async () => {
      for (const key of DISPATCHER_SLOTS) Reflect.set(globalThis, key, undefined);
      const backend = new CachekitIOCore(CONFIG);
      backend.l1Latency!.record(300);
      await backend.get('ns:a');
      expect(latencyOf(sentHeaders())).toEqual([undefined, undefined, undefined]);
      expect(backend.l1Latency!.take()?.['X-CacheKit-L1-Latency-Sum-Ns']).toBe('300');
    });
  });

  it('is consumed by a 5xx too: nothing is added back', async () => {
    const backend = new CachekitIOCore(CONFIG);
    backend.l1Latency!.record(300);
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    await expect(backend.get('ns:a')).rejects.toThrow();
    await backend.get('ns:a');
    expect(latencyOf(sentHeaders())).toEqual([undefined, undefined, undefined]);
  });

  it("goes only to the backend's configured API, and never follows a redirect (API-77)", async () => {
    const backend = cachekitioFull(CONFIG);
    backend.l1Latency!.record(300);
    fetchSpy.mockImplementation(async () => new Response('{}', { status: 200 }));
    await backend.get('ns:a');
    await backend.acquireLock('ns:a');
    for (const [url, init] of fetchSpy.mock.calls as [string, RequestInit][]) {
      expect(url.startsWith(`${API_URL}/v1/cache/`)).toBe(true);
      expect(init.redirect).toBe('manual');
    }
  });

  it("keeps one accumulator per backend: no backend's hits ride another's requests (§ Reports)", async () => {
    // API-83 (a forked child starts empty) needs no test here: Node has no
    // fork(), and a child process (child_process, cluster) loads the module
    // afresh, so its backends start empty by construction.
    const a = new CachekitIOCore(CONFIG);
    const b = new CachekitIOCore(CONFIG);
    a.l1Latency!.record(300);
    expect(b.l1Latency!.take()).toBeUndefined();
    await b.get('ns:x');
    expect(sentHeaders()['X-CacheKit-L1-Latency-Sum-Ns']).toBeUndefined();
  });

  it('is forwarded by every CachekitIO wrapper (Backend.l1Latency)', () => {
    for (const factory of [cachekitio, cachekitioWithLocking, cachekitioWithTTL, cachekitioFull]) {
      expect(factory(CONFIG).l1Latency).toBeInstanceOf(L1LatencyReport);
      expect(factory({ ...CONFIG, telemetry: false }).l1Latency).toBeUndefined();
    }
  });
});

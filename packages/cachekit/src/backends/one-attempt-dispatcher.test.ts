/**
 * The dispatcher that keeps a latency report to one attempt (protocol
 * spec/saas-api.md, API-86). telemetry.test.ts checks it on the wire, with
 * this Node's own fetch and genuine undici dispatchers; this pins, for each
 * undici Node bundles, which global slot it reads, which Agents it accepts,
 * and what each attempt is handed.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { oneAttemptDispatcher } from './one-attempt-dispatcher.js';
import { setLogger } from '../logger.js';
import { npmUndici } from '../../test/fixtures/npm-undici.js';

const LEGACY = Symbol.for('undici.globalDispatcher.1');
const CURRENT = Symbol.for('undici.globalDispatcher.2');
const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = promisify(execFile);
let saved: unknown[] = [];

/** The built `dist/backends/<name>.js`, refused while missing or older than its source. */
function built(name: string): string {
  const dist = join(PKG_DIR, 'dist', 'backends', `${name}.js`);
  const source = join(PKG_DIR, 'src', 'backends', `${name}.ts`);
  if (!existsSync(dist) || statSync(dist).mtimeMs < statSync(source).mtimeMs) {
    throw new Error(`${dist} is missing or older than its source: run \`pnpm build\` first`);
  }
  return dist;
}

/** Run a probe from test/node-entry in this Node, and parse what it prints. */
async function probe(file: string, ...args: string[]): Promise<unknown> {
  const path = join(PKG_DIR, 'test', 'node-entry', file);
  const { stdout } = await run(process.execPath, [path, ...args], { timeout: 20_000 });
  return JSON.parse(stdout);
}

// The child runs this same Node, so it bundles this undici.
const NODE_UNDICI = Number.parseInt(process.versions.undici ?? '', 10);

/** Put dispatchers in undici's two global slots, as undici 6 to 8 fill them. */
function install(legacy: unknown, current: unknown): void {
  Reflect.set(globalThis, LEGACY, legacy);
  Reflect.set(globalThis, CURRENT, current);
}

const HEADERS = {
  Authorization: 'Bearer x',
  'X-CacheKit-L1-Status': 'miss',
  'X-CacheKit-L1-Latency-Buckets': '0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0',
  'X-CacheKit-L1-Latency-Sum-Ns': '300',
  'X-CacheKit-L1-Latency-One-In': '1024',
};
const WITHOUT_REPORT = { Authorization: 'Bearer x', 'X-CacheKit-L1-Status': 'miss' };
const UNDICI_8 = { version: '8.12.2', handler: { onRequestStart() {} }, slot: 'current' };
const UNDICI_7 = { version: '7.30.1', handler: { onConnect() {} }, slot: 'legacy' };

/**
 * What each dispatch was handed: the headers as read then, the object itself,
 * and whether the attempt was marked idempotent.
 */
type Log = { name: string; read: unknown; held: unknown; idempotent?: boolean }[];

// Where undici 6 to 8 keep an Agent's options and factory, and undici 6 its
// interceptors and the dispatch it composes from them on its first.
const OPTIONS = Symbol('options');
const FACTORY = Symbol('factory');
const INTERCEPTORS = Symbol('dispatch interceptors');
const COMPOSED = Symbol('Intercepted Dispatch');

/** The class undici's Agent extends. */
class DispatcherBase {}

/** Undici's own factory: one function, which every Agent built with defaults holds. */
function defaultFactory(): void {}

/** Shaped like an Agent built with defaults: `new Agent()`. */
class Agent extends DispatcherBase {
  [OPTIONS] = { maxOrigins: Infinity, connect: undefined, tls: undefined };
  [FACTORY] = defaultFactory;
  [INTERCEPTORS] = [
    (dispatch: () => boolean) =>
      function Intercept(): boolean {
        return dispatch();
      },
  ];
  constructor(
    private readonly name: string,
    private readonly log: Log
  ) {
    super();
  }
  dispatch(options: { headers?: unknown; idempotent?: boolean }): boolean {
    this.log.push({
      name: this.name,
      read: { ...(options.headers as object) },
      held: options.headers,
      idempotent: options.idempotent,
    });
    return true;
  }
}

class RetryAgent extends Agent {}

beforeEach(() => {
  void globalThis.Headers; // loads Node's undici, which fills its global slots
  saved = [Reflect.get(globalThis, LEGACY), Reflect.get(globalThis, CURRENT)];
});

afterEach(() => install(saved[0], saved[1]));

describe('oneAttemptDispatcher', () => {
  it.each([
    ['undici 8 (onRequestStart)', UNDICI_8],
    ['undici 6 and 7 (onConnect)', UNDICI_7],
  ])(
    'under %s, hands the report to the slot its fetch reads, on the first attempt only',
    (_, { version, handler, slot }) => {
      const log: Log = [];
      install(new Agent('legacy', log), new Agent('current', log));
      const dispatcher = oneAttemptDispatcher(version)!;
      dispatcher.dispatch({ headers: HEADERS }, handler);
      dispatcher.dispatch({ headers: HEADERS }, handler);
      // The first attempt is not idempotent, so no client could pipeline it.
      expect(log.map(({ name, read, idempotent }) => [name, read, idempotent])).toEqual([
        [slot, HEADERS, false],
        [slot, WITHOUT_REPORT, undefined],
      ]);
    }
  );

  it('takes the report out of the headers it handed on, once dispatch returns', () => {
    const log: Log = [];
    install(new Agent('legacy', log), new Agent('current', log));
    oneAttemptDispatcher(UNDICI_8.version)!.dispatch({ headers: HEADERS }, UNDICI_8.handler);
    // A layer that kept the options to resend them, as undici's retry handler
    // does, reads them again without the report.
    expect(log[0].read).toEqual(HEADERS);
    expect(log[0].held).toEqual(WITHOUT_REPORT);
    expect(HEADERS['X-CacheKit-L1-Latency-Sum-Ns']).toBe('300');
  });

  it.each([UNDICI_8, UNDICI_7])(
    'makes none, and the report waits, unless the slot fetch reads holds an Agent built with defaults ($version)',
    ({ version }) => {
      const log: Log = [];
      install(new RetryAgent('legacy', log), new RetryAgent('current', log));
      expect(oneAttemptDispatcher(version)).toBeUndefined();
    }
  );

  it('under undici 8, never falls back to the first slot, which holds the legacy adapter', () => {
    install(new Agent('legacy', []), undefined);
    expect(oneAttemptDispatcher(UNDICI_8.version)).toBeUndefined();
  });

  it.each([
    ['an Agent built with defaults: with the report', Agent, HEADERS],
    ['anything else: without it', RetryAgent, WITHOUT_REPORT],
  ])("sends another fetch's handler to the slot that fetch reads, holding %s", (_, Kind, sent) => {
    // npm undici's fetch, of another major than Node's, on a global slot of its own.
    const log: Log = [];
    install(new Kind('legacy', log), new Agent('current', log));
    oneAttemptDispatcher(UNDICI_8.version)!.dispatch({ headers: HEADERS }, UNDICI_7.handler);
    expect(log.map(({ name, read }) => [name, read])).toEqual([['legacy', sent]]);
  });

  describe('only an Agent built with defaults gets a report', () => {
    // In a child process: here the npm undici above loaded first, and its
    // Agent fills both slots before Node's own undici loads.
    it("accepts this Node's own default, and refuses Node's own Agent with any option set", async () => {
      const accepted = await probe('default-dispatcher-probe.mjs', built('one-attempt-dispatcher'));
      expect(accepted).toEqual({
        undici: NODE_UNDICI,
        'the default': true,
        'new Agent()': true,
        allowH2: false,
        'connect.allowH2': false,
        'a connect function': false,
        'a factory': false,
        'a factory named defaultFactory': false,
        pipelining: false,
        'a CA only': false,
        // Undici 6 keeps it apart from the options; fetch dispatches with 0.
        maxRedirections: NODE_UNDICI === 6,
        'a subclass named Agent': false,
        'a subclass named Agent, through a class named DispatcherBase': false,
      });
    }, 30_000);

    // On the wire, in a child process for the same reason: Node's own Agent
    // sends every request twice, each from its own copy of the headers. Each
    // attempt's X-CacheKit-L1-Latency-Sum-Ns, and whether the report waits.
    const resent = { undici: NODE_UNDICI, seen: [null, null], waits: '300' };
    it.each([
      // Only undici 6 has the setter; on later majors the probe changes
      // nothing, and the report rides the one request.
      [
        'whose interceptors were replaced (undici 6)',
        'interceptors',
        NODE_UNDICI === 6 ? resent : { undici: NODE_UNDICI, seen: ['300'], waits: null },
      ],
      ['whose factory only shares the name defaultFactory', 'factory', resent],
    ])(
      'sends no report through an Agent %s',
      async (_, how, expected) => {
        built('one-attempt-dispatcher');
        expect(await probe('resending-agent-probe.mjs', built('cachekitio'), how)).toEqual(
          expected
        );
      },
      30_000
    );

    describe('undici 6 interceptors', () => {
      it('accepts an Agent that has composed the interceptor it was built with', () => {
        const agent = new Agent('current', []);
        Reflect.set(
          agent,
          COMPOSED,
          agent[INTERCEPTORS][0](() => true)
        );
        install(agent, agent);
        expect(oneAttemptDispatcher(UNDICI_7.version)).toBeDefined();
      });

      it.each([
        ['replaced', INTERCEPTORS, [(dispatch: unknown) => dispatch]],
        ['removed', INTERCEPTORS, null],
        ['composed from others', COMPOSED, (): boolean => false],
      ])('refuses an Agent whose interceptors were %s', (_, field, value) => {
        const agent = new Agent('current', []);
        Reflect.set(agent, field, value);
        install(agent, agent);
        expect(oneAttemptDispatcher(UNDICI_7.version)).toBeUndefined();
      });

      it('refuses a composed dispatch on an Agent whose class is built without interceptors', () => {
        const agent = new npmUndici.Agent();
        Reflect.set(agent, COMPOSED, (): boolean => false);
        install(agent, agent);
        expect(oneAttemptDispatcher(UNDICI_7.version)).toBeUndefined();
      });

      it('refuses, and logs once, an Agent of a class it cannot build afresh to compare with', () => {
        const agent = Object.assign(new Agent('current', []), {
          constructor: function Agent(): never {
            throw new Error('not built');
          },
        });
        install(agent, agent);
        const logged: unknown[][] = [];
        setLogger((message, error) => logged.push([message, error]));
        try {
          expect(oneAttemptDispatcher(UNDICI_7.version)).toBeUndefined();
          expect(oneAttemptDispatcher(UNDICI_7.version)).toBeUndefined();
        } finally {
          setLogger(null);
        }
        expect(logged).toEqual([
          [expect.stringMatching(/cannot build a fresh Agent/), new Error('not built')],
        ]);
      });
    });

    it.each([UNDICI_8, UNDICI_7])('accepts a genuine `new Agent()` ($version)', ({ version }) => {
      const agent = new npmUndici.Agent();
      install(agent, agent);
      expect(oneAttemptDispatcher(version)).toBeDefined();
    });

    it.each([
      ['allowH2', { allowH2: true }],
      ['connect.allowH2', { connect: { allowH2: true } }],
      ['a connect function', { connect: () => undefined }],
      [
        'a factory',
        { factory: (origin: string, options: object) => new npmUndici.Pool(origin, options) },
      ],
      [
        'a factory that only shares the name defaultFactory',
        {
          factory: function defaultFactory(origin: string, options: object) {
            return new npmUndici.Pool(origin, options);
          },
        },
      ],
      ['pipelining', { pipelining: 2 }],
      ['a CA only', { connect: { ca: 'x' } }],
    ])('refuses a genuine Agent created with %s, on either slot', (_, options) => {
      const agent = new npmUndici.Agent(options);
      install(agent, agent);
      expect(oneAttemptDispatcher(UNDICI_8.version)).toBeUndefined();
      expect(oneAttemptDispatcher(UNDICI_7.version)).toBeUndefined();
    });

    // A class between named DispatcherBase, whose dispatch could resend.
    const Between = class DispatcherBase extends npmUndici.Agent {
      dispatch(): boolean {
        return true;
      }
    };
    it.each([
      ['directly', () => new (class Agent extends npmUndici.Agent {})()],
      ['through a class named DispatcherBase', () => new (class Agent extends Between {})()],
    ])('refuses a subclass named Agent of a genuine Agent, %s', (_, make) => {
      const agent = make();
      install(agent, agent);
      expect(oneAttemptDispatcher(UNDICI_8.version)).toBeUndefined();
      expect(oneAttemptDispatcher(UNDICI_7.version)).toBeUndefined();
    });

    it.each([
      ['its options', OPTIONS],
      ['its factory', FACTORY],
    ])('refuses an Agent whose %s it cannot read', (_, field) => {
      const agent = new Agent('current', []);
      delete (agent as unknown as Record<symbol, unknown>)[field];
      install(agent, agent);
      expect(oneAttemptDispatcher(UNDICI_8.version)).toBeUndefined();
    });
  });

  it('refuses headers it cannot read, rather than send a report it cannot remove', () => {
    const log: Log = [];
    install(new Agent('legacy', log), new Agent('current', log));
    const raw = Object.entries(HEADERS).flat();
    expect(() =>
      oneAttemptDispatcher(UNDICI_8.version)!.dispatch({ headers: raw }, UNDICI_8.handler)
    ).toThrow(/cannot read the headers/);
    expect(log).toHaveLength(0);
  });

  it('treats a slot holding something other than a dispatcher as empty', () => {
    install({ dispatch: 'not a function' }, 42);
    expect(oneAttemptDispatcher(UNDICI_8.version)).toBeUndefined();
    expect(oneAttemptDispatcher(UNDICI_7.version)).toBeUndefined();
  });

  it.each([
    ['no prototype', (): object => Object.create(null) as object],
    [
      'prototypes without constructors',
      (): object => Object.create(Object.create(Object.create(null) as object) as object) as object,
    ],
  ])('refuses a dispatcher with %s, and so no class', (_, make) => {
    const bare = Object.assign(make(), { dispatch: () => true });
    install(bare, bare);
    expect(oneAttemptDispatcher(UNDICI_8.version)).toBeUndefined();
    expect(oneAttemptDispatcher(UNDICI_7.version)).toBeUndefined();
  });

  it('makes none off Node, where there is no undici', () => {
    expect(oneAttemptDispatcher(null)).toBeUndefined();
  });
});

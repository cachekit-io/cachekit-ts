/**
 * The dispatcher that keeps a latency report to one attempt (protocol
 * spec/saas-api.md, API-86). telemetry.test.ts checks it on the wire, with
 * this Node's own fetch and genuine undici dispatchers; this pins, for each
 * undici Node bundles, which global slot it reads, when it makes no
 * dispatcher at all, and what each attempt is handed.
 */
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { oneAttemptDispatcher } from './one-attempt-dispatcher.js';

// The npm undici that miniflare (from @cloudflare/vitest-plugin) brings.
const npmUndici = createRequire(
  createRequire(import.meta.resolve('@cloudflare/vitest-plugin')).resolve('miniflare')
)('undici') as { Agent: new (options?: object) => object };

const LEGACY = Symbol.for('undici.globalDispatcher.1');
const CURRENT = Symbol.for('undici.globalDispatcher.2');
let saved: unknown[] = [];

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

/** Where undici 6 to 8 keep an Agent's options: a symbol described as 'options'. */
const OPTIONS = Symbol('options');

/** Named like undici's own Agent, which the report may go through. */
class Agent {
  [OPTIONS]: object;
  constructor(
    private readonly name: string,
    private readonly log: Log,
    options: object = {}
  ) {
    this[OPTIONS] = options;
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
      // The first attempt is not idempotent, so no client pipelines it behind
      // a running request and writes it again when that connection drops.
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
    'makes none, and the report waits, unless the slot fetch reads holds undici’s Agent ($version)',
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
    ['undici’s Agent: with the report', Agent, HEADERS],
    ['anything else: without it', RetryAgent, WITHOUT_REPORT],
  ])("sends another fetch's handler to the slot that fetch reads, holding %s", (_, Kind, sent) => {
    // npm undici's fetch, of another major than Node's, on a global slot of its own.
    const log: Log = [];
    install(new Kind('legacy', log), new Agent('current', log));
    oneAttemptDispatcher(UNDICI_8.version)!.dispatch({ headers: HEADERS }, UNDICI_7.handler);
    expect(log.map(({ name, read }) => [name, read])).toEqual([['legacy', sent]]);
  });

  describe('HTTP/2 on the first slot, where undici 6 rewrites streams in flight', () => {
    it.each([
      ['allowH2 on', false, { allowH2: true }],
      ['allowH2 off', true, { allowH2: false }],
      ['allowH2 unset, the default', true, {}],
    ])('under undici 6 and 7, an Agent with %s gets a report: %s', (_, sends, options) => {
      install(new Agent('legacy', [], options), undefined);
      expect(oneAttemptDispatcher(UNDICI_7.version) !== undefined).toBe(sends);
    });

    it('treats an Agent whose options it cannot read as HTTP/2 on', () => {
      const agent = new Agent('legacy', []);
      delete (agent as Partial<Agent>)[OPTIONS];
      install(agent, undefined);
      expect(oneAttemptDispatcher(UNDICI_7.version)).toBeUndefined();
    });

    it('under undici 8, whose HTTP/2 replays only undelivered streams, allowH2 does not matter', () => {
      install(undefined, new Agent('current', [], { allowH2: true }));
      expect(oneAttemptDispatcher(UNDICI_8.version)).toBeDefined();
    });

    it("strips the report from another fetch's request to an HTTP/2 Agent on the first slot", () => {
      const log: Log = [];
      install(new Agent('legacy', log, { allowH2: true }), new Agent('current', log));
      oneAttemptDispatcher(UNDICI_8.version)!.dispatch({ headers: HEADERS }, UNDICI_7.handler);
      expect(log.map(({ name, read }) => [name, read])).toEqual([['legacy', WITHOUT_REPORT]]);
    });

    type AgentClass = new (options?: object) => object;
    // This Node's own Agent sits in the first slot only under undici 6 and 7.
    const genuine: [string, () => AgentClass][] = [['npm undici 7', () => npmUndici.Agent]];
    if (Number.parseInt(process.versions.undici ?? '', 10) < 8) {
      genuine.push(['this Node’s own', () => (saved[0] as object).constructor as AgentClass]);
    }

    it.each(genuine)('reads allowH2 from a genuine %s Agent', (_, ctor) => {
      const Genuine = ctor();
      install(new Genuine({ allowH2: true }), undefined);
      expect(oneAttemptDispatcher(UNDICI_7.version)).toBeUndefined();
      install(new Genuine(), undefined);
      expect(oneAttemptDispatcher(UNDICI_7.version)).toBeDefined();
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

  it('makes none off Node, where there is no undici', () => {
    expect(oneAttemptDispatcher(null)).toBeUndefined();
  });
});

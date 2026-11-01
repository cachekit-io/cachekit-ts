/**
 * The dispatcher that keeps a latency report to one attempt (protocol
 * spec/saas-api.md, API-86). telemetry.test.ts checks it on the wire, with
 * this Node's own fetch and genuine undici dispatchers; this pins how it picks
 * undici's global dispatcher for each handler API, which the other Node
 * versions use, and what each attempt is handed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { oneAttemptDispatcher } from './one-attempt-dispatcher.js';

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

/** What each dispatch was handed: the headers as read then, and the object itself. */
type Log = { name: string; read: unknown; held: unknown }[];

/** Named like undici's own Agent, which the report may go through. */
class Agent {
  constructor(
    private readonly name: string,
    private readonly log: Log
  ) {}
  dispatch(options: { headers?: unknown }): boolean {
    this.log.push({
      name: this.name,
      read: { ...(options.headers as object) },
      held: options.headers,
    });
    return true;
  }
}

class RetryAgent extends Agent {}

beforeEach(() => {
  void globalThis.Headers; // loads Node's undici, which sets its global dispatcher
  saved = [Reflect.get(globalThis, LEGACY), Reflect.get(globalThis, CURRENT)];
});

afterEach(() => install(saved[0], saved[1]));

describe('oneAttemptDispatcher', () => {
  it.each([
    ['undici 7 and 8 (onRequestStart)', { onRequestStart() {} }, 'current'],
    ['undici 6 (onConnect)', { onConnect() {} }, 'legacy'],
  ])(
    'hands a %s handler to the dispatcher fetch reads: the report on the first attempt only',
    (_, handler, expected) => {
      const log: Log = [];
      install(new Agent('legacy', log), new Agent('current', log));
      const dispatcher = oneAttemptDispatcher()!;
      dispatcher.dispatch({ headers: HEADERS }, handler);
      dispatcher.dispatch({ headers: HEADERS }, handler);
      expect(log.map(({ name, read }) => [name, read])).toEqual([
        [expected, HEADERS],
        [expected, WITHOUT_REPORT],
      ]);
    }
  );

  it('takes the report out of the headers it handed on, once dispatch returns', () => {
    const log: Log = [];
    install(new Agent('current', log), new Agent('current', log));
    oneAttemptDispatcher()!.dispatch({ headers: HEADERS }, { onRequestStart() {} });
    // A layer that kept the options to resend them, as undici's retry handler
    // does, reads them again without the report.
    expect(log[0].read).toEqual(HEADERS);
    expect(log[0].held).toEqual(WITHOUT_REPORT);
    expect(log[0].held).not.toBe(HEADERS);
    expect(HEADERS['X-CacheKit-L1-Latency-Sum-Ns']).toBe('300');
  });

  it('withholds the report from a global dispatcher other than undici’s Agent', () => {
    const log: Log = [];
    install(new RetryAgent('retry', log), new RetryAgent('retry', log));
    oneAttemptDispatcher()!.dispatch({ headers: HEADERS }, { onRequestStart() {} });
    expect(log.map(({ read }) => read)).toEqual([WITHOUT_REPORT]);
  });

  it('falls back to the legacy dispatcher where undici 6 sets no other', () => {
    const log: Log = [];
    install(new Agent('legacy', log), undefined);
    oneAttemptDispatcher()!.dispatch({ headers: HEADERS }, { onRequestStart() {} });
    expect(log.map(({ name, read }) => [name, read])).toEqual([['legacy', HEADERS]]);
  });

  it('refuses headers it cannot read, rather than send the report it cannot remove', () => {
    const log: Log = [];
    install(new Agent('current', log), new Agent('current', log));
    const raw = Object.entries(HEADERS).flat();
    expect(() =>
      oneAttemptDispatcher()!.dispatch({ headers: raw }, { onRequestStart() {} })
    ).toThrow(/cannot read the headers/);
    expect(log).toHaveLength(0);
  });

  it('treats a slot holding something other than a dispatcher as empty', () => {
    install({ dispatch: 'not a function' }, 42);
    expect(oneAttemptDispatcher()).toBeUndefined();
  });

  it('makes no dispatcher without a global one to hand to: the report waits', () => {
    install(undefined, undefined);
    expect(oneAttemptDispatcher()).toBeUndefined();
  });
});

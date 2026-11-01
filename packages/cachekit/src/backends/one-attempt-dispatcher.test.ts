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
const slots = globalThis as unknown as Record<symbol, unknown>;
const saved = { legacy: undefined as unknown, current: undefined as unknown };

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
  saved.legacy = slots[LEGACY];
  saved.current = slots[CURRENT];
});

afterEach(() => {
  slots[LEGACY] = saved.legacy;
  slots[CURRENT] = saved.current;
});

describe('oneAttemptDispatcher', () => {
  it.each([
    ['undici 7 and 8 (onRequestStart)', { onRequestStart() {} }, 'current'],
    ['undici 6 (onConnect)', { onConnect() {} }, 'legacy'],
  ])(
    'hands a %s handler to the dispatcher fetch reads: the report on the first attempt only',
    (_, handler, expected) => {
      const log: Log = [];
      slots[LEGACY] = new Agent('legacy', log);
      slots[CURRENT] = new Agent('current', log);
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
    slots[LEGACY] = slots[CURRENT] = new Agent('current', log);
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
    slots[LEGACY] = slots[CURRENT] = new RetryAgent('retry', log);
    oneAttemptDispatcher()!.dispatch({ headers: HEADERS }, { onRequestStart() {} });
    expect(log.map(({ read }) => read)).toEqual([WITHOUT_REPORT]);
  });

  it('falls back to the legacy dispatcher where undici 6 sets no other', () => {
    const log: Log = [];
    slots[LEGACY] = new Agent('legacy', log);
    slots[CURRENT] = undefined;
    oneAttemptDispatcher()!.dispatch({ headers: HEADERS }, { onRequestStart() {} });
    expect(log.map(({ name, read }) => [name, read])).toEqual([['legacy', HEADERS]]);
  });

  it('refuses headers it cannot read, rather than send the report it cannot remove', () => {
    const log: Log = [];
    slots[LEGACY] = slots[CURRENT] = new Agent('current', log);
    const raw = Object.entries(HEADERS).flat();
    expect(() =>
      oneAttemptDispatcher()!.dispatch({ headers: raw }, { onRequestStart() {} })
    ).toThrow(/cannot read the headers/);
    expect(log).toHaveLength(0);
  });

  it('makes no dispatcher without a global one to hand to: the report waits', () => {
    slots[LEGACY] = undefined;
    slots[CURRENT] = undefined;
    expect(oneAttemptDispatcher()).toBeUndefined();
  });
});

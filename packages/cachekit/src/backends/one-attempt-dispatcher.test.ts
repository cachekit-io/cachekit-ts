/**
 * The dispatcher that keeps a latency report to one attempt (protocol
 * spec/saas-api.md, API-86). telemetry.test.ts checks it on the wire, with
 * this Node's own fetch; this pins how it picks undici's global dispatcher
 * for each handler API, which the other Node versions use.
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

function recorder(name: string, log: [string, unknown][]) {
  return {
    dispatch: (options: { headers?: unknown }) => (log.push([name, options.headers]), true),
  };
}

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
    'hands a %s handler to the dispatcher fetch reads: the first attempt as is, later ones without the report',
    (_, handler, expected) => {
      const log: [string, unknown][] = [];
      slots[LEGACY] = recorder('legacy', log);
      slots[CURRENT] = recorder('current', log);
      const dispatcher = oneAttemptDispatcher()!;
      dispatcher.dispatch({ headers: HEADERS }, handler);
      dispatcher.dispatch({ headers: HEADERS }, handler);
      expect(log).toEqual([
        [expected, HEADERS],
        [expected, { Authorization: 'Bearer x', 'X-CacheKit-L1-Status': 'miss' }],
      ]);
    }
  );

  it('falls back to the legacy dispatcher where undici 6 sets no other', () => {
    const log: [string, unknown][] = [];
    slots[LEGACY] = recorder('legacy', log);
    slots[CURRENT] = undefined;
    oneAttemptDispatcher()!.dispatch({ headers: HEADERS }, { onRequestStart() {} });
    expect(log).toEqual([['legacy', HEADERS]]);
  });

  it('refuses a resend whose headers it cannot read, rather than resend the report', () => {
    const log: [string, unknown][] = [];
    slots[LEGACY] = slots[CURRENT] = recorder('current', log);
    const dispatcher = oneAttemptDispatcher()!;
    const raw = Object.entries(HEADERS).flat();
    dispatcher.dispatch({ headers: raw }, { onRequestStart() {} });
    expect(() => dispatcher.dispatch({ headers: raw }, { onRequestStart() {} })).toThrow(
      /cannot remove the latency report/
    );
    expect(log).toHaveLength(1);
  });

  it('makes no dispatcher without a global one to hand to: the report waits', () => {
    slots[LEGACY] = undefined;
    slots[CURRENT] = undefined;
    expect(oneAttemptDispatcher()).toBeUndefined();
  });
});

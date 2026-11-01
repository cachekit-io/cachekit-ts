/**
 * Node's fetch resends a request that drew a 421 (Misdirected Request) once,
 * on a new connection, without returning to the code that built it: the Fetch
 * standard's own retry. A latency report rides one attempt (protocol
 * spec/saas-api.md, API-86), so a request that carries one goes through a
 * dispatcher of its own, which hands the first attempt to undici's global
 * dispatcher as is and every later one without the report's headers.
 *
 * Node keeps undici's global dispatcher under the symbols undici registers it
 * with, read here as Node's fetch reads them: undici 6 and 7 read the first,
 * undici 8 the second, where the first holds an adapter for the older handler
 * API. Elsewhere neither is set, and nothing here is used: only Node times L1
 * hits.
 */

/** The one method of undici's Dispatcher that fetch calls. */
interface Dispatcher {
  dispatch(options: { headers?: unknown }, handler: object): boolean;
}

const LEGACY = Symbol.for('undici.globalDispatcher.1');
const CURRENT = Symbol.for('undici.globalDispatcher.2');
const REPORT_HEADER = /^x-cachekit-l1-latency-/i;

function slots(): Record<symbol, Dispatcher | undefined> {
  return globalThis as unknown as Record<symbol, Dispatcher | undefined>;
}

/** The dispatcher Node's fetch would use, for a handler of the API it passes. */
function globalDispatcher(handler: object): Dispatcher | undefined {
  return ('onRequestStart' in handler && slots()[CURRENT]) || slots()[LEGACY];
}

/** The headers fetch dispatches, without the report's. */
function withoutReport(headers: unknown): Record<string, unknown> {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    // Not the plain object undici 6 to 8 dispatch: refuse the attempt rather
    // than resend a report.
    throw new Error('cachekit: cannot remove the latency report from a resent request');
  }
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !REPORT_HEADER.test(name)));
}

/**
 * A fetch `dispatcher` for one request that carries a latency report, or
 * undefined while there is no global dispatcher to hand to: the report then
 * waits for a later request.
 */
export function oneAttemptDispatcher(): Dispatcher | undefined {
  // Node loads undici on the first use of fetch or one of its classes, and
  // undici sets its global dispatcher as it loads.
  if (slots()[LEGACY] === undefined) void globalThis.Headers;
  if (slots()[LEGACY] === undefined && slots()[CURRENT] === undefined) return undefined;
  let dispatched = false;
  return {
    dispatch(options, handler) {
      const target = globalDispatcher(handler);
      if (target === undefined) throw new Error('cachekit: no global dispatcher');
      const attempt = dispatched
        ? { ...options, headers: withoutReport(options.headers) }
        : options;
      dispatched = true;
      return target.dispatch(attempt, handler);
    },
  };
}

/**
 * A latency report rides one attempt (protocol spec/saas-api.md, API-86), and
 * a request can be resent below the code that built it in three ways on Node:
 *
 * - fetch itself resends a request that drew a 421 (Misdirected Request), on
 *   a new connection: the Fetch standard's own retry;
 * - a global dispatcher the application installed may retry, such as
 *   undici's RetryAgent;
 * - a layer inside undici's own Agent may keep the options to resend them,
 *   as undici's retry interceptor does.
 *
 * So a request that carries a report goes through a dispatcher of its own.
 * The report goes out only on the first attempt fetch dispatches, and only
 * through undici's own Agent; the headers that attempt carries are a copy
 * from which the report is removed as soon as it has been read, so a layer
 * that kept them to resend finds no report in them. Any other attempt, and
 * any other global dispatcher, gets the request without the report: it may
 * be lost, never sent twice.
 *
 * What this cannot see is resend code the application wrote into its own
 * transport: an interceptor or Agent factory of its own that copies the
 * headers and resends from the copy, or a fetch wrapper that retries with a
 * fresh init. undici's own retry handler keeps the options it was handed, and
 * a wrapper that reuses the init reuses this dispatcher, which strips the
 * second attempt. Detecting a custom
 * factory would mean reading undici's private fields, and would still leave
 * the fetch wrapper, so the boundary is documented instead (README,
 * Telemetry).
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

function isDispatcher(value: unknown): value is Dispatcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'dispatch') === 'function'
  );
}

/** The dispatcher in one of undici's global slots, if what is there is one. */
function slot(key: symbol): Dispatcher | undefined {
  const value: unknown = Reflect.get(globalThis, key);
  return isDispatcher(value) ? value : undefined;
}

/** The dispatcher Node's fetch would use, for a handler of the API it passes. */
function globalDispatcher(handler: object): Dispatcher | undefined {
  return ('onRequestStart' in handler && slot(CURRENT)) || slot(LEGACY);
}

/**
 * undici's own Agent, whose clients resend no request they may have
 * delivered: they requeue only requests not yet written. Anything else, a
 * RetryAgent or a dispatcher the application built, may resend below this.
 */
function deliversOnce(dispatcher: Dispatcher): boolean {
  return dispatcher.constructor?.name === 'Agent';
}

/** A copy of the headers fetch dispatches: the plain object undici 6 to 8 build. */
function copyOf(headers: unknown): Record<string, unknown> {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new Error('cachekit: cannot read the headers of a request carrying a latency report');
  }
  return { ...headers };
}

function dropReport(headers: Record<string, unknown>): Record<string, unknown> {
  for (const name of Object.keys(headers)) {
    if (REPORT_HEADER.test(name)) delete headers[name];
  }
  return headers;
}

/**
 * A fetch `dispatcher` for one request that carries a latency report, or
 * undefined while there is no global dispatcher to hand to: the report then
 * waits for a later request.
 */
export function oneAttemptDispatcher(): Dispatcher | undefined {
  // Node loads undici on the first use of fetch or one of its classes, and
  // undici sets its global dispatcher as it loads.
  if (slot(LEGACY) === undefined) void globalThis.Headers;
  if (slot(LEGACY) === undefined && slot(CURRENT) === undefined) return undefined;
  let dispatched = false;
  return {
    dispatch(options, handler) {
      const target = globalDispatcher(handler);
      if (target === undefined) throw new Error('cachekit: no global dispatcher');
      const headers = copyOf(options.headers);
      if (dispatched || !deliversOnce(target)) {
        dispatched = true;
        return target.dispatch({ ...options, headers: dropReport(headers) }, handler);
      }
      dispatched = true;
      try {
        return target.dispatch({ ...options, headers }, handler);
      } finally {
        // The attempt has read them by now, or, if it was queued, will be sent
        // without the report.
        dropReport(headers);
      }
    },
  };
}

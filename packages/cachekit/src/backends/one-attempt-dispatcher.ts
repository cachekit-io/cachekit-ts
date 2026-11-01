/**
 * A latency report rides one attempt (protocol spec/saas-api.md, API-86), and
 * on Node a request can be resent below the code that built it:
 *
 * - fetch itself resends a request that drew a 421 (Misdirected Request), on
 *   a new connection: the Fetch standard's own retry;
 * - a global dispatcher the application installed may retry, such as
 *   undici's RetryAgent or an Agent composed with its retry interceptor;
 * - a layer inside an Agent, from a factory of the application's, may keep
 *   the options to resend them, as undici's retry interceptor does.
 *
 * So a report is taken only while the global dispatcher Node's fetch reads is
 * exactly undici's Agent, whose clients resend no request they may have
 * delivered: they requeue only requests not yet written. Any other global
 * dispatcher, composed or not, leaves the report waiting for a later request.
 * A request that carries one goes through a dispatcher of its own: the
 * report rides the first attempt, in a copy of the headers from which it is
 * removed as soon as dispatch returns, so a layer that kept the options to
 * resend them finds no report in them, and any later attempt fetch makes
 * gets the request without it.
 *
 * Two limits, documented in the README's Telemetry section. An Agent created
 * with a `connections` limit queues a request while every connection is
 * busy, and a queued first attempt goes without the report, which is lost:
 * reports from a saturated pool are dropped, never sent twice. And this
 * cannot see resend code the application wrote into its own transport: an
 * interceptor or factory that copies the headers and resends from its copy,
 * or a fetch wrapper that retries with a fresh init. A wrapper that spreads
 * the init over a `dispatcher` of its own, such as a proxy, has it replaced
 * by this one on a request that carries a report, which then goes straight
 * to the configured API. A wrapper that reuses the init reuses this dispatcher, which strips the
 * second attempt. Detecting a custom factory would mean reading undici's
 * private fields, and would still leave the fetch wrapper.
 *
 * Node keeps undici's global dispatcher under the symbols undici registers it
 * with. The fetch of undici 6 and 7 reads the first and passes handlers of the
 * older API (onConnect); undici 8's reads the second and passes onRequestStart
 * handlers, and its first holds an adapter for the older API. Elsewhere there
 * is no undici, and nothing here is used: only Node times L1 hits.
 */

/** The parts of undici's Dispatcher that fetch uses. */
interface Dispatcher {
  dispatch(options: { headers?: unknown }, handler: object): boolean;
  readonly isMockActive?: unknown;
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

/** The slot for a handler: onRequestStart handlers go to the second only. */
function slotFor(handler: object): symbol {
  return 'onRequestStart' in handler ? CURRENT : LEGACY;
}

/**
 * Exactly undici's Agent, as constructed: not a RetryAgent or a MockAgent,
 * and not composed with interceptors. undici 6's compose() returns a
 * ComposedDispatcher; undici 7 and 8's returns a proxy of the Agent that
 * answers to its name but swaps in another dispatch, as does an instance
 * whose dispatch was replaced.
 */
function deliversOnce(dispatcher: Dispatcher): boolean {
  const prototype: unknown = Object.getPrototypeOf(dispatcher);
  return (
    dispatcher.constructor?.name === 'Agent' &&
    typeof prototype === 'object' &&
    prototype !== null &&
    Reflect.get(dispatcher, 'dispatch') === Reflect.get(prototype, 'dispatch')
  );
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

function nodeUndiciVersion(): unknown {
  return typeof process !== 'undefined' ? process.versions?.undici : undefined;
}

/**
 * A fetch `dispatcher` for one request that carries a latency report, or
 * undefined, and the report waits, unless the global dispatcher Node's fetch
 * reads is undici's Agent. `undiciVersion` is the undici Node bundles, which
 * decides the slot its fetch reads; tests pass one.
 */
export function oneAttemptDispatcher(
  undiciVersion: unknown = nodeUndiciVersion()
): Dispatcher | undefined {
  if (typeof undiciVersion !== 'string') return undefined;
  const key = Number.parseInt(undiciVersion, 10) >= 8 ? CURRENT : LEGACY;
  // Node loads undici on the first use of fetch or one of its classes, and
  // undici fills its slots as it loads.
  if (slot(key) === undefined) void globalThis.Headers;
  const target = slot(key);
  if (target === undefined || !deliversOnce(target)) return undefined;
  let dispatched = false;
  return {
    // Node's fetch picks the request body by this (undici 6 to 8).
    get isMockActive(): unknown {
      return target.isMockActive;
    },
    dispatch(options, handler) {
      const headers = copyOf(options.headers);
      const own = slotFor(handler) === key;
      if (dispatched || !own) {
        dispatched = true;
        // A handler of the other API comes from another fetch than Node's
        // own: it goes to the slot that fetch reads, without the report.
        const to = own ? target : slot(slotFor(handler));
        if (to === undefined) throw new Error('cachekit: no global dispatcher for this request');
        return to.dispatch({ ...options, headers: dropReport(headers) }, handler);
      }
      dispatched = true;
      try {
        return target.dispatch({ ...options, headers }, handler);
      } finally {
        // The attempt has read them by now, or, if a full pool queued it,
        // will go without the report.
        dropReport(headers);
      }
    },
  };
}

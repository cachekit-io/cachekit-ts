/**
 * A latency report rides one attempt (protocol spec/saas-api.md, API-86), and
 * on Node a request can be resent below the code that built it:
 *
 * - fetch itself resends a request that drew a 421 (Misdirected Request), on
 *   a new connection: the Fetch standard's own retry;
 * - a global dispatcher the application installed may retry, such as
 *   undici's RetryAgent or an Agent composed with its retry interceptor;
 * - a layer inside an Agent, from a factory of the application's, may keep
 *   the options to resend them, as undici's retry interceptor does;
 * - an HTTP/1.1 client with pipelining on writes a request behind a running
 *   one, and when the connection drops it fails the head and writes the rest
 *   again on a new one;
 * - undici 6's HTTP/2 client, when any stream ends, puts every other stream
 *   still in flight back in its queue and writes it again, whatever its
 *   idempotency. That takes an Agent created with `allowH2` and `pipelining`
 *   above 1: a client's default pipelining of 1 runs one stream at a time.
 *
 * So a report is sent only through exactly undici's Agent, and only on the
 * first attempt fetch dispatches. That attempt is not idempotent, so a client
 * never pipelines it behind a running request: it is always the head, and a
 * head whose connection drops fails rather than being written again. Its
 * headers are a copy from which the report is removed as soon as dispatch
 * returns, so a layer that kept the options to resend them finds no report.
 * Any later attempt, and any other dispatcher, gets the request without it.
 *
 * Over HTTP/2, undici 8 replays only a stream the server refused or, after
 * GOAWAY, never processed: an attempt known not to have been delivered, which
 * the spec allows. undici 7's GOAWAY handler requeues every stream behind the
 * head, but its client never runs a non-idempotent request beside another, so
 * the one that carries a report is the head, and fails. undici 6 and 7 share
 * the first slot, and an Agent there gets a report only while its options say
 * HTTP/2 is off (`allowH2`, off by default in both); options it cannot read
 * count as on. That reads the Agent's private options, under the symbol undici
 * 6 to 8 all describe as 'options'. Detecting an Agent's custom factory the
 * same way would still leave a retrying fetch wrapper, so what this cannot
 * see, and when a report is lost, is in the README's Telemetry section.
 *
 * Node keeps undici's global dispatcher under the symbols undici registers it
 * with. The fetch of undici 6 and 7 reads the first and passes handlers of the
 * older API (onConnect); undici 8's reads the second and passes onRequestStart
 * handlers, and its first holds an adapter for the older API. Elsewhere there
 * is no undici, and nothing here is used: only Node times L1 hits.
 */

/** The part of undici's Dispatcher that fetch uses. */
interface Dispatcher {
  dispatch(options: { headers?: unknown; idempotent?: boolean }, handler: object): boolean;
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

/** False unless the Agent's private options say HTTP/2 is off. */
function http1Only(agent: Dispatcher): boolean {
  const key = Object.getOwnPropertySymbols(agent).find(
    (symbol) => symbol.description === 'options'
  );
  const options: unknown = key === undefined ? undefined : Reflect.get(agent, key);
  return (
    typeof options === 'object' && options !== null && Reflect.get(options, 'allowH2') !== true
  );
}

/** Whether a report may go through `dispatcher`, in the global slot `key`. */
function carriesOnce(dispatcher: Dispatcher, key: symbol): boolean {
  return deliversOnce(dispatcher) && (key !== LEGACY || http1Only(dispatcher));
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
  if (target === undefined || !carriesOnce(target, key)) return undefined;
  let dispatched = false;
  return {
    dispatch(options, handler) {
      // A handler of the other API comes from a fetch other than Node's own,
      // such as npm undici's: it goes to the slot that fetch reads.
      const handlerSlot = slotFor(handler);
      const to = handlerSlot === key ? target : slot(handlerSlot);
      if (to === undefined) throw new Error('cachekit: no global dispatcher for this request');
      const headers = copyOf(options.headers);
      const first = !dispatched;
      dispatched = true;
      if (!first || !carriesOnce(to, handlerSlot)) {
        return to.dispatch({ ...options, headers: dropReport(headers) }, handler);
      }
      try {
        return to.dispatch({ ...options, headers, idempotent: false }, handler);
      } finally {
        // The attempt has read them by now, or, if a full pool queued it,
        // will go without the report.
        dropReport(headers);
      }
    },
  };
}

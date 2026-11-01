/**
 * A latency report rides one attempt (protocol spec/saas-api.md, API-86), and
 * on Node a request can be resent below the code that built it: by fetch
 * itself after a 421 (the Fetch standard's own retry), by a retrying global
 * dispatcher such as undici's RetryAgent, by a retry layer inside an Agent, by
 * an HTTP/1.1 client that pipelines and loses its connection, or by undici
 * 6's HTTP/2 client, which writes every stream still in flight again when any
 * one ends.
 *
 * So a report is sent only through an Agent exactly as `new Agent()` builds
 * it, which Node's own default is: every option left at its default and the
 * default factory. Such an Agent neither retries nor pipelines; over HTTP/2,
 * which only undici 8 turns on by default, it replays only a stream the
 * server refused or, after GOAWAY, never processed, which the spec allows.
 * Any other dispatcher, and an Agent with any option set, leaves the report
 * waiting: a report may be lost, never sent twice.
 *
 * The report rides only the first attempt fetch dispatches, marked not
 * idempotent so that no client could pipeline it, and in a copy of the
 * headers from which it is removed as soon as dispatch returns. Any later
 * attempt gets the request without it. What this cannot see, such as a fetch
 * wrapper that retries, is in the README's Telemetry section.
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

/** An own field of `agent` under a symbol described `name`, as undici 6 to 8 keep them. */
function privateField(agent: object, name: string): unknown {
  const key = Object.getOwnPropertySymbols(agent).find((symbol) => symbol.description === name);
  return key === undefined ? undefined : Reflect.get(agent, key);
}

/**
 * Exactly as `new Agent()` builds it. The class is undici's Agent, and its
 * dispatch is its prototype's: not a RetryAgent or a MockAgent, nor the proxy
 * that compose() returns in undici 7 and 8 (undici 6's is a ComposedDispatcher).
 * Its options, under the symbol described 'options', are all undefined but
 * `maxOrigins: Infinity` (undici 7 and 8), and its factory, under 'factory',
 * is undici's `defaultFactory`. Any option set fails this, an HTTP/2 or
 * pipelining one among them, as does undici moving either field.
 */
function deliversOnce(dispatcher: Dispatcher): boolean {
  const prototype: unknown = Object.getPrototypeOf(dispatcher);
  const options = privateField(dispatcher, 'options');
  const factory = privateField(dispatcher, 'factory');
  return (
    dispatcher.constructor?.name === 'Agent' &&
    typeof prototype === 'object' &&
    prototype !== null &&
    Reflect.get(dispatcher, 'dispatch') === Reflect.get(prototype, 'dispatch') &&
    typeof factory === 'function' &&
    factory.name === 'defaultFactory' &&
    typeof options === 'object' &&
    options !== null &&
    Object.entries(options).every(
      ([name, value]) => value === undefined || (name === 'maxOrigins' && value === Infinity)
    )
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
 * reads is an Agent built with defaults. `undiciVersion` is the undici Node
 * bundles, which decides the slot its fetch reads; tests pass one.
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
    dispatch(options, handler) {
      // A handler of the other API comes from a fetch other than Node's own,
      // such as npm undici's: it goes to the slot that fetch reads.
      const handlerSlot = slotFor(handler);
      const own = handlerSlot === key;
      const to = own ? target : slot(handlerSlot);
      if (to === undefined) throw new Error('cachekit: no global dispatcher for this request');
      const headers = copyOf(options.headers);
      const first = !dispatched;
      dispatched = true;
      if (!first || !(own || deliversOnce(to))) {
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

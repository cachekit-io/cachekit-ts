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
 * Any other dispatcher, a subclass of Agent among them, an Agent with any
 * option set, and an undici 6 Agent whose interceptors were replaced leave
 * the report waiting: a report may be lost, never sent twice.
 *
 * The report rides only the first attempt fetch dispatches, in a copy of the
 * headers; any later attempt gets the request without it. Two more guards are
 * defence in depth, against what an Agent built with defaults does not do
 * today: the attempt is marked not idempotent, against a future default that
 * pipelines more than one request, and the report is removed from the copy as
 * soon as dispatch returns, against a layer that keeps the options to resend
 * them. That removal is also what drops the report of a request a full pool
 * queues. What this cannot see, such as a fetch wrapper that retries, is in
 * the README's Telemetry section.
 *
 * Node keeps undici's global dispatcher under the symbols undici registers it
 * with. The fetch of undici 6 and 7 reads the first and passes handlers of the
 * older API (onConnect); undici 8's reads the second and passes onRequestStart
 * handlers, and its first holds an adapter for the older API. Elsewhere there
 * is no undici, and nothing here is used: only Node times L1 hits.
 */
import { logError } from '../logger.js';

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

/** The names of the classes `prototype`'s class extends, nearest first. */
function superclasses(prototype: object): string[] {
  const names: string[] = [];
  let above: unknown = Object.getPrototypeOf(prototype);
  while (typeof above === 'object' && above !== null) {
    const constructor: unknown = Reflect.get(above, 'constructor');
    names.push(typeof constructor === 'function' ? constructor.name : '');
    above = Object.getPrototypeOf(above);
  }
  return names;
}

/** A function's source text, read without calling anything it overrides. */
function sourceOf(value: unknown): string | undefined {
  return typeof value === 'function' ? Function.prototype.toString.call(value) : undefined;
}

/** Per Agent class, the source of the one interceptor its undici 6 constructor makes. */
const builtInterceptor = new WeakMap<object, string | undefined>();

function builtInterceptorOf(agent: object): string | undefined {
  const Agent = agent.constructor;
  if (!builtInterceptor.has(Agent)) {
    let source: string | undefined;
    try {
      // What a constructor returns is always an object.
      const interceptors = privateField(Reflect.construct(Agent, []), 'dispatch interceptors');
      source = Array.isArray(interceptors) ? sourceOf(interceptors[0]) : undefined;
    } catch (error) {
      // Once per class: every Agent of it is refused, and its reports wait.
      logError(
        `[cachekit] cannot build a fresh ${Agent.name} to check an Agent's interceptors against: ` +
          'no latency report is sent through it',
        error
      );
      source = undefined;
    }
    builtInterceptor.set(Agent, source);
  }
  return builtInterceptor.get(Agent);
}

/**
 * Undici 6 composes an Agent's dispatch, on its first, from the interceptors
 * under the symbol described 'dispatch interceptors', and keeps the result
 * under 'Intercepted Dispatch'. Its public `interceptors` setter replaces them
 * without touching the options, and one that resends from a copy of the
 * headers would send the report twice. An Agent built with defaults holds one:
 * the redirect interceptor its constructor makes, the same code for every
 * Agent of the class, and has composed no other. Undici 7 and 8 keep neither.
 */
function interceptorsAsBuilt(agent: object): boolean {
  const interceptors = privateField(agent, 'dispatch interceptors');
  const composed = sourceOf(privateField(agent, 'Intercepted Dispatch'));
  if (interceptors === undefined && composed === undefined) return true;
  const built = builtInterceptorOf(agent);
  return (
    built !== undefined &&
    Array.isArray(interceptors) &&
    interceptors.length === 1 &&
    sourceOf(interceptors[0]) === built &&
    // What the redirect interceptor returns is a function in its own source.
    (composed === undefined || built.includes(composed))
  );
}

/**
 * Exactly as `new Agent()` builds it. The class is undici's Agent, which
 * extends undici's DispatcherBase directly (Node 22, 24 and 26), and no class
 * above it is named Agent: a subclass of a genuine Agent, whatever the names
 * between, has undici's Agent above it, and its code could resend. Its
 * dispatch is its prototype's: not a RetryAgent or a MockAgent, nor the proxy
 * that compose() returns in undici 7 and 8 (undici 6's is a ComposedDispatcher).
 * Its options, under the symbol described 'options', are all undefined but
 * `maxOrigins: Infinity` (undici 7 and 8), and its factory, under 'factory',
 * is undici's `defaultFactory`. Any option set fails this, an HTTP/2 or
 * pipelining one among them, but undici 6's `maxRedirections`, which it keeps
 * apart: harmless, as fetch dispatches with `maxRedirections: 0`. So do
 * undici 6 interceptors other than those it was built with (see
 * interceptorsAsBuilt). Undici moving any of these fails it too.
 */
function deliversOnce(dispatcher: Dispatcher): boolean {
  const prototype: unknown = Object.getPrototypeOf(dispatcher);
  const options = privateField(dispatcher, 'options');
  const factory = privateField(dispatcher, 'factory');
  if (typeof prototype !== 'object' || prototype === null) return false;
  const above = superclasses(prototype);
  return (
    dispatcher.constructor?.name === 'Agent' &&
    above[0] === 'DispatcherBase' &&
    !above.includes('Agent') &&
    Reflect.get(dispatcher, 'dispatch') === Reflect.get(prototype, 'dispatch') &&
    typeof factory === 'function' &&
    factory.name === 'defaultFactory' &&
    typeof options === 'object' &&
    options !== null &&
    Object.entries(options).every(
      ([name, value]) => value === undefined || (name === 'maxOrigins' && value === Infinity)
    ) &&
    interceptorsAsBuilt(dispatcher)
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
        // Defence in depth: an Agent built with defaults pipelines no request.
        return to.dispatch({ ...options, headers, idempotent: false }, handler);
      } finally {
        // The attempt has read them by now, unless a full pool queued it: then
        // this is what drops its report. Otherwise defence in depth.
        dropReport(headers);
      }
    },
  };
}

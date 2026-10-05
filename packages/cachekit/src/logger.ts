/**
 * Pluggable error logger for the library's internal error reporting.
 *
 * CacheKit never fails silently: background/fire-and-forget failures
 * (invalidation channel, SWR refresh, Redis connection events, metrics
 * initialization) are reported through this hook. The default sink is
 * `console.error`; applications can route these into their own logging
 * pipeline with {@link setLogger}.
 *
 * The logger may be `async`. CacheKit does not await it: if it throws or
 * its promise rejects, that failure and the original report go to
 * `console.error`, never back into the cache call or out as an unhandled
 * rejection.
 *
 * @example
 * ```typescript
 * import { setLogger } from '@cachekit-io/cachekit';
 *
 * setLogger((message, error) => myLogger.warn({ err: error }, message));
 * setLogger(null); // restore the console.error default
 * ```
 */
export type CachekitLogger = (message: string, error?: unknown) => void;

const defaultLogger: CachekitLogger = (message, error) => {
  const args = error === undefined ? [message] : [message, error];
  // eslint-disable-next-line no-console -- default sink; replaceable via setLogger
  console.error(...args);
};

let activeLogger: CachekitLogger = defaultLogger;

/** Replace the library-wide error logger. Pass `null` to restore the default. */
export function setLogger(logger: CachekitLogger | null): void {
  activeLogger = logger ?? defaultLogger;
}

/** Internal: report a library error through the active logger. Never throws
 * and never leaks a rejection — every call site is a fire-and-forget error
 * path (metrics, background refresh, invalidation), where a broken custom
 * logger propagating would become an unhandled rejection, which by default
 * terminates a Node process. Stays synchronous: an async logger's promise is
 * not awaited, only given a rejection handler. `CachekitLogger` returns
 * `void`, which TypeScript lets an async function satisfy, so the return
 * value is checked at runtime. */
export function logError(message: string, error?: unknown): void {
  try {
    const result: unknown = activeLogger(message, error);
    if (isPromiseLike(result)) {
      result.then(undefined, (loggerError: unknown) =>
        reportLoggerFailure('rejected', message, error, loggerError)
      );
    }
  } catch (loggerError) {
    reportLoggerFailure('threw', message, error, loggerError);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function';
}

function reportLoggerFailure(
  failure: 'threw' | 'rejected',
  message: string,
  error: unknown,
  loggerError: unknown
): void {
  // eslint-disable-next-line no-console -- last-resort sink when the active logger itself fails
  console.error(`[cachekit] logger ${failure}; original report:`, message, error, loggerError);
}

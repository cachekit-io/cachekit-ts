/**
 * Pluggable error logger for the library's internal error reporting.
 *
 * CacheKit never fails silently: background/fire-and-forget failures
 * (invalidation channel, SWR refresh, Redis connection events, metrics
 * initialization) are reported through this hook. The default sink is
 * `console.error`; applications can route these into their own logging
 * pipeline with {@link setLogger}.
 *
 * The logger may be `async`. If it throws or its promise rejects, CacheKit
 * reports that failure and the original message to `console.error`, never
 * to the caller and never as an unhandled rejection.
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

/** Internal: report a library error through the active logger. Never throws,
 * and never leaves an async logger's rejection unhandled — every call site is
 * a fire-and-forget error path (metrics, background refresh, invalidation),
 * where a broken custom logger propagating would become an unhandled
 * rejection. TypeScript accepts an `async` function as a {@link CachekitLogger}. */
export function logError(message: string, error?: unknown): void {
  const reportLoggerFailure = (loggerError: unknown): void => {
    // eslint-disable-next-line no-console -- last-resort sink when the active logger itself fails
    console.error('[cachekit] logger threw; original report:', message, error, loggerError);
  };
  try {
    // Promise.resolve adopts any thenable the logger returns, so its
    // rejection lands here instead of surfacing as an unhandled rejection.
    void Promise.resolve(activeLogger(message, error)).catch(reportLoggerFailure);
  } catch (loggerError) {
    reportLoggerFailure(loggerError);
  }
}

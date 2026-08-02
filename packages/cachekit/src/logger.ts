/**
 * Pluggable error logger for the library's internal error reporting.
 *
 * CacheKit never fails silently: background/fire-and-forget failures
 * (invalidation channel, SWR refresh, Redis connection events, metrics
 * initialization) are reported through this hook. The default sink is
 * `console.error`; applications can route these into their own logging
 * pipeline with {@link setLogger}.
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

/** Internal: report a library error through the active logger. Never throws —
 * every call site is a fire-and-forget error path (metrics, background
 * refresh, invalidation), where a broken custom logger propagating would
 * become an unhandled rejection. */
export function logError(message: string, error?: unknown): void {
  try {
    activeLogger(message, error);
  } catch (loggerError) {
    // eslint-disable-next-line no-console -- last-resort sink when the active logger itself throws
    console.error('[cachekit] logger threw; original report:', message, error, loggerError);
  }
}

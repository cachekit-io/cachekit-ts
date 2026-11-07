/**
 * Whether a value is a Promise or another thenable. The value-or-Promise paths
 * test this, not `instanceof Promise`: an async function returns the engine's
 * own Promise, which fails `instanceof` once a library (zone.js, Bluebird) has
 * replaced the global Promise, and a Promise taken for a value is never awaited.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

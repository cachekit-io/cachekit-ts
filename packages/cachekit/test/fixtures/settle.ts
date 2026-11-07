/**
 * Microtask turns until `promise` settles. A promise that was already settled
 * when it was handed back takes as many as `Promise.resolve()`: each await on
 * the way to a value costs one more.
 */
export async function turnsToSettle(promise: Promise<unknown>): Promise<number> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  let turns = 0;
  while (!settled) {
    await null;
    turns++;
  }
  return turns;
}

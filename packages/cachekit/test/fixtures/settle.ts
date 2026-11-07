const MAX_TURNS = 1_000;

/**
 * Microtask turns until `promise` settles. A promise that was already settled
 * when it was handed back takes as many as `Promise.resolve()`: each await on
 * the way to a value costs one more.
 *
 * Throws after MAX_TURNS: a promise that waits on a timer or I/O never settles
 * while this loop holds the microtask queue, and nor would the test's timeout.
 */
export async function turnsToSettle(promise: Promise<unknown>): Promise<number> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  let turns = 0;
  while (!settled) {
    if (turns === MAX_TURNS) {
      throw new Error(
        `still pending after ${MAX_TURNS} microtask turns: it waits on a timer or I/O`
      );
    }
    await null;
    turns++;
  }
  return turns;
}

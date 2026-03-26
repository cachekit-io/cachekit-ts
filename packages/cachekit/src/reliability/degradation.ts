/**
 * Execute operation with graceful degradation.
 *
 * If the operation fails, returns the fallback value instead of throwing.
 *
 * @param operation - Async operation that might fail
 * @param fallback - Value to return on failure
 * @returns Operation result or fallback value
 */
export async function withDegradation<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}

/**
 * Execute operation with graceful degradation, calling fallback function on error.
 *
 * @param operation - Async operation that might fail
 * @param fallbackFn - Function to call on failure
 * @returns Operation result or fallback function result
 */
export async function withDegradationFn<T>(
  operation: () => Promise<T>,
  fallbackFn: (error: Error) => T | Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return fallbackFn(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Graceful degradation behavior for cache operations.
 */
export const degradationBehaviors = {
  /** get() fails → return null (cache miss) */
  getFailsNull: <T>() =>
    withDegradation<T | null>(async () => {
      throw new Error();
    }, null),

  /** set() fails → skip silently */
  setFailsSkip: () =>
    withDegradation(async () => {
      throw new Error();
    }, undefined),

  /** wrap() fails → execute compute function */
  wrapFailsCompute: <T>(computeFn: () => Promise<T>) => computeFn,
} as const;

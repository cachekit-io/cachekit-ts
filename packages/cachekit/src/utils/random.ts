/**
 * Cryptographically secure random float in range [0, 1).
 *
 * Uses crypto.getRandomValues() instead of Math.random() for unpredictable timing jitter.
 * This prevents timing-based attacks where an attacker could predict cache refresh windows.
 *
 * m7 Fix: Replace Math.random() with secure PRNG for all timing-related randomness.
 */
export function secureRandomFloat(): number {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  // Convert to float in [0, 1) - divide by 2^32
  return array[0] / 0x100000000;
}

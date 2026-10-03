// Draws are taken from a pool refilled by one getRandomValues call per
// POOL_SIZE draws: allocating an array and calling the CSPRNG per draw was
// most of the cost of an L1 hit. Every value is still CSPRNG output and is
// used once. Filled on first use, not at import: Workers refuse randomness
// in global scope.
const POOL_SIZE = 256;
const pool = new Uint32Array(POOL_SIZE);
let next = POOL_SIZE;

/**
 * Cryptographically secure random float in range [0, 1).
 *
 * Uses crypto.getRandomValues() instead of Math.random() for unpredictable timing jitter.
 * This prevents timing-based attacks where an attacker could predict cache refresh windows.
 *
 * m7 Fix: Replace Math.random() with secure PRNG for all timing-related randomness.
 */
export function secureRandomFloat(): number {
  if (next === POOL_SIZE) {
    crypto.getRandomValues(pool);
    next = 0;
  }
  // Convert to float in [0, 1) - divide by 2^32
  return pool[next++] / 0x100000000;
}

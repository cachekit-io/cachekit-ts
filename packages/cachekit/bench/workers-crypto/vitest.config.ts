import workers from '../../vitest.workers.config.js';

// The Workers test lane's workerd setup (wasm module loading included),
// running only the A/B harness, with room for its timed loops.
export default {
  ...workers,
  test: {
    ...workers.test,
    include: ['bench/workers-crypto/ab.bench-workers.ts'],
    testTimeout: 600_000,
  },
};

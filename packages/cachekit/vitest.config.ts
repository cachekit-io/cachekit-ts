import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // test/workers runs inside workerd via vitest.workers.config.ts, not here
    exclude: ['test/integration/**', 'test/workers/**', 'node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
      exclude: [
        'node_modules',
        'dist',
        '**/*.test.ts',
        '**/types.ts',
        '**/*.config.ts',
        '**/index.ts',
        '**/cachekit-core-ts/**',
        '**/backends/redis.ts',
      ],
    },
    testTimeout: 10000,
  },
});

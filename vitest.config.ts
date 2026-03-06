import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [
      'test/integration/http-server.test.ts',
      'test/integration/api-endpoints.test.ts',
    ],
    globals: true,
    testTimeout: 30000,
    setupFiles: ['test/setup.ts'],
    coverage: {
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/index.ts', 'lib/bootstrap.ts'],
      thresholds: {
        branches: 75,
        functions: 75,
        lines: 80,
        statements: 80,
      },
    },
  },
});

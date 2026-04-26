import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '#tools': `${projectRoot}lib/tools`,
      '#workflows': `${projectRoot}lib/workflows`,
    },
    conditions: ['alembic-dev'],
  },
  test: {
    include: ['test/**/*.test.ts'],
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

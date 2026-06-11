import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['alembic-dev'],
  },
  test: {
    include: [
      'test/unit/Ao4NegativeSuites.test.ts',
      'test/unit/ProjectScopeRegistry.test.ts',
      'test/unit/ProjectScopeRouteAo4.test.ts',
    ],
    exclude: ['test/integration/**', 'test/e2e/**', '**/node_modules/**', '**/.git/**'],
    globals: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    teardownTimeout: 5_000,
    setupFiles: ['test/setup.ts'],
    coverage: {
      include: [
        'lib/http/middleware/validate.ts',
        'lib/http/routes/auth.ts',
        'lib/project-scope/ProjectScopeRegistry.ts',
      ],
      thresholds: {
        branches: 75,
        functions: 75,
        lines: 80,
        statements: 80,
      },
    },
  },
});

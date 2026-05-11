import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['test/unit/**/*.test.ts'],
      exclude: ['test/integration/**', 'test/e2e/**', '**/node_modules/**', '**/.git/**'],
      testTimeout: 10_000,
      hookTimeout: 10_000,
      teardownTimeout: 5_000,
    },
  })
);

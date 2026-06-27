import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Codex desktop 的受限 sandbox 不能稳定监听 127.0.0.1，也不能运行 macOS sandbox-exec。
// 保留完整 test:unit；这里只给 Codex 内部验证使用，排除权限型用例。
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['test/unit/**/*.test.ts'],
      exclude: [
        'test/integration/**',
        'test/e2e/**',
        '**/node_modules/**',
        '**/.git/**',
        'test/unit/SandboxNetworkProxy.test.ts',
      ],
      testTimeout: 10_000,
      hookTimeout: 10_000,
      teardownTimeout: 5_000,
    },
  })
);

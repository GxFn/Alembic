import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['alembic-dev'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    // 宿主恢复/构建测试还会启动子进程；限制外层并发，避免资源争抢被误判为业务超时。
    // 本地专项可用 --maxWorkers 覆盖；不改变测试范围或单例超时预算。
    maxWorkers: 4,
    testTimeout: 30000,
    // 2026-07-06 沙箱配套：test/setup.ts 给每个 worker 绑定一次性 ALEMBIC_HOME，
    // 集成测试的 AppRuntime 初始化改为在空沙箱全量跑 migrations——check 全链
    // （unit+integration+coverage 并发）下 30s hook 预算贴线超时。90s 覆盖
    // 高并发场景；单跑 integration 实测远低于此。
    hookTimeout: 90000,
    teardownTimeout: 10000,
    setupFiles: ['test/setup.ts'],
    coverage: {
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/index.ts', 'lib/Bootstrap.ts'],
      thresholds: {
        branches: 75,
        functions: 75,
        lines: 80,
        statements: 80,
      },
    },
  },
});

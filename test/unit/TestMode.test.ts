/**
 * test-mode.ts 单元测试
 *
 * 覆盖范围:
 *   - isTestMode() 环境变量开关
 *   - getTestModeConfig() 配置读取（维度过滤 + 默认终端能力档位）
 *   - applyTestDimensionFilter() 维度过滤（bootstrap / rescan 两种模式）
 *   - 终端配置：默认值、ALEMBIC_TERMINAL_TOOLSET 档位覆盖
 *   - 边界情况：空配置、不匹配的 ID、test mode 关闭时透传
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

const envBackup = { ...process.env };

afterEach(() => {
  process.env = { ...envBackup };
  vi.resetModules();
});

async function loadModule() {
  return await import('../../lib/shared/test-mode.js');
}

function makeDim(id: string, tierHint?: number) {
  return {
    id,
    label: `${id} Label`,
    guide: '',
    knowledgeTypes: ['best-practice'],
    tierHint,
  };
}

describe('test-mode', () => {
  describe('isTestMode', () => {
    test('returns false when ALEMBIC_TEST_MODE is not set', async () => {
      delete process.env.ALEMBIC_TEST_MODE;
      const { isTestMode } = await loadModule();
      expect(isTestMode()).toBe(false);
    });

    test('returns true when ALEMBIC_TEST_MODE=1', async () => {
      process.env.ALEMBIC_TEST_MODE = '1';
      const { isTestMode } = await loadModule();
      expect(isTestMode()).toBe(true);
    });

    test('returns true when ALEMBIC_TEST_MODE=true', async () => {
      process.env.ALEMBIC_TEST_MODE = 'true';
      const { isTestMode } = await loadModule();
      expect(isTestMode()).toBe(true);
    });

    test('returns false for other truthy-like values', async () => {
      process.env.ALEMBIC_TEST_MODE = 'yes';
      const { isTestMode } = await loadModule();
      expect(isTestMode()).toBe(false);
    });
  });

  describe('getTestModeConfig', () => {
    test('returns disabled config when test mode is off', async () => {
      delete process.env.ALEMBIC_TEST_MODE;
      const { getTestModeConfig } = await loadModule();
      const cfg = getTestModeConfig();
      expect(cfg.enabled).toBe(false);
      expect(cfg.bootstrapDims).toEqual([]);
      expect(cfg.rescanDims).toEqual([]);
    });

    test('parses comma-separated dimension IDs', async () => {
      process.env.ALEMBIC_TEST_MODE = '1';
      process.env.ALEMBIC_TEST_BOOTSTRAP_DIMS = 'architecture,coding-standards';
      process.env.ALEMBIC_TEST_RESCAN_DIMS = 'design-patterns, error-resilience';
      const { getTestModeConfig } = await loadModule();
      const cfg = getTestModeConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.bootstrapDims).toEqual(['architecture', 'coding-standards']);
      expect(cfg.rescanDims).toEqual(['design-patterns', 'error-resilience']);
    });

    test('handles empty dimension lists gracefully', async () => {
      process.env.ALEMBIC_TEST_MODE = '1';
      process.env.ALEMBIC_TEST_BOOTSTRAP_DIMS = '';
      const { getTestModeConfig } = await loadModule();
      const cfg = getTestModeConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.bootstrapDims).toEqual([]);
    });

    test('includes terminal-run as the default terminal capability', async () => {
      delete process.env.ALEMBIC_TEST_MODE;
      delete process.env.ALEMBIC_TERMINAL_TOOLSET;
      const { getTestModeConfig } = await loadModule();
      const cfg = getTestModeConfig();
      expect(cfg.terminal).toEqual({ enabled: true, toolset: 'terminal-run' });
    });

    test('respects ALEMBIC_TERMINAL_TOOLSET override', async () => {
      process.env.ALEMBIC_TERMINAL_TOOLSET = 'terminal-shell';
      const { getTestModeConfig } = await loadModule();
      const cfg = getTestModeConfig();
      expect(cfg.terminal).toEqual({ enabled: true, toolset: 'terminal-shell' });
    });

    test('allows explicit baseline terminal toolset override', async () => {
      process.env.ALEMBIC_TERMINAL_TOOLSET = 'baseline';
      const { getTestModeConfig } = await loadModule();
      const cfg = getTestModeConfig();
      expect(cfg.terminal).toEqual({ enabled: false, toolset: 'baseline' });
    });
  });

  describe('applyTestDimensionFilter', () => {
    const allDims = [
      makeDim('architecture', 1),
      makeDim('coding-standards', 2),
      makeDim('design-patterns', 2),
      makeDim('error-resilience', 3),
      makeDim('concurrency-async', 3),
    ];

    test('returns all dimensions when test mode is off', async () => {
      delete process.env.ALEMBIC_TEST_MODE;
      const { applyTestDimensionFilter } = await loadModule();
      const result = applyTestDimensionFilter(allDims, 'bootstrap');
      expect(result).toHaveLength(allDims.length);
      expect(result.map((d: { id: string }) => d.id)).toEqual(allDims.map((d) => d.id));
    });

    test('returns all dimensions when test mode is on but no dims configured', async () => {
      process.env.ALEMBIC_TEST_MODE = '1';
      delete process.env.ALEMBIC_TEST_BOOTSTRAP_DIMS;
      const { applyTestDimensionFilter } = await loadModule();
      const result = applyTestDimensionFilter(allDims, 'bootstrap');
      expect(result).toHaveLength(allDims.length);
    });

    test('filters bootstrap dimensions correctly', async () => {
      process.env.ALEMBIC_TEST_MODE = '1';
      process.env.ALEMBIC_TEST_BOOTSTRAP_DIMS = 'architecture,coding-standards';
      const { applyTestDimensionFilter } = await loadModule();
      const result = applyTestDimensionFilter(allDims, 'bootstrap');
      expect(result).toHaveLength(2);
      expect(result.map((d: { id: string }) => d.id)).toEqual(['architecture', 'coding-standards']);
    });

    test('filters rescan dimensions correctly', async () => {
      process.env.ALEMBIC_TEST_MODE = '1';
      process.env.ALEMBIC_TEST_RESCAN_DIMS = 'design-patterns,error-resilience';
      const { applyTestDimensionFilter } = await loadModule();
      const result = applyTestDimensionFilter(allDims, 'rescan');
      expect(result).toHaveLength(2);
      expect(result.map((d: { id: string }) => d.id)).toEqual([
        'design-patterns',
        'error-resilience',
      ]);
    });

    test('preserves tierHint on filtered dimensions', async () => {
      process.env.ALEMBIC_TEST_MODE = '1';
      process.env.ALEMBIC_TEST_BOOTSTRAP_DIMS = 'architecture,coding-standards';
      const { applyTestDimensionFilter } = await loadModule();
      const result = applyTestDimensionFilter(allDims, 'bootstrap');
      expect(result[0]).toMatchObject({ id: 'architecture', tierHint: 1 });
      expect(result[1]).toMatchObject({ id: 'coding-standards', tierHint: 2 });
    });

    test('returns empty array when configured dims match none', async () => {
      process.env.ALEMBIC_TEST_MODE = '1';
      process.env.ALEMBIC_TEST_BOOTSTRAP_DIMS = 'nonexistent-dim';
      const { applyTestDimensionFilter } = await loadModule();
      const result = applyTestDimensionFilter(allDims, 'bootstrap');
      expect(result).toHaveLength(0);
    });

    test('bootstrap filter does not affect rescan mode', async () => {
      process.env.ALEMBIC_TEST_MODE = '1';
      process.env.ALEMBIC_TEST_BOOTSTRAP_DIMS = 'architecture';
      delete process.env.ALEMBIC_TEST_RESCAN_DIMS;
      const { applyTestDimensionFilter } = await loadModule();
      const rescanResult = applyTestDimensionFilter(allDims, 'rescan');
      expect(rescanResult).toHaveLength(allDims.length);
    });

    test('cross-tier configuration for BiliDili scenario', async () => {
      process.env.ALEMBIC_TEST_MODE = '1';
      process.env.ALEMBIC_TEST_BOOTSTRAP_DIMS = 'architecture,coding-standards';
      process.env.ALEMBIC_TEST_RESCAN_DIMS = 'design-patterns,error-resilience';
      const { applyTestDimensionFilter } = await loadModule();

      const bootstrap = applyTestDimensionFilter(allDims, 'bootstrap');
      expect(
        bootstrap.map((d: { id: string; tierHint?: number }) => ({ id: d.id, tier: d.tierHint }))
      ).toEqual([
        { id: 'architecture', tier: 1 },
        { id: 'coding-standards', tier: 2 },
      ]);

      const rescan = applyTestDimensionFilter(allDims, 'rescan');
      expect(
        rescan.map((d: { id: string; tierHint?: number }) => ({ id: d.id, tier: d.tierHint }))
      ).toEqual([
        { id: 'design-patterns', tier: 2 },
        { id: 'error-resilience', tier: 3 },
      ]);
    });
  });
});

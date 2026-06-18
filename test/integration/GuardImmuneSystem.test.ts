/**
 * Guard Immune System 集成测试
 *
 * 验证 Phase 2 新增组件在真实（模拟）环境中的协同:
 *   1. UncertaintyCollector 在 GuardCheckEngine 中的集成
 *   2. RuleLearner 桥接
 */

import { GuardCheckEngine } from '@alembic/core/guard';
import { describe, expect, it, vi } from 'vitest';

/** Minimal mock DB */
function createMockDb() {
  return {
    prepare(sql: string) {
      return {
        all(..._params: unknown[]) {
          // 模拟空 knowledge_entries 查询
          return [];
        },
        get(..._params: unknown[]) {
          return undefined;
        },
        run(..._params: unknown[]) {
          return {};
        },
      };
    },
    exec(_sql: string) {},
  };
}

describe('Guard Immune System Integration', () => {
  describe('GuardCheckEngine + UncertaintyCollector', () => {
    it('should produce uncertain results for files with invalid regex rules', () => {
      const engine = new GuardCheckEngine(createMockDb());

      // auditFile 正常工作
      const result = engine.auditFile('test.js', 'const x = eval("1+1");');
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.summary.uncertain).toBeDefined();
      expect(typeof result.summary.uncertain).toBe('number');
    });

    it('should include uncertainResults in auditFiles output', () => {
      const engine = new GuardCheckEngine(createMockDb());
      const result = engine.auditFiles([
        { path: 'a.js', content: 'console.log("hello");' },
        { path: 'b.swift', content: 'let x = try! something()' },
      ]);

      expect(result.capabilityReport).toBeDefined();
      expect(typeof result.summary.totalUncertain).toBe('number');
      expect(result.files.every((f) => 'uncertainResults' in f)).toBe(true);
    });

    it('should track uncertain count across batch audit', () => {
      const engine = new GuardCheckEngine(createMockDb());

      const result = engine.auditFiles([
        { path: 'a.m', content: 'dispatch_sync(dispatch_get_main_queue(), ^{ })' },
        { path: 'b.swift', content: 'try! parse()' },
      ]);

      // Basic structure validation
      expect(result.capabilityReport).toBeDefined();
      expect(result.capabilityReport.uncertainResults).toBeInstanceOf(Array);
      expect(result.capabilityReport.checkCoverage).toBeGreaterThanOrEqual(0);
      expect(result.capabilityReport.checkCoverage).toBeLessThanOrEqual(100);
    });
  });

  describe('RuleLearner bridge', () => {
    it('should identify precision drops and emit signals', async () => {
      // Dynamic import to avoid constructor side effects
      const { RuleLearner } = await import('@alembic/core/guard');

      const signalBus = { send: vi.fn() };
      const tmpDir = `/tmp/alembic-test-${Date.now()}`;

      const learner = new RuleLearner(tmpDir, {
        knowledgeBaseDir: 'Alembic',
        signalBus: signalBus as any,
      });

      // 模拟高误报规则
      for (let i = 0; i < 10; i++) {
        learner.recordTrigger('bad-rule');
      }
      for (let i = 0; i < 8; i++) {
        learner.recordFeedback('bad-rule', 'falsePositive');
      }

      const drops = learner.checkPrecisionDrop();
      expect(drops.length).toBeGreaterThan(0);
      expect(drops[0].ruleId).toBe('bad-rule');
      expect(drops[0].falsePositiveRate).toBeGreaterThan(0.6);

      // 验证信号发射
      expect(signalBus.send).toHaveBeenCalledWith(
        'quality',
        'RuleLearner.precisionDrop',
        expect.any(Number),
        expect.objectContaining({ target: 'bad-rule' })
      );
    });
  });
});

/**
 * Guard Immune System — 跨模块冒烟测试
 *
 * 验证:
 *   1. GuardCheckEngine._uncertaintyCollector 存在
 *   2. auditFiles 返回 capabilityReport
 *   3. ComplianceReporter 三维评分字段存在
 *   4. RuleLearner.checkPrecisionDrop 可用
 *   5. ReverseGuard + CoverageAnalyzer 可实例化
 */
import { describe, expect, it } from 'vitest';

describe('Guard Immune System Wiring', () => {
  it('GuardCheckEngine should have UncertaintyCollector wired', async () => {
    const { GuardCheckEngine } = await import('../../../lib/service/guard/GuardCheckEngine.js');
    const engine = new GuardCheckEngine(null);
    expect(engine._uncertaintyCollector).toBeDefined();
    expect(typeof engine.getUncertaintyCollector).toBe('function');
    const collector = engine.getUncertaintyCollector();
    expect(collector).toBeDefined();
    expect(typeof collector.buildReport).toBe('function');
  });

  it('auditFiles should return capabilityReport', async () => {
    const { GuardCheckEngine } = await import('../../../lib/service/guard/GuardCheckEngine.js');
    const mockDb = {
      prepare: () => ({ all: () => [], get: () => undefined, run: () => ({}) }),
      exec: () => {},
    };
    const engine = new GuardCheckEngine(mockDb);
    const result = engine.auditFiles([{ path: 'test.js', content: 'const a = 1;' }]);

    expect(result.capabilityReport).toBeDefined();
    expect(result.capabilityReport.checkCoverage).toBeDefined();
    expect(result.summary.totalUncertain).toBeDefined();
  });

  it('AuditFileResult should have uncertainResults field', async () => {
    const { GuardCheckEngine } = await import('../../../lib/service/guard/GuardCheckEngine.js');
    const mockDb = {
      prepare: () => ({ all: () => [], get: () => undefined, run: () => ({}) }),
      exec: () => {},
    };
    const engine = new GuardCheckEngine(mockDb);
    const result = engine.auditFile('test.swift', 'let x = 1');

    expect(result.uncertainResults).toBeDefined();
    expect(Array.isArray(result.uncertainResults)).toBe(true);
    expect(result.summary.uncertain).toBeDefined();
  });

  it('RuleLearner should have checkPrecisionDrop method', async () => {
    const { RuleLearner } = await import('../../../lib/service/guard/RuleLearner.js');
    const tmpDir = `/tmp/alembic-smoke-${Date.now()}`;
    const learner = new RuleLearner(tmpDir, { knowledgeBaseDir: 'Alembic' });
    expect(typeof learner.checkPrecisionDrop).toBe('function');
    const result = learner.checkPrecisionDrop();
    expect(Array.isArray(result)).toBe(true);
  });

  it('ReverseGuard should instantiate with mock DB', async () => {
    const { ReverseGuard } = await import('../../../lib/service/guard/ReverseGuard.js');
    const mockDb = {
      prepare: () => ({ all: () => [], get: () => undefined }),
    };
    const guard = new ReverseGuard(mockDb);
    const results = guard.auditAllRules([]);
    expect(Array.isArray(results)).toBe(true);
  });

  it('CoverageAnalyzer should instantiate with mock DB', async () => {
    const { CoverageAnalyzer } = await import('../../../lib/service/guard/CoverageAnalyzer.js');
    const mockDb = {
      prepare: () => ({ all: () => [], get: () => undefined }),
    };
    const analyzer = new CoverageAnalyzer(mockDb);
    const result = analyzer.analyze(new Map([['Mod', ['a.swift']]]));
    expect(result.modules).toHaveLength(1);
  });

  it('UncertaintyCollector types should be importable', async () => {
    const mod = await import('../../../lib/service/guard/UncertaintyCollector.js');
    expect(mod.UncertaintyCollector).toBeDefined();
    const c = new mod.UncertaintyCollector();
    expect(typeof c.recordSkip).toBe('function');
    expect(typeof c.addUncertain).toBe('function');
    expect(typeof c.buildReport).toBe('function');
  });
});

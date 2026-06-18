/**
 * Guard Immune System — 跨模块冒烟测试
 *
 * 验证:
 *   1. GuardCheckEngine._uncertaintyCollector 存在
 *   2. auditFiles 返回 capabilityReport
 *   3. RuleLearner.checkPrecisionDrop 可用
 */
import { describe, expect, it } from 'vitest';

describe('Guard Immune System Wiring', () => {
  it('GuardCheckEngine should have UncertaintyCollector wired', async () => {
    const { GuardCheckEngine } = await import('@alembic/core/guard');
    const engine = new GuardCheckEngine(null);
    expect(engine._uncertaintyCollector).toBeDefined();
    expect(typeof engine.getUncertaintyCollector).toBe('function');
    const collector = engine.getUncertaintyCollector();
    expect(collector).toBeDefined();
    expect(typeof collector.buildReport).toBe('function');
  });

  it('auditFiles should return capabilityReport', async () => {
    const { GuardCheckEngine } = await import('@alembic/core/guard');
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
    const { GuardCheckEngine } = await import('@alembic/core/guard');
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
    const { RuleLearner } = await import('@alembic/core/guard');
    const tmpDir = `/tmp/alembic-smoke-${Date.now()}`;
    const learner = new RuleLearner(tmpDir, { knowledgeBaseDir: 'Alembic' });
    expect(typeof learner.checkPrecisionDrop).toBe('function');
    const result = learner.checkPrecisionDrop();
    expect(Array.isArray(result)).toBe(true);
  });

  it('UncertaintyCollector types should be importable', async () => {
    const mod = await import('@alembic/core/guard');
    expect(mod.UncertaintyCollector).toBeDefined();
    const c = new mod.UncertaintyCollector();
    expect(typeof c.recordSkip).toBe('function');
    expect(typeof c.addUncertain).toBe('function');
    expect(typeof c.buildReport).toBe('function');
  });
});

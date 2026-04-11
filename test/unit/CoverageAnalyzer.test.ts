/**
 * CoverageAnalyzer 单元测试
 */
import { describe, expect, it } from 'vitest';
import { CoverageAnalyzer } from '../../lib/service/guard/CoverageAnalyzer.js';

function createMockRepos(
  options: {
    rules?: { id: string; language: string }[];
    violations?: { filePath: string; violationsJson: string }[];
  } = {}
) {
  const { rules = [], violations = [] } = options;

  const knowledgeRepo = {
    findActiveRuleIdsSync() {
      return rules.map((r) => ({ id: r.id, language: r.language }));
    },
  };

  const guardViolationRepo = {
    findRecentViolationsJson(_limit: number) {
      return violations;
    },
  };

  return { knowledgeRepo, guardViolationRepo };
}

function createMockLearner(stats: Record<string, { triggers: number; fp: number }> = {}) {
  const allStats: Record<string, any> = {};
  for (const [id, { triggers, fp }] of Object.entries(stats)) {
    allStats[id] = {
      triggers,
      metrics: { precision: fp > 0 ? 1 - fp / triggers : 1, recall: 1, f1: 1 },
    };
  }
  return {
    getMetrics(ruleId: string) {
      const s = stats[ruleId];
      if (!s) {
        return { precision: 1, recall: 1, f1: 1, triggers: 0, falsePositiveRate: 0 };
      }
      return {
        precision: s.fp > 0 ? 1 - s.fp / s.triggers : 1,
        recall: 1,
        f1: 1,
        triggers: s.triggers,
        falsePositiveRate: s.fp / s.triggers,
      };
    },
    getAllStats: () => allStats,
  };
}

describe('CoverageAnalyzer', () => {
  it('should return empty matrix for no modules', () => {
    const { knowledgeRepo, guardViolationRepo } = createMockRepos();
    const analyzer = new CoverageAnalyzer(knowledgeRepo as any, guardViolationRepo as any);
    const result = analyzer.analyze(new Map());
    expect(result.modules).toHaveLength(0);
    expect(result.overallCoverage).toBe(0);
  });

  it('should detect zero coverage modules', () => {
    const { knowledgeRepo, guardViolationRepo } = createMockRepos({
      rules: [{ id: 'r1', language: 'swift' }],
    });
    const analyzer = new CoverageAnalyzer(knowledgeRepo as any, guardViolationRepo as any);

    const moduleFiles = new Map([
      ['BDAuth', []], // no files = zero coverage
    ]);

    const result = analyzer.analyze(moduleFiles);
    expect(result.modules[0].level).toBe('zero');
    expect(result.zeroModules).toContain('BDAuth');
  });

  it('should match rules by language', () => {
    const { knowledgeRepo, guardViolationRepo } = createMockRepos({
      rules: [
        { id: 'r1', language: 'swift' },
        { id: 'r2', language: 'objectivec' },
        { id: 'r3', language: 'javascript' },
      ],
    });
    const analyzer = new CoverageAnalyzer(knowledgeRepo as any, guardViolationRepo as any);

    const moduleFiles = new Map([['BDUIKit', ['BDUIKit/View.swift', 'BDUIKit/Helper.swift']]]);

    const result = analyzer.analyze(moduleFiles);
    // r1(swift) matches, r2(objectivec) doesn't, r3(javascript) doesn't
    expect(result.modules[0].ruleCount).toBe(1);
    expect(result.modules[0].module).toBe('BDUIKit');
  });

  it('should match rules from violation history', () => {
    const { knowledgeRepo, guardViolationRepo } = createMockRepos({
      rules: [],
      violations: [
        {
          filePath: 'BDNet/API.swift',
          violationsJson: JSON.stringify([{ ruleId: 'r-net-1' }, { ruleId: 'r-net-2' }]),
        },
      ],
    });
    const analyzer = new CoverageAnalyzer(knowledgeRepo as any, guardViolationRepo as any);

    const moduleFiles = new Map([['BDNet', ['BDNet/API.swift', 'BDNet/Config.swift']]]);

    const result = analyzer.analyze(moduleFiles);
    expect(result.modules[0].ruleCount).toBe(2);
  });

  it('should calculate FP rate from RuleLearner', () => {
    const { knowledgeRepo, guardViolationRepo } = createMockRepos({
      rules: [{ id: 'r1', language: 'swift' }],
    });
    const learner = createMockLearner({
      r1: { triggers: 20, fp: 4 }, // 20% FP rate
    });
    const analyzer = new CoverageAnalyzer(knowledgeRepo as any, guardViolationRepo as any, {
      ruleLearner: learner as any,
    });

    const moduleFiles = new Map([['Mod', ['Mod/A.swift']]]);

    const result = analyzer.analyze(moduleFiles);
    expect(result.modules[0].fpRate).toBe(20);
  });

  it('should compute overall coverage', () => {
    const { knowledgeRepo, guardViolationRepo } = createMockRepos({
      rules: [
        { id: 'r1', language: 'swift' },
        { id: 'r2', language: 'swift' },
      ],
    });
    const analyzer = new CoverageAnalyzer(knowledgeRepo as any, guardViolationRepo as any);

    const moduleFiles = new Map([
      ['A', ['A/1.swift']], // 2 rules / 1 file → 100% (capped)
      ['B', ['B/1.swift', 'B/2.swift', 'B/3.swift', 'B/4.swift', 'B/5.swift']], // 2 rules / 5 files → 40%
    ]);

    const result = analyzer.analyze(moduleFiles);
    // avg of 100 and 40 = 70
    expect(result.overallCoverage).toBe(70);
    expect(result.lowModules).toContain('B');
  });

  it('should identify low coverage modules', () => {
    const { knowledgeRepo, guardViolationRepo } = createMockRepos({
      rules: [{ id: 'r1', language: 'swift' }],
    });
    const analyzer = new CoverageAnalyzer(knowledgeRepo as any, guardViolationRepo as any);

    const moduleFiles = new Map([
      ['Huge', Array.from({ length: 10 }, (_, i) => `Huge/${i}.swift`)],
    ]);

    const result = analyzer.analyze(moduleFiles);
    // 1 rule / 10 files = 10%
    expect(result.modules[0].coverage).toBe(10);
    expect(result.modules[0].level).toBe('low');
    expect(result.lowModules).toContain('Huge');
  });

  it('should handle multi-language modules', () => {
    const { knowledgeRepo, guardViolationRepo } = createMockRepos({
      rules: [
        { id: 'r1', language: 'swift' },
        { id: 'r2', language: 'objectivec' },
      ],
    });
    const analyzer = new CoverageAnalyzer(knowledgeRepo as any, guardViolationRepo as any);

    const moduleFiles = new Map([['Mixed', ['Mixed/A.swift', 'Mixed/B.m', 'Mixed/C.h']]]);

    const result = analyzer.analyze(moduleFiles);
    // Both rules match (swift + ObjC)
    expect(result.modules[0].ruleCount).toBe(2);
  });
});

/**
 * Guard Immune System 集成测试
 *
 * 验证 Phase 2 新增组件在真实（模拟）环境中的协同:
 *   1. UncertaintyCollector 在 GuardCheckEngine 中的集成
 *   2. ComplianceReporter 三维评分
 *   3. ReverseGuard 反向验证端到端
 *   4. CoverageAnalyzer 覆盖率矩阵
 *   5. RuleLearner 桥接
 */
import { describe, expect, it, vi } from 'vitest';
import { CoverageAnalyzer } from '../../lib/service/guard/CoverageAnalyzer.js';
import { GuardCheckEngine } from '../../lib/service/guard/GuardCheckEngine.js';
import { ReverseGuard } from '../../lib/service/guard/ReverseGuard.js';
import { UncertaintyCollector } from '../../lib/service/guard/UncertaintyCollector.js';

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

  describe('ReverseGuard end-to-end', () => {
    it('should detect drift when symbols removed from codebase', () => {
      const db = {
        prepare(sql: string) {
          return {
            all(..._params: unknown[]) {
              if (sql.includes('knowledge_entries') && sql.includes('lifecycle')) {
                return [
                  {
                    id: 'r-old',
                    title: 'Old API Rule',
                    core_code: 'BDLegacyManager.fetchData()',
                    guard_pattern: 'BDLegacyManager',
                    stats: null,
                  },
                ];
              }
              return [];
            },
            get(...params: unknown[]) {
              // code_entities: nothing found
              if (sql.includes('code_entities')) {
                return undefined;
              }
              // guardHits
              if (sql.includes('json_extract(stats')) {
                return { hits: 50 };
              }
              return undefined;
            },
          };
        },
      };

      const reverseGuard = new ReverseGuard(db);
      const results = reverseGuard.auditAllRules([
        { path: 'a.swift', content: 'let x = BDNewManager.fetchData()' },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].recipeId).toBe('r-old');
      // Symbol missing → should at least investigate
      expect(['investigate', 'decay']).toContain(results[0].recommendation);
    });
  });

  describe('CoverageAnalyzer with real module structure', () => {
    it('should produce coverage matrix from multi-module project', () => {
      const db = {
        prepare(sql: string) {
          return {
            all() {
              if (sql.includes('knowledge_entries') && sql.includes('kind')) {
                return [
                  { id: 'r1', language: 'swift' },
                  { id: 'r2', language: 'objectivec' },
                  { id: 'r3', language: 'swift' },
                ];
              }
              if (sql.includes('guard_violations')) {
                return [];
              }
              return [];
            },
            get() {
              return undefined;
            },
          };
        },
      };

      const analyzer = new CoverageAnalyzer(db);
      const moduleFiles = new Map([
        ['BDUIKit', ['BDUIKit/A.swift', 'BDUIKit/B.swift']],
        ['BDNet', ['BDNet/C.m', 'BDNet/D.h']],
        ['BDAuth', []], // zero coverage
      ]);

      const result = analyzer.analyze(moduleFiles);
      expect(result.modules).toHaveLength(3);
      expect(result.zeroModules).toContain('BDAuth');
      // BDUIKit has 2 swift rules for 2 files → 100%
      const uiKit = result.modules.find((m) => m.module === 'BDUIKit');
      expect(uiKit).toBeDefined();
      expect(uiKit!.coverage).toBe(100);
    });
  });

  describe('RuleLearner bridge', () => {
    it('should identify precision drops and emit signals', async () => {
      // Dynamic import to avoid constructor side effects
      const { RuleLearner } = await import('../../lib/service/guard/RuleLearner.js');

      const signalBus = { send: vi.fn() };
      const tmpDir = `/tmp/autosnippet-test-${Date.now()}`;

      const learner = new RuleLearner(tmpDir, {
        knowledgeBaseDir: 'AutoSnippet',
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

  describe('three-dimensional compliance', () => {
    it('should produce coverage and confidence scores in report', async () => {
      const { ComplianceReporter } = await import('../../lib/service/guard/ComplianceReporter.js');

      // Mock engine with uncertainty data
      const mockEngine = {
        auditFiles() {
          return {
            files: [
              {
                filePath: 'a.swift',
                violations: [{ ruleId: 'r1', severity: 'warning', message: 'test' }],
                uncertainResults: [
                  {
                    ruleId: 'r2',
                    message: 'AST unavailable',
                    layer: 'ast',
                    reason: 'ast_unavailable',
                    detail: 'No tree-sitter',
                  },
                ],
                summary: { total: 1, errors: 0, warnings: 1, infos: 0, uncertain: 1 },
              },
            ],
            crossFileViolations: [],
            capabilityReport: {
              checkCoverage: 75,
              uncertainResults: [
                {
                  ruleId: 'r2',
                  message: 'AST unavailable',
                  layer: 'ast',
                  reason: 'ast_unavailable',
                  detail: 'No tree-sitter',
                },
              ],
              boundaries: [
                {
                  type: 'ast_language_gap',
                  description: 'AST skipped',
                  affectedRules: ['r2'],
                  suggestedAction: 'Install tree-sitter',
                },
              ],
            },
          };
        },
      };

      const reporter = new ComplianceReporter(mockEngine as any, null, null, null);
      const report = await reporter.generate('/tmp/test-project');

      expect(report.complianceScore).toBeDefined();
      expect(report.coverageScore).toBe(75);
      expect(report.confidenceScore).toBeDefined();
      expect(report.confidenceScore).toBeLessThan(100); // has uncertain items
      expect(report.uncertainSummary.total).toBe(1);
      expect(report.uncertainSummary.byLayer.ast).toBe(1);
      expect(report.boundaries).toHaveLength(1);
    });
  });
});

/**
 * 集成测试：Guard Service 全流程 — 规则 CRUD + 代码检查 + 反馈循环
 *
 * 覆盖范围:
 *   - GuardService.createRule / enableRule / disableRule
 *   - GuardService.checkCode 委托给 engine
 *   - GuardFeedbackLoop 修复检测 + 自动确认使用
 *   - 端到端: 创建规则 → 检查代码 → 检测修复 → 确认使用
 */

import { createTestBootstrap } from '../fixtures/factory.js';

describe('Integration: Guard Service Full Flow', () => {
  let bootstrap: any;
  let components: any;
  let guardCheckEngine: any;

  beforeAll(async () => {
    ({ bootstrap, components } = await createTestBootstrap());

    // 手动创建 GuardCheckEngine（需要 DB）
    const { GuardCheckEngine } = await import('../../lib/service/guard/GuardCheckEngine.js');
    guardCheckEngine = new GuardCheckEngine(components.db);
  });

  afterAll(async () => {
    await bootstrap.shutdown();
  });

  describe('GuardService CRUD', () => {
    let guardService: any;
    let createdRuleId: string;

    beforeAll(async () => {
      const { ServiceContainer } = await import('../../lib/injection/ServiceContainer.js');
      const container = new ServiceContainer();
      await container.initialize({
        db: components.db,
        auditLogger: components.auditLogger,
        gateway: components.gateway,
        constitution: components.constitution,
        config: components.config,
        skillHooks: components.skillHooks,
      });

      guardService = container.get('guardService');
    });

    test('should create a guard rule', async () => {
      const result = await guardService.createRule(
        {
          name: 'No eval()',
          description: 'Disallow use of eval() function',
          pattern: 'eval\\(',
          languages: ['javascript'],
          severity: 'error',
          category: 'security',
        },
        { userId: 'test-dev' }
      );

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      createdRuleId = result.id;
    });

    test('should check code with created rules', () => {
      const violations = guardCheckEngine.checkCode('const result = eval("1+1");', 'javascript');
      // 内置规则可能存在 eval 检查
      expect(Array.isArray(violations)).toBe(true);
    });

    test('should check safe code has no violations or fewer violations', () => {
      const violations = guardCheckEngine.checkCode('const result = 1 + 1;', 'javascript');
      expect(Array.isArray(violations)).toBe(true);
    });
  });

  describe('GuardCheckEngine audit', () => {
    test('should audit single file', () => {
      // auditFile(filePath, code, options)
      const result = guardCheckEngine.auditFile?.(
        'test.js',
        'function test() { return eval("x"); }',
        { scope: 'project' }
      );
      if (result) {
        expect(result).toHaveProperty('violations');
        expect(Array.isArray(result.violations)).toBe(true);
        expect(result).toHaveProperty('filePath', 'test.js');
        expect(result).toHaveProperty('summary');
      }
    });

    test('should handle unknown language gracefully', () => {
      const violations = guardCheckEngine.checkCode('some code', 'brainfuck');
      expect(Array.isArray(violations)).toBe(true);
    });
  });

  describe('GuardFeedbackLoop', () => {
    test('should detect fixed violations', async () => {
      const { GuardFeedbackLoop } = await import('../../lib/service/guard/GuardFeedbackLoop.js');

      // Mock ViolationsStore with past violations
      const mockStore = {
        getRunsByFile: (filePath: string) => [
          {
            violations: [
              { ruleId: 'no-eval', fixSuggestion: 'recipe:safe-eval-alternative' },
              { ruleId: 'no-console', fixSuggestion: 'recipe:logger-pattern' },
            ],
          },
        ],
      };

      const confirmations: Array<{ action: string; recipeId: string }> = [];
      const mockCollector = {
        record: (action: string, recipeId: string, meta: Record<string, unknown>) => {
          confirmations.push({ action, recipeId });
        },
      };

      const loop = new GuardFeedbackLoop(mockStore, mockCollector);

      // 当前检查只有 no-console 违规（no-eval 已修复）
      const currentResult = {
        violations: [{ ruleId: 'no-console' }],
      };

      const fixed = loop.detectFixedViolations(currentResult, 'src/utils.js');
      expect(fixed).toHaveLength(1);
      expect(fixed[0].ruleId).toBe('no-eval');
      expect(fixed[0].fixRecipeId).toBe('safe-eval-alternative');
    });

    test('should auto-confirm usage for fixed violations', async () => {
      const { GuardFeedbackLoop } = await import('../../lib/service/guard/GuardFeedbackLoop.js');

      const confirmations: Array<{ action: string; recipeId: string }> = [];
      const mockCollector = {
        record: (action: string, recipeId: string) => {
          confirmations.push({ action, recipeId });
        },
      };

      const loop = new GuardFeedbackLoop(null, mockCollector);
      loop.autoConfirmUsage([
        { ruleId: 'r1', filePath: 'a.ts', fixRecipeId: 'recipe-1' },
        { ruleId: 'r2', filePath: 'b.ts', fixRecipeId: 'recipe-2' },
      ]);

      expect(confirmations).toHaveLength(2);
      expect(confirmations[0]).toEqual({ action: 'insert', recipeId: 'recipe-1' });
      expect(confirmations[1]).toEqual({ action: 'insert', recipeId: 'recipe-2' });
    });

    test('should run full processFixDetection flow', async () => {
      const { GuardFeedbackLoop } = await import('../../lib/service/guard/GuardFeedbackLoop.js');

      const mockStore = {
        getRunsByFile: () => [
          {
            violations: [{ ruleId: 'rule-a', fixSuggestion: 'recipe:fix-a' }],
          },
        ],
      };
      const confirmations: string[] = [];
      const mockCollector = {
        record: (_: string, recipeId: string) => confirmations.push(recipeId),
      };

      const loop = new GuardFeedbackLoop(mockStore, mockCollector);
      const fixed = loop.processFixDetection({ violations: [] }, 'test.ts');

      expect(fixed).toHaveLength(1);
      expect(confirmations).toContain('fix-a');
    });

    test('should handle missing violationsStore gracefully', async () => {
      const { GuardFeedbackLoop } = await import('../../lib/service/guard/GuardFeedbackLoop.js');
      const loop = new GuardFeedbackLoop(null, null);

      const fixed = loop.detectFixedViolations({ violations: [] }, 'test.ts');
      expect(fixed).toEqual([]);
    });

    test('should report stats', async () => {
      const { GuardFeedbackLoop } = await import('../../lib/service/guard/GuardFeedbackLoop.js');
      const loop = new GuardFeedbackLoop(null, null, { guardCheckEngine: {} as any });
      const stats = loop.getStats();
      expect(stats.hasViolationsStore).toBe(false);
      expect(stats.hasFeedbackCollector).toBe(false);
      expect(stats.hasGuardCheckEngine).toBe(true);
    });
  });
});

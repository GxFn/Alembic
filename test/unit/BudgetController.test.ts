/**
 * BudgetController 单元测试
 *
 * 覆盖:
 *   - checkBeforeLLMCall 的三个分支 (normal/compress/summarize)
 *   - 无 session budget 时退化为 no-op
 *   - 跨 stage cumulativeUsage 引用共享
 *   - L4 compaction token 回写 cumulativeUsage
 *   - 工具预算分摊 + 剩余预算追踪
 *   - TurnTelemetry 输出
 *   - SessionSummary 统计
 */
import { describe, expect, test, vi } from 'vitest';
import {
  BudgetController,
  type BudgetControllerConfig,
  type TokenUsageAccumulator,
} from '../../lib/agent/runtime/BudgetController.js';

/* ── Mock Factories ─────────────────────────────────── */

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function mockContextWindow(overrides: Record<string, unknown> = {}) {
  return {
    setSessionPressure: vi.fn(),
    compactIfNeeded: vi.fn().mockReturnValue({ level: 0, removed: 0 }),
    needsL4Compaction: vi.fn().mockReturnValue(false),
    compactL4: vi
      .fn()
      .mockResolvedValue({ level: 4, removed: 3, usage: { inputTokens: 200, outputTokens: 50 } }),
    estimateFullContextTokens: vi.fn().mockReturnValue(10000),
    getToolResultQuota: vi.fn().mockReturnValue({ maxChars: 6000, maxMatches: 15 }),
    ...overrides,
  };
}

function mockTracker(overrides: Record<string, unknown> = {}) {
  return {
    forceTerminal: vi.fn(),
    ...overrides,
  };
}

function createUsage(input = 0): TokenUsageAccumulator {
  return { input, output: 0, reasoning: 0, cacheHit: 0 };
}

function createConfig(overrides: Partial<BudgetControllerConfig> = {}): BudgetControllerConfig {
  return {
    maxSessionInputTokens: 100_000,
    cumulativeUsage: createUsage(),
    contextWindow: mockContextWindow() as unknown as BudgetControllerConfig['contextWindow'],
    tracker: mockTracker() as unknown as BudgetControllerConfig['tracker'],
    baseSystemPromptLength: 2000,
    toolSchemaCount: 10,
    logger: mockLogger(),
    ...overrides,
  };
}

/* ── Tests ──────────────────────────────────────────── */

describe('BudgetController', () => {
  describe('hasSessionBudget', () => {
    test('returns true when maxSessionInputTokens > 0', () => {
      const ctrl = new BudgetController(createConfig({ maxSessionInputTokens: 50_000 }));
      expect(ctrl.hasSessionBudget).toBe(true);
    });

    test('returns false when maxSessionInputTokens = 0', () => {
      const ctrl = new BudgetController(createConfig({ maxSessionInputTokens: 0 }));
      expect(ctrl.hasSessionBudget).toBe(false);
    });
  });

  describe('checkBeforeLLMCall', () => {
    test('returns normal when no session budget (no-op)', () => {
      const ctrl = new BudgetController(createConfig({ maxSessionInputTokens: 0 }));
      const result = ctrl.checkBeforeLLMCall(5);
      expect(result.action).toBe('normal');
      expect(result.estimatedNextCallTokens).toBe(0);
    });

    test('returns normal when projected < 75%', () => {
      const usage = createUsage(10_000);
      const cw = mockContextWindow({ estimateFullContextTokens: vi.fn().mockReturnValue(5000) });
      const ctrl = new BudgetController(
        createConfig({
          maxSessionInputTokens: 100_000,
          cumulativeUsage: usage,
          contextWindow: cw as unknown as BudgetControllerConfig['contextWindow'],
        })
      );

      const result = ctrl.checkBeforeLLMCall(1);
      expect(result.action).toBe('normal');
      expect(result.sessionUsageRatio).toBeLessThan(COMPRESS_THRESHOLD());
    });

    test('returns compress when 75% <= projected < 90%', () => {
      const usage = createUsage(70_000);
      const ctrl = new BudgetController(
        createConfig({
          maxSessionInputTokens: 100_000,
          cumulativeUsage: usage,
        })
      );
      // lastRoundInputTokens=0, will use contextWindow estimate (10000)
      // projected = 70000 + 10000 = 80000/100000 = 80%

      const result = ctrl.checkBeforeLLMCall(1);
      expect(result.action).toBe('compress');
      expect(result.sessionUsageRatio).toBeGreaterThanOrEqual(0.75);
      expect(result.sessionUsageRatio).toBeLessThan(0.9);
    });

    test('returns compress (aggressive) when projected >= 90%', () => {
      const usage = createUsage(85_000);
      const ctrl = new BudgetController(
        createConfig({
          maxSessionInputTokens: 100_000,
          cumulativeUsage: usage,
        })
      );
      // projected = 85000 + 10000 = 95000/100000 = 95%
      // >90% triggers aggressive compress + L4 pending, not forced exit

      const result = ctrl.checkBeforeLLMCall(1);
      expect(result.action).toBe('compress');
      expect(result.sessionUsageRatio).toBeGreaterThanOrEqual(0.9);
      expect(ctrl.pendingL4).toBe(true);
    });

    test('syncs session pressure to ContextWindow', () => {
      const cw = mockContextWindow();
      const usage = createUsage(50_000);
      const ctrl = new BudgetController(
        createConfig({
          maxSessionInputTokens: 100_000,
          cumulativeUsage: usage,
          contextWindow: cw as unknown as BudgetControllerConfig['contextWindow'],
        })
      );

      ctrl.checkBeforeLLMCall(1);
      expect(cw.setSessionPressure).toHaveBeenCalledWith(0.5);
    });

    test('compress triggers extra compaction', () => {
      const cw = mockContextWindow({
        compactIfNeeded: vi.fn().mockReturnValue({ level: 2, removed: 5 }),
        needsL4Compaction: vi.fn().mockReturnValue(true),
      });
      const usage = createUsage(70_000);
      const ctrl = new BudgetController(
        createConfig({
          maxSessionInputTokens: 100_000,
          cumulativeUsage: usage,
          contextWindow: cw as unknown as BudgetControllerConfig['contextWindow'],
        })
      );

      const result = ctrl.checkBeforeLLMCall(1);
      expect(result.action).toBe('compress');
      expect(result.compaction.level).toBe(2);
      expect(result.compaction.removed).toBe(5);
      expect(ctrl.pendingL4).toBe(true);
    });

    test('uses lastRoundInputTokens for estimation after first round', () => {
      const usage = createUsage(60_000);
      const ctrl = new BudgetController(
        createConfig({
          maxSessionInputTokens: 100_000,
          cumulativeUsage: usage,
        })
      );

      ctrl.recordLLMUsage({ inputTokens: 30_000, outputTokens: 100 });
      // Now lastRoundInputTokens = 30000
      // cumulativeUsage.input = 60000 + 30000 = 90000
      // projected = 90000 + 30000 = 120000/100000 = 120%

      const result = ctrl.checkBeforeLLMCall(2);
      expect(result.action).toBe('compress');
      expect(result.estimatedNextCallTokens).toBe(30_000);
    });
  });

  describe('recordLLMUsage + cumulativeUsage', () => {
    test('updates shared cumulativeUsage reference', () => {
      const usage = createUsage(1000);
      const ctrl = new BudgetController(createConfig({ cumulativeUsage: usage }));

      ctrl.recordLLMUsage({
        inputTokens: 500,
        outputTokens: 100,
        reasoningTokens: 50,
        cacheHitTokens: 200,
      });

      expect(usage.input).toBe(1500);
      expect(usage.output).toBe(100);
      expect(usage.reasoning).toBe(50);
      expect(usage.cacheHit).toBe(200);
    });

    test('cross-stage accumulation via shared reference', () => {
      const sharedUsage = createUsage();

      // Stage 1 (analyze)
      const ctrl1 = new BudgetController(createConfig({ cumulativeUsage: sharedUsage }));
      ctrl1.recordLLMUsage({ inputTokens: 30_000, outputTokens: 500 });
      expect(sharedUsage.input).toBe(30_000);

      // Stage 2 (produce) — same sharedUsage reference
      const ctrl2 = new BudgetController(createConfig({ cumulativeUsage: sharedUsage }));
      expect(ctrl2.cumulativeUsage.input).toBe(30_000);

      ctrl2.recordLLMUsage({ inputTokens: 10_000, outputTokens: 200 });
      expect(sharedUsage.input).toBe(40_000);
    });
  });

  describe('executeL4IfPending', () => {
    test('does nothing when not pending', async () => {
      const ctrl = new BudgetController(createConfig());
      const result = await ctrl.executeL4IfPending({} as never);
      expect(result).toEqual({ level: 0, removed: 0 });
    });

    test('executes L4 and updates cumulativeUsage', async () => {
      const usage = createUsage(50_000);
      const cw = mockContextWindow();
      const addLoop = vi.fn();
      const ctrl = new BudgetController(
        createConfig({
          cumulativeUsage: usage,
          contextWindow: cw as unknown as BudgetControllerConfig['contextWindow'],
        })
      );

      ctrl.requestL4Compaction();
      expect(ctrl.pendingL4).toBe(true);

      const result = await ctrl.executeL4IfPending(
        cw as unknown as Parameters<BudgetController['executeL4IfPending']>[0],
        addLoop
      );

      expect(result.level).toBe(4);
      expect(result.removed).toBe(3);
      expect(usage.input).toBe(50_200);
      expect(usage.output).toBe(50);
      expect(addLoop).toHaveBeenCalledWith({ inputTokens: 200, outputTokens: 50 });
      expect(ctrl.pendingL4).toBe(false);
    });

    test('handles L4 failure gracefully', async () => {
      const cw = mockContextWindow({
        compactL4: vi.fn().mockRejectedValue(new Error('LLM error')),
      });
      const logger = mockLogger();
      const ctrl = new BudgetController(
        createConfig({
          contextWindow: cw as unknown as BudgetControllerConfig['contextWindow'],
          logger,
        })
      );

      ctrl.requestL4Compaction();
      const result = await ctrl.executeL4IfPending(
        cw as unknown as Parameters<BudgetController['executeL4IfPending']>[0]
      );

      expect(result).toEqual({ level: 0, removed: 0 });
      expect(logger.warn).toHaveBeenCalledOnce();
    });
  });

  describe('runCompactionCycle', () => {
    test('delegates to contextWindow.compactIfNeeded', () => {
      const cw = mockContextWindow({
        compactIfNeeded: vi.fn().mockReturnValue({ level: 2, removed: 4 }),
      });
      const ctrl = new BudgetController(
        createConfig({
          contextWindow: cw as unknown as BudgetControllerConfig['contextWindow'],
        })
      );

      const result = ctrl.runCompactionCycle();
      expect(result).toEqual({ level: 2, removed: 4 });
      expect(cw.compactIfNeeded).toHaveBeenCalledOnce();
    });

    test('returns no-op when no contextWindow', () => {
      const ctrl = new BudgetController(createConfig({ contextWindow: null }));
      const result = ctrl.runCompactionCycle();
      expect(result).toEqual({ level: 0, removed: 0 });
    });
  });

  describe('getToolBudget', () => {
    test('calculates parallel tool budget correctly', () => {
      const cw = mockContextWindow({
        getToolResultQuota: vi.fn().mockReturnValue({ maxChars: 6000, maxMatches: 15 }),
      });
      const ctrl = new BudgetController(
        createConfig({
          contextWindow: cw as unknown as BudgetControllerConfig['contextWindow'],
        })
      );

      const budget = ctrl.getToolBudget(4);
      // scaleFactor = ceil(4/2) = 2
      // roundMaxChars = 6000 * 2 = 12000
      // perToolMaxChars = max(400, floor(12000 / 4)) = 3000
      // perToolMaxMatches = max(2, floor(15 * 2 / 4)) = 7
      expect(budget.roundMaxChars).toBe(12000);
      expect(budget.perToolMaxChars).toBe(3000);
      expect(budget.perToolMaxMatches).toBe(7);
    });

    test('enforces minimum tool chars', () => {
      const cw = mockContextWindow({
        getToolResultQuota: vi.fn().mockReturnValue({ maxChars: 400, maxMatches: 2 }),
      });
      const ctrl = new BudgetController(
        createConfig({
          contextWindow: cw as unknown as BudgetControllerConfig['contextWindow'],
        })
      );

      const budget = ctrl.getToolBudget(10);
      // scaleFactor = ceil(10/2) = 5
      // roundMaxChars = 400 * 5 = 2000
      // perToolMaxChars = max(400, floor(2000/10)) = 400
      expect(budget.perToolMaxChars).toBe(400);
    });

    test('single tool gets full budget', () => {
      const cw = mockContextWindow({
        getToolResultQuota: vi.fn().mockReturnValue({ maxChars: 6000, maxMatches: 15 }),
      });
      const ctrl = new BudgetController(
        createConfig({
          contextWindow: cw as unknown as BudgetControllerConfig['contextWindow'],
        })
      );

      const budget = ctrl.getToolBudget(1);
      // scaleFactor = ceil(1/2) = 1
      // roundMaxChars = 6000 * 1 = 6000
      // perToolMaxChars = max(400, floor(6000/1)) = 6000
      expect(budget.roundMaxChars).toBe(6000);
      expect(budget.perToolMaxChars).toBe(6000);
    });

    test('no contextWindow returns defaults', () => {
      const ctrl = new BudgetController(createConfig({ contextWindow: null }));
      const budget = ctrl.getToolBudget(3);
      expect(budget.roundMaxChars).toBe(6000);
      expect(budget.perToolMaxChars).toBe(6000);
      expect(budget.perToolMaxMatches).toBe(15);
    });
  });

  describe('recordToolCharsUsed + getRemainingToolBudget', () => {
    test('tracks remaining budget across tool calls', () => {
      const cw = mockContextWindow({
        getToolResultQuota: vi.fn().mockReturnValue({ maxChars: 6000, maxMatches: 15 }),
      });
      const ctrl = new BudgetController(
        createConfig({
          contextWindow: cw as unknown as BudgetControllerConfig['contextWindow'],
        })
      );

      ctrl.getToolBudget(2);
      // roundMaxChars = 6000 * 1 = 6000

      ctrl.recordToolCharsUsed(2000);
      const remaining1 = ctrl.getRemainingToolBudget();
      expect(remaining1.maxChars).toBe(4000);

      ctrl.recordToolCharsUsed(3500);
      const remaining2 = ctrl.getRemainingToolBudget();
      expect(remaining2.maxChars).toBe(500);
    });

    test('enforces minimum remaining chars', () => {
      const cw = mockContextWindow({
        getToolResultQuota: vi.fn().mockReturnValue({ maxChars: 1000, maxMatches: 5 }),
      });
      const ctrl = new BudgetController(
        createConfig({
          contextWindow: cw as unknown as BudgetControllerConfig['contextWindow'],
        })
      );

      ctrl.getToolBudget(1);
      ctrl.recordToolCharsUsed(900);
      const remaining = ctrl.getRemainingToolBudget();
      expect(remaining.maxChars).toBe(400); // min = 400
    });
  });

  describe('emitTurnTelemetry', () => {
    test('outputs structured log', () => {
      const logger = mockLogger();
      const ctrl = new BudgetController(
        createConfig({
          maxSessionInputTokens: 100_000,
          logger,
        })
      );

      ctrl.emitTurnTelemetry({
        iteration: 5,
        currentUsage: {
          inputTokens: 30000,
          outputTokens: 200,
          reasoningTokens: 50,
          cacheHitTokens: 20000,
        },
        compaction: { level: 1, removed: 3 },
      });

      expect(logger.info).toHaveBeenCalledOnce();
      const msg = logger.info.mock.calls[0][0];
      expect(msg).toContain('[TurnTelemetry]');
      expect(msg).toContain('iter=5');
      expect(msg).toContain('in=30000');
      expect(msg).toContain('compact=L1');
    });

    test('warns on consecutive zero cache hits', () => {
      const logger = mockLogger();
      const ctrl = new BudgetController(createConfig({ logger }));

      for (let i = 0; i < 3; i++) {
        ctrl.emitTurnTelemetry({
          iteration: i + 1,
          currentUsage: { inputTokens: 5000, outputTokens: 100, cacheHitTokens: 0 },
          compaction: { level: 0, removed: 0 },
        });
      }

      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn.mock.calls[0][0]).toContain('3 consecutive');
    });

    test('resets cache hit counter on non-zero hit', () => {
      const logger = mockLogger();
      const ctrl = new BudgetController(createConfig({ logger }));

      ctrl.emitTurnTelemetry({
        iteration: 1,
        currentUsage: { inputTokens: 5000, outputTokens: 100, cacheHitTokens: 0 },
        compaction: { level: 0, removed: 0 },
      });
      ctrl.emitTurnTelemetry({
        iteration: 2,
        currentUsage: { inputTokens: 5000, outputTokens: 100, cacheHitTokens: 0 },
        compaction: { level: 0, removed: 0 },
      });
      // Non-zero cache hit resets
      ctrl.emitTurnTelemetry({
        iteration: 3,
        currentUsage: { inputTokens: 5000, outputTokens: 100, cacheHitTokens: 1000 },
        compaction: { level: 0, removed: 0 },
      });
      ctrl.emitTurnTelemetry({
        iteration: 4,
        currentUsage: { inputTokens: 5000, outputTokens: 100, cacheHitTokens: 0 },
        compaction: { level: 0, removed: 0 },
      });

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('getSessionSummary', () => {
    test('aggregates session statistics', () => {
      const usage = createUsage(10_000);
      const ctrl = new BudgetController(
        createConfig({
          maxSessionInputTokens: 100_000,
          cumulativeUsage: usage,
        })
      );

      ctrl.recordLLMUsage({
        inputTokens: 20_000,
        outputTokens: 500,
        reasoningTokens: 100,
        cacheHitTokens: 15_000,
      });
      ctrl.recordLLMUsage({
        inputTokens: 25_000,
        outputTokens: 600,
        reasoningTokens: 80,
        cacheHitTokens: 20_000,
      });

      const summary = ctrl.getSessionSummary();
      expect(summary.totalIterations).toBe(2);
      expect(summary.totalInputTokens).toBe(55_000); // 10000 + 20000 + 25000
      expect(summary.totalOutputTokens).toBe(1100);
      expect(summary.totalReasoningTokens).toBe(180);
      expect(summary.avgCacheHitRate).toBeCloseTo(35_000 / 55_000);
      expect(summary.forcedSummarize).toBe(false);
    });

    test('records forcedSummarize as false (budget no longer forces exit)', () => {
      const usage = createUsage(85_000);
      const ctrl = new BudgetController(
        createConfig({
          maxSessionInputTokens: 100_000,
          cumulativeUsage: usage,
        })
      );

      ctrl.checkBeforeLLMCall(10);
      const summary = ctrl.getSessionSummary();
      expect(summary.forcedSummarize).toBe(false);
    });
  });
});

/* ── Helper ─────────────────────────────────────────── */

function COMPRESS_THRESHOLD() {
  return 0.75;
}

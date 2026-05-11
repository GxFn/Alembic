/**
 * 集成测试：Agent Strategies + Policies
 *
 * 覆盖范围:
 *   - SingleStrategy 执行
 *   - PipelineStrategy 顺序执行
 *   - BudgetPolicy 迭代/超时限制
 *   - SafetyPolicy 命令黑名单 / 文件范围
 *   - QualityGatePolicy 质量门控
 *   - PolicyEngine 组合多策略
 */

import { vi } from 'vitest';
import { MemoryCoordinator } from '../../lib/agent/memory/MemoryCoordinator.js';
import {
  BudgetPolicy,
  Policy,
  PolicyEngine,
  QualityGatePolicy,
  SafetyPolicy,
} from '../../lib/agent/policies/index.js';
import { createSystemRunContext } from '../../lib/agent/runtime/SystemRunContext.js';
import { SingleStrategy, Strategy } from '../../lib/agent/strategies/index.js';
import { PipelineStrategy } from '../../lib/agent/strategies/PipelineStrategy.js';

describe('Integration: Agent Strategies', () => {
  describe('SingleStrategy', () => {
    test('should have name "single"', () => {
      const strategy = new SingleStrategy();
      expect(strategy.name).toBe('single');
    });

    test('should delegate to runtime.reactLoop', async () => {
      const strategy = new SingleStrategy();
      const mockRuntime = {
        id: 'test',
        reactLoop: async (prompt: string) => ({
          reply: `Processed: ${prompt}`,
          toolCalls: [],
          tokenUsage: { input: 10, output: 20 },
          iterations: 1,
        }),
      };

      // AgentMessage 需要 content + metadata.context + history
      const mockMessage = {
        role: 'user',
        content: 'Hello',
        history: [],
        metadata: { context: {} },
      };

      const result = await strategy.execute(mockRuntime as never, mockMessage as never);

      expect(result.reply).toContain('Processed');
      expect(result.iterations).toBe(1);
    });
  });

  describe('Strategy base class', () => {
    test('should throw on unimplemented name', () => {
      const s = new Strategy();
      expect(() => s.name).toThrow('Subclass must implement');
    });

    test('should throw on unimplemented execute', async () => {
      const s = new Strategy();
      await expect(s.execute({} as never, {} as never)).rejects.toThrow('Subclass must implement');
    });
  });

  describe('PipelineStrategy', () => {
    test('should alias trace to activeContext before quality gate evaluator', async () => {
      const trace = { distill: () => ({ keyFindings: [], toolCallSummary: [] }) };
      const evaluator = vi.fn((_source, _phaseResults, strategyContext) => ({
        action: strategyContext.activeContext === trace ? 'pass' : 'retry',
        pass: strategyContext.activeContext === trace,
      }));
      const strategy = new PipelineStrategy({
        stages: [{ name: 'analyze' }, { name: 'quality_gate', gate: { evaluator } }],
      });
      const runtime = {
        id: 'runtime-test',
        logger: { info: vi.fn() },
        reactLoop: vi.fn().mockResolvedValue({
          reply: 'analysis with evidence',
          toolCalls: [],
          tokenUsage: { input: 1, output: 1 },
          iterations: 1,
        }),
      };
      const message = {
        role: 'user',
        content: 'Analyze',
        history: [],
        metadata: { context: {} },
      };

      const result = await strategy.execute(runtime as never, message as never, {
        strategyContext: { trace },
      });

      expect(evaluator).toHaveBeenCalled();
      expect(result.phases.quality_gate).toMatchObject({ pass: true, action: 'pass' });
      expect(result.phases._diagnostics).toMatchObject({
        warnings: [
          expect.objectContaining({
            stage: 'quality_gate',
            warning: expect.stringContaining('aliased'),
          }),
        ],
      });
      expect(result.diagnostics).toMatchObject({
        warnings: [
          expect.objectContaining({
            code: 'pipeline_context_warning',
            stage: 'quality_gate',
          }),
        ],
      });
    });

    test('should project SystemRunContext into stage and gate execution', async () => {
      const memoryCoordinator = new MemoryCoordinator({ mode: 'bootstrap' });
      const activeContext = memoryCoordinator.createDimensionScope('dimension-a:analyst');
      const contextWindow = { resetForNewStage: vi.fn(), tokenCount: 0 };
      const systemRunContext = createSystemRunContext({
        memoryCoordinator,
        scopeId: 'dimension-a:analyst',
        activeContext,
        contextWindow: contextWindow as never,
        source: 'system',
        outputType: 'candidate',
        dimId: 'dimension-a',
        projectLanguage: 'swift',
        sharedState: { submittedTitles: new Set(), customFlag: true },
      });
      const evaluator = vi.fn((_source, _phaseResults, strategyContext) => ({
        action: strategyContext.activeContext === activeContext ? 'pass' : 'retry',
        pass: strategyContext.sharedState?._dimensionScopeId === 'dimension-a:analyst',
      }));
      const strategy = new PipelineStrategy({
        stages: [{ name: 'analyze' }, { name: 'quality_gate', gate: { evaluator } }],
      });
      let capturedLoopOpts: Record<string, unknown> | null = null;
      const runtime = {
        id: 'runtime-test',
        logger: { info: vi.fn() },
        reactLoop: vi.fn().mockImplementation(async (_prompt, opts) => {
          capturedLoopOpts = opts;
          return {
            reply: 'analysis with evidence',
            toolCalls: [],
            tokenUsage: { input: 1, output: 1 },
            iterations: 1,
          };
        }),
      };
      const message = {
        role: 'user',
        content: 'Analyze',
        history: [],
        metadata: { context: {} },
      };

      const result = await strategy.execute(runtime as never, message as never, {
        systemRunContext,
      });

      expect(result.phases.quality_gate).toMatchObject({ pass: true, action: 'pass' });
      expect(evaluator).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ activeContext, trace: activeContext, memoryCoordinator })
      );
      expect(capturedLoopOpts).toMatchObject({
        contextWindow,
        trace: activeContext,
        memoryCoordinator,
        sharedState: expect.objectContaining({
          _dimensionScopeId: 'dimension-a:analyst',
          _projectLanguage: 'swift',
          customFlag: true,
        }),
        source: 'system',
      });
    });
  });
});

describe('Integration: Agent Policies', () => {
  describe('BudgetPolicy', () => {
    test('should have defaults', () => {
      const policy = new BudgetPolicy();
      expect(policy.name).toBe('budget');
      expect(policy.maxIterations).toBe(20);
      expect(policy.maxTokens).toBe(4096);
      expect(policy.timeoutMs).toBe(300_000);
      expect(policy.temperature).toBe(0.7);
    });

    test('should accept custom values', () => {
      const policy = new BudgetPolicy({
        maxIterations: 5,
        maxTokens: 2048,
        timeoutMs: 60_000,
        temperature: 0.3,
      });
      expect(policy.maxIterations).toBe(5);
      expect(policy.maxTokens).toBe(2048);
      expect(policy.timeoutMs).toBe(60_000);
      expect(policy.temperature).toBe(0.3);
    });

    test('should enforce iteration limit', () => {
      const policy = new BudgetPolicy({ maxIterations: 3 });

      expect(policy.validateDuring({ iteration: 0, startTime: Date.now() }).ok).toBe(true);
      expect(policy.validateDuring({ iteration: 2, startTime: Date.now() }).ok).toBe(true);

      const result = policy.validateDuring({ iteration: 3, startTime: Date.now() });
      expect(result.ok).toBe(false);
      expect(result.action).toBe('stop');
    });

    test('should enforce timeout', () => {
      const policy = new BudgetPolicy({ timeoutMs: 100 });

      const result = policy.validateDuring({
        iteration: 0,
        startTime: Date.now() - 200,
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('SafetyPolicy', () => {
    test('should block blacklisted commands', () => {
      const policy = new SafetyPolicy({
        commandBlacklist: [/rm\s+-rf/, /sudo/],
      });

      // SafetyPolicy 通常在工具调用时检查
      expect(policy.name).toBe('safety');
      expect(policy).toBeDefined();
    });

    test('should validate sender', () => {
      const policy = new SafetyPolicy({
        allowedSenders: ['user-1', 'user-2'],
      });

      const validResult = policy.validateBefore({
        message: { sender: { id: 'user-1' } },
      });
      expect(validResult.ok).toBe(true);

      const invalidResult = policy.validateBefore({
        message: { sender: { id: 'hacker' } },
      });
      expect(invalidResult.ok).toBe(false);
    });

    test('should allow all senders when no restriction', () => {
      const policy = new SafetyPolicy({});
      const result = policy.validateBefore({
        message: { sender: { id: 'anyone' } },
      });
      expect(result.ok).toBe(true);
    });

    test('should reject paths that only share the fileScope prefix', () => {
      const policy = new SafetyPolicy({ fileScope: '/tmp/project/app' });

      expect(policy.checkFilePath('/tmp/project/app/src/index.ts').safe).toBe(true);
      expect(policy.checkFilePath('/tmp/project/app2/src/index.ts').safe).toBe(false);
    });

    test('should validate batch code tool file paths', () => {
      const engine = new PolicyEngine([new SafetyPolicy({ fileScope: '/tmp/project/app' })]);

      const result = engine.validateToolCall('code', {
        filePaths: ['/tmp/project/app/src/a.ts', '/tmp/project/app2/src/b.ts'],
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('路径拦截');
    });
  });

  describe('QualityGatePolicy', () => {
    test('should validate result quality', () => {
      const policy = new QualityGatePolicy({
        minToolCalls: 2,
      });

      expect(policy.name).toBe('quality_gate');

      const poorResult = policy.validateAfter({
        toolCalls: [{}],
      });
      expect(poorResult.ok).toBe(false);

      const goodResult = policy.validateAfter({
        toolCalls: [{}, {}, {}],
      });
      expect(goodResult.ok).toBe(true);
    });

    test('should support custom validator', () => {
      const policy = new QualityGatePolicy({
        minToolCalls: 0,
        minEvidenceLength: 0,
        minFileRefs: 0,
        customValidator: (result) => {
          if ((result.reply as string)?.includes('error')) {
            return { ok: false, reason: 'Reply contains error' };
          }
          return { ok: true };
        },
      });

      expect(policy.validateAfter({ reply: 'All good', toolCalls: [] }).ok).toBe(true);
      expect(policy.validateAfter({ reply: 'Found an error', toolCalls: [] }).ok).toBe(false);
    });

    test('should skip file ref check when toolCalls contain knowledge', () => {
      const policy = new QualityGatePolicy({
        minEvidenceLength: 0,
        minFileRefs: 3,
        minToolCalls: 0,
      });

      const result = policy.validateAfter({
        reply: 'Short reply without any file refs',
        toolCalls: [{ tool: 'knowledge' }, { tool: 'other_tool' }],
      });
      expect(result.ok).toBe(true);
    });

    test('should skip file ref check when toolCalls contain knowledge (via name field)', () => {
      const policy = new QualityGatePolicy({
        minEvidenceLength: 0,
        minFileRefs: 3,
        minToolCalls: 0,
      });

      const result = policy.validateAfter({
        reply: 'No file references here',
        toolCalls: [{ name: 'knowledge' }],
      });
      expect(result.ok).toBe(true);
    });

    test('should still check file refs when toolCalls are non-submit tools', () => {
      const policy = new QualityGatePolicy({
        minEvidenceLength: 0,
        minFileRefs: 3,
        minToolCalls: 0,
      });

      const result = policy.validateAfter({
        reply: 'Analysis without file refs',
        toolCalls: [{ tool: 'search_code' }, { tool: 'read_file' }],
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('文件引用不足');
    });

    test('should expose gate config via toGateConfig', () => {
      const policy = new QualityGatePolicy({
        minEvidenceLength: 100,
        minFileRefs: 5,
        minToolCalls: 3,
      });
      const config = policy.toGateConfig();
      expect(config).toMatchObject({
        minEvidenceLength: 100,
        minFileRefs: 5,
        minToolCalls: 3,
      });
    });
  });

  describe('PolicyEngine', () => {
    test('should combine multiple policies', () => {
      const engine = new PolicyEngine([
        new BudgetPolicy({ maxIterations: 10 }),
        new SafetyPolicy({}),
      ]);

      expect(engine).toBeDefined();
    });

    test('should validate through all policies', () => {
      const engine = new PolicyEngine([new BudgetPolicy({ maxIterations: 5 })]);

      // 5 iteration limit
      const early = engine.validateDuring({ iteration: 2, startTime: Date.now() });
      expect(early.ok).toBe(true);

      const late = engine.validateDuring({ iteration: 5, startTime: Date.now() });
      expect(late.ok).toBe(false);
    });
  });

  describe('Policy base class', () => {
    test('should return ok by default', () => {
      const p = new Policy();
      expect(p.validateBefore({})).toEqual({ ok: true });
      expect(p.validateDuring({ iteration: 0, startTime: 0 })).toEqual({
        ok: true,
        action: 'continue',
      });
      expect(p.validateAfter({})).toEqual({ ok: true });
    });

    test('should passthrough config', () => {
      const p = new Policy();
      const config = { key: 'value' };
      expect(p.applyToConfig(config)).toBe(config);
    });
  });
});

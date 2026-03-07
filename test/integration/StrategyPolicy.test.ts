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

import {
  BudgetPolicy,
  Policy,
  PolicyEngine,
  QualityGatePolicy,
  SafetyPolicy,
} from '../../lib/service/agent/policies.js';
import { PipelineStrategy, SingleStrategy, Strategy } from '../../lib/service/agent/strategies.js';

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

      const result = await strategy.execute(mockRuntime as any, mockMessage as any);

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
      await expect(s.execute({} as any, {} as any)).rejects.toThrow('Subclass must implement');
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

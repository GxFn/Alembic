/**
 * LLM Registry & ParameterGuard 综合测试
 *
 * 覆盖: ModelRegistry resolve 路径、ParameterGuard 边界、Provider 集成
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { ParameterGuard } from '../../lib/external/ai/guard/ParameterGuard.js';
import { getModelRegistry, ModelRegistry } from '../../lib/external/ai/registry/ModelRegistry.js';
import type { ModelDef, ProviderId } from '../../lib/external/ai/registry/model-defs.js';

// ─── ModelRegistry ────────────────────────────────

describe('ModelRegistry', () => {
  let reg: ModelRegistry;

  beforeAll(() => {
    reg = new ModelRegistry();
  });

  test('内建模型数量 > 0', () => {
    expect(reg.size).toBeGreaterThan(15);
  });

  test('get() 精确匹配', () => {
    const m = reg.get('openai:gpt-5.5');
    expect(m).toBeDefined();
    expect(m!.apiModelId).toBe('gpt-5.5');
    expect(m!.provider).toBe('openai');
  });

  test('get() 不存在返回 undefined', () => {
    expect(reg.get('nonexist:model')).toBeUndefined();
  });

  test('resolve() provider + apiModelId 匹配', () => {
    const m = reg.resolve('deepseek', 'deepseek-v4-flash');
    expect(m).toBeDefined();
    expect(m!.id).toBe('deepseek:deepseek-v4-flash');
  });

  test('resolve() 不存在返回 undefined', () => {
    expect(reg.resolve('deepseek', 'nonexist')).toBeUndefined();
  });

  test('resolveOrCreate() 已注册模型直接返回', () => {
    const m = reg.resolveOrCreate('claude', 'claude-opus-4-7');
    expect(m.id).toBe('claude:claude-opus-4-7');
    expect(m.contextWindow).toBe(1_000_000);
  });

  test('resolveOrCreate() 未注册模型创建保守默认定义', () => {
    const m = reg.resolveOrCreate('openai', 'gpt-99-turbo');
    expect(m.id).toBe('openai:gpt-99-turbo');
    expect(m.contextWindow).toBe(128_000);
    expect(m.maxOutputTokens).toBe(8_192);
    expect(m.capabilities.toolCalling).toBe(true);
    expect(m.reasoning.supported).toBe(false);
  });

  test('listByProvider() 过滤 deprecated', () => {
    const models = reg.listByProvider('openai');
    const deprecated = models.filter((m) => m.deprecated);
    expect(deprecated).toHaveLength(0);
    expect(models.length).toBeGreaterThan(3);
  });

  test('listActive() 不含废弃模型', () => {
    const active = reg.listActive();
    const deprecated = active.filter((m) => m.deprecated);
    expect(deprecated).toHaveLength(0);
  });

  test('findByCapability("vision") 包含 OpenAI 和 Claude', () => {
    const visionModels = reg.findByCapability('vision');
    const providers = new Set(visionModels.map((m) => m.provider));
    expect(providers.has('openai')).toBe(true);
    expect(providers.has('claude')).toBe(true);
  });

  test('getContextWindow() 返回正确值', () => {
    expect(reg.getContextWindow('openai', 'gpt-5.5')).toBe(1_100_000);
    expect(reg.getContextWindow('deepseek', 'deepseek-v4-flash')).toBe(1_000_000);
    expect(reg.getContextWindow('claude', 'claude-opus-4-7')).toBe(1_000_000);
    expect(reg.getContextWindow('google', 'gemini-2.5-flash')).toBe(1_048_576);
  });

  test('getContextWindow() 不存在返回 undefined', () => {
    expect(reg.getContextWindow('openai', 'nonexist')).toBeUndefined();
  });

  test('register() 运行时注册自定义模型', () => {
    const custom: ModelDef = {
      id: 'mock:test-model',
      displayName: 'Test Model',
      provider: 'mock',
      apiModelId: 'test-model',
      contextWindow: 32_000,
      maxOutputTokens: 4_096,
      capabilities: {
        toolCalling: false,
        vision: false,
        embedding: false,
        jsonMode: false,
        streaming: false,
      },
      reasoning: { supported: false },
      parameterConstraints: {
        temperature: { allowed: true, min: 0, max: 1 },
      },
    };
    reg.register(custom);
    expect(reg.get('mock:test-model')).toBe(custom);
  });

  test('getModelRegistry() 返回单例', () => {
    const r1 = getModelRegistry();
    const r2 = getModelRegistry();
    expect(r1).toBe(r2);
  });

  test('DeepSeek V4 模型 maxOutputTokens 为 384K', () => {
    const flash = reg.get('deepseek:deepseek-v4-flash');
    const pro = reg.get('deepseek:deepseek-v4-pro');
    expect(flash!.maxOutputTokens).toBe(384_000);
    expect(pro!.maxOutputTokens).toBe(384_000);
  });

  test('Google 模型 contextWindow 统一为 1_048_576', () => {
    const models = reg.listByProvider('google');
    for (const m of models) {
      expect(m.contextWindow).toBe(1_048_576);
    }
  });
});

// ─── ParameterGuard ────────────────────────────────

describe('ParameterGuard', () => {
  const makeModel = (overrides: Partial<ModelDef> = {}): ModelDef => ({
    id: 'test:model',
    displayName: 'Test Model',
    provider: 'mock',
    apiModelId: 'model',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: {
      toolCalling: true,
      vision: false,
      embedding: false,
      jsonMode: false,
      streaming: true,
    },
    reasoning: { supported: false },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 2 },
      toolChoice: { allowed: true },
    },
    ...overrides,
  });

  // ── temperature ──

  test('temperature: 正常范围内直接通过', () => {
    const model = makeModel();
    const result = ParameterGuard.guard(model, { temperature: 0.5 });
    expect(result.temperature).toBe(0.5);
    expect(result.filtered).toHaveLength(0);
  });

  test('temperature: 超出范围被 clamp', () => {
    const model = makeModel();
    const result = ParameterGuard.guard(model, { temperature: 3 });
    expect(result.temperature).toBe(2);
  });

  test('temperature: 负数被 clamp 到 min', () => {
    const model = makeModel();
    const result = ParameterGuard.guard(model, { temperature: -1 });
    expect(result.temperature).toBe(0);
  });

  test('temperature: allowed=false 时被过滤', () => {
    const model = makeModel({
      parameterConstraints: {
        temperature: { allowed: false },
        toolChoice: { allowed: true },
      },
    });
    const result = ParameterGuard.guard(model, { temperature: 0.7 });
    expect(result.temperature).toBeUndefined();
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0].param).toBe('temperature');
  });

  test('temperature: null/undefined 时不处理', () => {
    const model = makeModel();
    const result = ParameterGuard.guard(model, { temperature: null });
    expect(result.temperature).toBeUndefined();
    expect(result.filtered).toHaveLength(0);
  });

  test('temperature: 未传时不处理', () => {
    const model = makeModel();
    const result = ParameterGuard.guard(model, {});
    expect(result.temperature).toBeUndefined();
    expect(result.filtered).toHaveLength(0);
  });

  // ── topP ──

  test('topP: allowed=false 时被过滤 (Claude Opus 4.7 场景)', () => {
    const model = makeModel({
      parameterConstraints: {
        temperature: { allowed: false },
        topP: { allowed: false },
        toolChoice: { allowed: true },
      },
    });
    const result = ParameterGuard.guard(model, { topP: 0.9 });
    expect(result.topP).toBeUndefined();
    expect(result.filtered.find((f) => f.param === 'topP')).toBeDefined();
  });

  test('topP: 正常范围通过', () => {
    const model = makeModel({
      parameterConstraints: {
        temperature: { allowed: true },
        topP: { allowed: true, min: 0, max: 1 },
        toolChoice: { allowed: true },
      },
    });
    const result = ParameterGuard.guard(model, { topP: 0.8 });
    expect(result.topP).toBe(0.8);
  });

  // ── topK ──

  test('topK: allowed=false 时被过滤', () => {
    const model = makeModel({
      parameterConstraints: {
        temperature: { allowed: false },
        topK: { allowed: false },
        toolChoice: { allowed: true },
      },
    });
    const result = ParameterGuard.guard(model, { topK: 40 });
    expect(result.topK).toBeUndefined();
    expect(result.filtered.find((f) => f.param === 'topK')).toBeDefined();
  });

  test('topK: 正常范围通过', () => {
    const model = makeModel({
      parameterConstraints: {
        temperature: { allowed: true },
        topK: { allowed: true, min: 1, max: 100 },
        toolChoice: { allowed: true },
      },
    });
    const result = ParameterGuard.guard(model, { topK: 40 });
    expect(result.topK).toBe(40);
  });

  test('topK: 超出范围被 clamp', () => {
    const model = makeModel({
      parameterConstraints: {
        temperature: { allowed: true },
        topK: { allowed: true, min: 1, max: 50 },
        toolChoice: { allowed: true },
      },
    });
    const result = ParameterGuard.guard(model, { topK: 200 });
    expect(result.topK).toBe(50);
  });

  // ── toolChoice ──

  test('toolChoice: 正常通过', () => {
    const model = makeModel();
    const result = ParameterGuard.guard(model, { toolChoice: 'auto' });
    expect(result.toolChoice).toBe('auto');
  });

  test('toolChoice: allowed=false 时被过滤', () => {
    const model = makeModel({
      parameterConstraints: {
        temperature: { allowed: true },
        toolChoice: { allowed: false },
      },
    });
    const result = ParameterGuard.guard(model, { toolChoice: 'auto' });
    expect(result.toolChoice).toBeUndefined();
    expect(result.filtered.find((f) => f.param === 'toolChoice')).toBeDefined();
  });

  test('toolChoice: disabledWhen=thinking 在 thinking 模式下被过滤', () => {
    const model = makeModel({
      reasoning: { supported: true, mode: 'thinking' },
      parameterConstraints: {
        temperature: { allowed: true },
        toolChoice: { allowed: true, disabledWhen: 'thinking' },
      },
    });
    const result = ParameterGuard.guard(model, { toolChoice: 'auto' });
    expect(result.toolChoice).toBeUndefined();
    expect(result.filtered.find((f) => f.param === 'toolChoice')).toBeDefined();
    expect(result.filtered[0].reason).toContain('thinking');
  });

  test('toolChoice: disabledWhen=thinking 在非 thinking 模式下通过', () => {
    const model = makeModel({
      reasoning: { supported: true, mode: 'reasoning_effort' },
      parameterConstraints: {
        temperature: { allowed: true },
        toolChoice: { allowed: true, disabledWhen: 'thinking' },
      },
    });
    const result = ParameterGuard.guard(model, { toolChoice: 'required' });
    expect(result.toolChoice).toBe('required');
  });

  test('toolChoice: disabledWhen=thinking reasoning.supported=false 时通过', () => {
    const model = makeModel({
      reasoning: { supported: false },
      parameterConstraints: {
        temperature: { allowed: true },
        toolChoice: { allowed: true, disabledWhen: 'thinking' },
      },
    });
    const result = ParameterGuard.guard(model, { toolChoice: 'auto' });
    expect(result.toolChoice).toBe('auto');
  });

  // ── reasoningEffort ──

  test('reasoningEffort: 允许的值通过', () => {
    const model = makeModel({
      reasoning: { supported: true, mode: 'reasoning_effort', defaultEffort: 'medium' },
      parameterConstraints: {
        temperature: { allowed: true },
        toolChoice: { allowed: true },
        reasoningEffort: { allowed: true, allowedValues: ['low', 'medium', 'high'] },
      },
    });
    const result = ParameterGuard.guard(model, { reasoningEffort: 'high' });
    expect(result.reasoningEffort).toBe('high');
  });

  test('reasoningEffort: 不允许的值回退到 defaultEffort', () => {
    const model = makeModel({
      reasoning: { supported: true, mode: 'reasoning_effort', defaultEffort: 'medium' },
      parameterConstraints: {
        temperature: { allowed: true },
        toolChoice: { allowed: true },
        reasoningEffort: { allowed: true, allowedValues: ['medium', 'high'] },
      },
    });
    const result = ParameterGuard.guard(model, { reasoningEffort: 'xhigh' });
    expect(result.reasoningEffort).toBe('medium');
    expect(result.filtered.find((f) => f.param === 'reasoningEffort')).toBeDefined();
  });

  test('reasoningEffort: rule.allowed=false 时被过滤并记录审计', () => {
    const model = makeModel({
      reasoning: { supported: false },
      parameterConstraints: {
        temperature: { allowed: true },
        toolChoice: { allowed: true },
      },
    });
    const result = ParameterGuard.guard(model, { reasoningEffort: 'high' });
    expect(result.reasoningEffort).toBeUndefined();
    expect(result.filtered.find((f) => f.param === 'reasoningEffort')).toBeDefined();
  });

  // ── maxTokens ──

  test('maxTokens: 正常范围通过', () => {
    const model = makeModel({ maxOutputTokens: 16_384 });
    const result = ParameterGuard.guard(model, { maxTokens: 4096 });
    expect(result.maxTokens).toBe(4096);
  });

  test('maxTokens: 超出 maxOutputTokens 时 clamp', () => {
    const model = makeModel({ maxOutputTokens: 8_192 });
    const result = ParameterGuard.guard(model, { maxTokens: 100_000 });
    expect(result.maxTokens).toBe(8_192);
  });

  // ── 空输入 ──

  test('空参数: 返回空 filtered', () => {
    const model = makeModel();
    const result = ParameterGuard.guard(model, {});
    expect(result.filtered).toHaveLength(0);
    expect(result.temperature).toBeUndefined();
    expect(result.topP).toBeUndefined();
    expect(result.topK).toBeUndefined();
    expect(result.toolChoice).toBeUndefined();
    expect(result.reasoningEffort).toBeUndefined();
    expect(result.maxTokens).toBeUndefined();
  });

  // ── 真实模型场景 ──

  test('Claude Opus 4.7: temperature/topP/topK 全部被过滤', () => {
    const reg = getModelRegistry();
    const model = reg.get('claude:claude-opus-4-7')!;
    const result = ParameterGuard.guard(model, {
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
    });
    expect(result.temperature).toBeUndefined();
    expect(result.topP).toBeUndefined();
    expect(result.topK).toBeUndefined();
    expect(result.filtered).toHaveLength(3);
  });

  test('DeepSeek V4 Flash: toolChoice 在 thinking 模式下被过滤', () => {
    const reg = getModelRegistry();
    const model = reg.get('deepseek:deepseek-v4-flash')!;
    const result = ParameterGuard.guard(model, { toolChoice: 'auto' });
    expect(result.toolChoice).toBeUndefined();
    expect(result.filtered.find((f) => f.param === 'toolChoice')).toBeDefined();
  });

  test('DeepSeek V4 Flash: temperature 允许 (API 接受但无效果)', () => {
    const reg = getModelRegistry();
    const model = reg.get('deepseek:deepseek-v4-flash')!;
    const result = ParameterGuard.guard(model, { temperature: 0.5 });
    expect(result.temperature).toBe(0.5);
  });

  test('OpenAI GPT-5.5: 所有参数正常通过', () => {
    const reg = getModelRegistry();
    const model = reg.get('openai:gpt-5.5')!;
    const result = ParameterGuard.guard(model, {
      temperature: 0.8,
      toolChoice: 'auto',
      reasoningEffort: 'high',
      maxTokens: 4096,
    });
    expect(result.temperature).toBe(0.8);
    expect(result.toolChoice).toBe('auto');
    expect(result.reasoningEffort).toBe('high');
    expect(result.maxTokens).toBe(4096);
    expect(result.filtered).toHaveLength(0);
  });

  test('DeepSeek Reasoner (deprecated): temperature 和 toolChoice 都被过滤', () => {
    const reg = getModelRegistry();
    const model = reg.get('deepseek:deepseek-reasoner')!;
    const result = ParameterGuard.guard(model, {
      temperature: 0.7,
      toolChoice: 'auto',
    });
    expect(result.temperature).toBeUndefined();
    expect(result.toolChoice).toBeUndefined();
    expect(result.filtered).toHaveLength(2);
  });
});

// ─── Provider ProviderConfig 一致性 ────────────────

describe('ProviderConfig 一致性', () => {
  test('每个 ProviderConfig 的 defaultModelId 在 Registry 中存在', async () => {
    const { PROVIDER_CONFIGS } = await import('../../lib/external/ai/registry/ProviderConfig.js');
    const reg = getModelRegistry();
    for (const cfg of PROVIDER_CONFIGS) {
      if (cfg.id === 'ollama') {
        continue;
      }
      const model = reg.get(cfg.defaultModelId);
      expect(model, `${cfg.id} defaultModelId=${cfg.defaultModelId} 不在 Registry`).toBeDefined();
    }
  });

  test('deprecated 模型的 migrateToId 在 Registry 中存在', () => {
    const reg = getModelRegistry();
    const all = [...((reg as any)['#models']?.values?.() ?? [])];
    // 通过 listActive() + 直接遍历检查
    const allModels: ModelDef[] = [];
    for (const provider of ['openai', 'deepseek', 'claude', 'google'] as ProviderId[]) {
      const models = reg.listByProvider(provider);
      allModels.push(...models);
    }
    // 检查 deprecated 模型: 需要通过 get 显式获取
    const deprecatedIds = [
      'openai:gpt-4o',
      'deepseek:deepseek-chat',
      'deepseek:deepseek-reasoner',
      'claude:claude-sonnet-4-20250514',
      'claude:claude-opus-4-20250514',
    ];
    for (const id of deprecatedIds) {
      const model = reg.get(id);
      expect(model, `${id} 应存在于 Registry`).toBeDefined();
      expect(model!.deprecated, `${id} 应标记为 deprecated`).toBeDefined();
      const target = reg.get(model!.deprecated!.migrateToId);
      expect(
        target,
        `${id} migrateToId=${model!.deprecated!.migrateToId} 不在 Registry`
      ).toBeDefined();
      expect(
        target!.deprecated,
        `${model!.deprecated!.migrateToId} 自身不应是 deprecated`
      ).toBeUndefined();
    }
  });
});

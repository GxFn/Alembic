/**
 * LLM Provider 连通性测试
 *
 * 使用真实 API Key 验证各 Provider 的 chat() 和 chatWithTools() 能否正常返回。
 * 跳过条件: 对应的 API Key 环境变量未设置。
 *
 * 运行: ALEMBIC_OPENAI_API_KEY=... ALEMBIC_DEEPSEEK_API_KEY=... npx vitest run test/integration/LlmConnectivity.test.ts
 */

import { describe, expect, test } from 'vitest';
import { ParameterGuard } from '../../lib/external/ai/guard/ParameterGuard.js';
import { DeepSeekProvider } from '../../lib/external/ai/providers/DeepSeekProvider.js';
import { GoogleGeminiProvider } from '../../lib/external/ai/providers/GoogleGeminiProvider.js';
import { OpenAiProvider } from '../../lib/external/ai/providers/OpenAiProvider.js';
import { getModelRegistry } from '../../lib/external/ai/registry/ModelRegistry.js';

const OPENAI_KEY = process.env.ALEMBIC_OPENAI_API_KEY || '';
const DEEPSEEK_KEY = process.env.ALEMBIC_DEEPSEEK_API_KEY || '';
const GOOGLE_KEY = process.env.ALEMBIC_GOOGLE_API_KEY || '';

const SIMPLE_TOOLS = [
  {
    name: 'get_weather',
    description: 'Get current weather for a location',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name' },
      },
      required: ['location'],
    },
  },
];

// ─── OpenAI ────────────────────────────────

describe('OpenAI 连通性', () => {
  const skip = !OPENAI_KEY;

  test.skipIf(skip)(
    'chat() — GPT-5.5 基本对话',
    async () => {
      const provider = new OpenAiProvider({
        apiKey: OPENAI_KEY,
        model: 'gpt-5.5',
      });
      try {
        const reply = await provider.chat('回复 "OK" 两个字母，不要其他内容');
        expect(reply).toBeTruthy();
        expect(reply.length).toBeLessThan(100);
        console.log(`  [OpenAI chat] reply: "${reply.trim()}"`);
      } catch (e: any) {
        if (e.status === 429 || e.message?.includes('quota')) {
          console.log('  [OpenAI chat] SKIPPED: quota exceeded (billing issue, not code bug)');
          return;
        }
        throw e;
      }
    },
    30_000
  );

  test.skipIf(skip)(
    'chatWithTools() — GPT-5.5 工具调用',
    async () => {
      const provider = new OpenAiProvider({
        apiKey: OPENAI_KEY,
        model: 'gpt-5.5',
      });
      try {
        const result = await provider.chatWithTools('北京今天的天气怎么样？', {
          toolSchemas: SIMPLE_TOOLS,
          toolChoice: 'required',
        });
        expect(result).toBeDefined();
        console.log(`  [OpenAI tools] content: "${result.content?.substring(0, 80)}"`);
        console.log(`  [OpenAI tools] functionCalls: ${result.functionCalls?.length ?? 0}`);
        if (result.functionCalls && result.functionCalls.length > 0) {
          expect(result.functionCalls[0].name).toBe('get_weather');
        }
      } catch (e: any) {
        if (e.status === 429 || e.message?.includes('quota')) {
          console.log('  [OpenAI tools] SKIPPED: quota exceeded (billing issue, not code bug)');
          return;
        }
        throw e;
      }
    },
    30_000
  );

  test.skipIf(skip)('ParameterGuard 集成 — temperature 正常传递', async () => {
    const reg = getModelRegistry();
    const model = reg.get('openai:gpt-5.5')!;
    const guarded = ParameterGuard.guard(model, { temperature: 0.3, maxTokens: 100 });
    expect(guarded.temperature).toBe(0.3);
    expect(guarded.maxTokens).toBe(100);
    expect(guarded.filtered).toHaveLength(0);
  });
});

// ─── DeepSeek ────────────────────────────────

describe('DeepSeek 连通性', () => {
  const skip = !DEEPSEEK_KEY;

  test.skipIf(skip)(
    'chat() — V4 Flash 基本对话 (thinking disabled)',
    async () => {
      const provider = new DeepSeekProvider({
        apiKey: DEEPSEEK_KEY,
        model: 'deepseek-v4-flash',
      });
      const reply = await provider.chat('回复 "OK" 两个字母，不要其他内容');
      expect(reply).toBeTruthy();
      console.log(`  [DeepSeek chat] reply: "${reply.trim()}"`);
    },
    30_000
  );

  test.skipIf(skip)(
    'chatWithTools() — V4 Flash thinking 模式工具调用',
    async () => {
      const provider = new DeepSeekProvider({
        apiKey: DEEPSEEK_KEY,
        model: 'deepseek-v4-flash',
      });
      const result = await provider.chatWithTools('北京今天的天气怎么样？', {
        toolSchemas: SIMPLE_TOOLS,
      });
      expect(result).toBeDefined();
      console.log(`  [DeepSeek tools] content: "${result.content?.substring(0, 80)}"`);
      console.log(`  [DeepSeek tools] functionCalls: ${result.functionCalls?.length ?? 0}`);
      console.log(
        `  [DeepSeek tools] reasoningContent: ${result.reasoningContent ? 'present' : 'none'}`
      );
    },
    60_000
  );

  test.skipIf(skip)('ParameterGuard — V4 toolChoice thinking 模式被过滤', () => {
    const reg = getModelRegistry();
    const model = reg.get('deepseek:deepseek-v4-flash')!;
    const guarded = ParameterGuard.guard(model, { toolChoice: 'auto' });
    expect(guarded.toolChoice).toBeUndefined();
    expect(guarded.filtered).toHaveLength(1);
    expect(guarded.filtered[0].reason).toContain('thinking');
  });
});

// ─── Google Gemini ────────────────────────────────

describe('Google Gemini 连通性', () => {
  const skip = !GOOGLE_KEY;

  test.skipIf(skip)(
    'chat() — Gemini 2.5 Flash 基本对话',
    async () => {
      const provider = new GoogleGeminiProvider({
        apiKey: GOOGLE_KEY,
        model: 'gemini-2.5-flash',
      });
      const reply = await provider.chat('回复 "OK" 两个字母，不要其他内容');
      expect(reply).toBeTruthy();
      console.log(`  [Gemini chat] reply: "${reply.trim()}"`);
    },
    30_000
  );

  test.skipIf(skip)(
    'chatWithTools() — Gemini 2.5 Flash 工具调用',
    async () => {
      const provider = new GoogleGeminiProvider({
        apiKey: GOOGLE_KEY,
        model: 'gemini-2.5-flash',
      });
      const result = await provider.chatWithTools('北京今天的天气怎么样？', {
        toolSchemas: SIMPLE_TOOLS,
        toolChoice: 'required',
      });
      expect(result).toBeDefined();
      console.log(`  [Gemini tools] content: "${result.content?.substring(0, 80)}"`);
      console.log(`  [Gemini tools] functionCalls: ${result.functionCalls?.length ?? 0}`);
      if (result.functionCalls && result.functionCalls.length > 0) {
        expect(result.functionCalls[0].name).toBe('get_weather');
      }
    },
    30_000
  );

  test.skipIf(skip)('provider name 应为 "google" (匹配 Registry)', () => {
    const provider = new GoogleGeminiProvider({ apiKey: 'test' });
    expect(provider.name).toBe('google');
  });

  test.skipIf(skip)('ParameterGuard 集成 — temperature 正常传递', () => {
    const reg = getModelRegistry();
    const model = reg.get('google:gemini-2.5-flash')!;
    const guarded = ParameterGuard.guard(model, { temperature: 0.7, maxTokens: 8192 });
    expect(guarded.temperature).toBe(0.7);
    expect(guarded.maxTokens).toBe(8192);
    expect(guarded.filtered).toHaveLength(0);
  });
});

// ─── 跨 Provider 边界场景 ────────────────────

describe('跨 Provider 边界场景', () => {
  test('动态创建模型的 guard 使用保守默认值', () => {
    const reg = getModelRegistry();
    const model = reg.resolveOrCreate('openai', 'gpt-future-99');
    const guarded = ParameterGuard.guard(model, {
      temperature: 1.5,
      maxTokens: 99999,
      toolChoice: 'auto',
    });
    expect(guarded.temperature).toBe(1.5);
    expect(guarded.maxTokens).toBe(8_192); // clamped to dynamic default
    expect(guarded.toolChoice).toBe('auto');
  });

  test('所有非 deprecated 模型的 parameterConstraints 至少有 temperature', () => {
    const reg = getModelRegistry();
    const active = reg.listActive();
    for (const m of active) {
      expect(m.parameterConstraints.temperature, `${m.id} 缺少 temperature 约束`).toBeDefined();
    }
  });

  test('所有 thinking 模式模型声明 reasoning.mode', () => {
    const reg = getModelRegistry();
    const active = reg.listActive();
    for (const m of active) {
      if (m.reasoning.supported) {
        expect(m.reasoning.mode, `${m.id} reasoning.supported=true 但缺少 mode`).toBeDefined();
      }
    }
  });
});

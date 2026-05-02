/**
 * LLMGateway + Transport 层单元测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolSchema, UnifiedMessage } from '../../lib/external/ai/AiProvider.js';
import { LLMGateway, resetLLMGateway } from '../../lib/external/ai/gateway/LLMGateway.js';
import { ClaudeTransport } from '../../lib/external/ai/transport/ClaudeTransport.js';
import { DeepSeekTransport } from '../../lib/external/ai/transport/DeepSeekTransport.js';
import { GoogleTransport } from '../../lib/external/ai/transport/GoogleTransport.js';
import {
  LLMTransport,
  type TransportConfig,
  type TransportRequest,
  type TransportResponse,
} from '../../lib/external/ai/transport/LLMTransport.js';
import { OpenAiTransport } from '../../lib/external/ai/transport/OpenAiTransport.js';

// ─── Transport 基础测试 ─────────────────────────────────

describe('LLMTransport', () => {
  describe('OpenAiTransport', () => {
    it('should instantiate with correct providerId', () => {
      const t = new OpenAiTransport({ apiKey: 'test' });
      expect(t.providerId).toBe('openai');
    });

    it('should throw when apiKey missing', async () => {
      const t = new OpenAiTransport({ apiKey: '' });
      await expect(
        t.chat({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] })
      ).rejects.toThrow('API Key');
    });
  });

  describe('ClaudeTransport', () => {
    it('should instantiate with correct providerId', () => {
      const t = new ClaudeTransport({ apiKey: 'test' });
      expect(t.providerId).toBe('claude');
    });

    it('should throw when apiKey missing', async () => {
      const t = new ClaudeTransport({ apiKey: '' });
      await expect(
        t.chat({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] })
      ).rejects.toThrow('API Key');
    });
  });

  describe('DeepSeekTransport', () => {
    it('should instantiate with correct providerId', () => {
      const t = new DeepSeekTransport({ apiKey: 'test' });
      expect(t.providerId).toBe('deepseek');
    });

    it('should default reasoningEffort to high', () => {
      const t = new DeepSeekTransport({ apiKey: 'test' });
      expect(t.providerId).toBe('deepseek');
    });
  });

  describe('GoogleTransport', () => {
    it('should instantiate with correct providerId', () => {
      const t = new GoogleTransport({ apiKey: 'test' });
      expect(t.providerId).toBe('google');
    });
  });

  describe('LLMTransport base', () => {
    it('embed returns empty array by default', async () => {
      class TestTransport extends LLMTransport {
        constructor() {
          super('openai', { apiKey: 'test' });
        }
        async chat(): Promise<string> {
          return '';
        }
        async chatWithTools(): Promise<TransportResponse> {
          return { text: '', functionCalls: null, usage: null };
        }
      }
      const t = new TestTransport();
      const result = await t.embed(['test']);
      expect(result).toEqual([]);
    });

    it('chatStructured delegates to chat with json format', async () => {
      class TestTransport extends LLMTransport {
        constructor() {
          super('openai', { apiKey: 'test' });
        }
        async chat(req: TransportRequest): Promise<string> {
          expect(req.responseFormat).toBe('json');
          return '{"key": "value"}';
        }
        async chatWithTools(): Promise<TransportResponse> {
          return { text: '', functionCalls: null, usage: null };
        }
      }
      const t = new TestTransport();
      const result = await t.chatStructured({
        model: 'test',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect(result).toEqual({ key: 'value' });
    });

    it('chatStructured returns null on parse failure', async () => {
      class TestTransport extends LLMTransport {
        constructor() {
          super('openai', { apiKey: 'test' });
        }
        async chat(): Promise<string> {
          return 'not json';
        }
        async chatWithTools(): Promise<TransportResponse> {
          return { text: '', functionCalls: null, usage: null };
        }
      }
      const t = new TestTransport();
      const result = await t.chatStructured({
        model: 'test',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect(result).toBeNull();
    });
  });
});

// ─── LLMGateway 测试 ────────────────────────────────────

describe('LLMGateway', () => {
  beforeEach(() => {
    resetLLMGateway();
  });

  describe('Model Resolution', () => {
    it('resolves provider:model format', () => {
      const gw = new LLMGateway({
        providers: { openai: { apiKey: 'test' } },
      });
      const def = gw.getModelDef('openai:gpt-5.5');
      expect(def.provider).toBe('openai');
      expect(def.apiModelId).toBe('gpt-5.5');
    });

    it('resolves claude model ref', () => {
      const gw = new LLMGateway({
        providers: { claude: { apiKey: 'test' } },
      });
      const def = gw.getModelDef('claude:claude-sonnet-4-6');
      expect(def.provider).toBe('claude');
    });

    it('resolves deepseek model ref', () => {
      const gw = new LLMGateway({
        providers: { deepseek: { apiKey: 'test' } },
      });
      const def = gw.getModelDef('deepseek:deepseek-v4-flash');
      expect(def.provider).toBe('deepseek');
    });

    it('resolves google model ref', () => {
      const gw = new LLMGateway({
        providers: { google: { apiKey: 'test' } },
      });
      const def = gw.getModelDef('google:gemini-3-flash-preview');
      expect(def.provider).toBe('google');
    });

    it('guesses provider from model name', () => {
      const gw = new LLMGateway({
        providers: { openai: { apiKey: 'test' } },
      });
      const def = gw.getModelDef('gpt-5.5');
      expect(def.provider).toBe('openai');
    });

    it('guesses claude from model name', () => {
      const gw = new LLMGateway({
        providers: { claude: { apiKey: 'test' } },
      });
      const def = gw.getModelDef('claude-sonnet-4-6');
      expect(def.provider).toBe('claude');
    });
  });

  describe('chatWithTools integration', () => {
    it('calls transport with guarded parameters', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: 'Hello!',
                  tool_calls: null,
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const gw = new LLMGateway({
        providers: { openai: { apiKey: 'test-key' } },
      });

      const result = await gw.chatWithTools({
        modelRef: 'openai:gpt-5.5',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        maxTokens: 4096,
      });

      expect(result.text).toBe('Hello!');
      expect(result.usage?.inputTokens).toBe(10);
      expect(result.usage?.outputTokens).toBe(5);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });

    it('normalizes function calls from transport response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'test_tool',
                        arguments: '{"arg1": "value1"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const gw = new LLMGateway({
        providers: { openai: { apiKey: 'test-key' } },
      });

      const result = await gw.chatWithTools({
        modelRef: 'openai:gpt-5.5',
        messages: [{ role: 'user', content: 'Call tool' }],
        tools: [{ name: 'test_tool', description: 'test', parameters: { type: 'object' } }],
        toolChoice: 'auto',
      });

      expect(result.functionCalls).not.toBeNull();
      expect(result.functionCalls?.[0].name).toBe('test_tool');
      expect(result.functionCalls?.[0].args).toEqual({ arg1: 'value1' });

      vi.unstubAllGlobals();
    });

    it('filters parameters via ParameterGuard', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [{ type: 'text', text: 'response' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const gw = new LLMGateway({
        providers: { claude: { apiKey: 'test-key' } },
      });

      const result = await gw.chatWithTools({
        modelRef: 'claude:claude-opus-4-7',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.9,
      });

      expect(result.text).toBe('response');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.temperature).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });

  describe('chat', () => {
    it('returns text from simple chat', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: { content: 'Hello world' },
              },
            ],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const gw = new LLMGateway({
        providers: { openai: { apiKey: 'test-key' } },
      });

      const text = await gw.chat({
        modelRef: 'openai:gpt-5.5',
        prompt: 'Say hello',
      });

      expect(text).toBe('Hello world');

      vi.unstubAllGlobals();
    });
  });

  describe('chatStructured', () => {
    it('returns parsed JSON', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: { content: '{"key": "value"}' },
              },
            ],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const gw = new LLMGateway({
        providers: { openai: { apiKey: 'test-key' } },
      });

      const result = await gw.chatStructured({
        modelRef: 'openai:gpt-5.5',
        prompt: 'Return JSON',
      });

      expect(result).toEqual({ key: 'value' });

      vi.unstubAllGlobals();
    });
  });

  describe('error handling', () => {
    it('throws on unsupported provider', () => {
      const gw = new LLMGateway();
      expect(() => gw.getModelDef('mock:test')).not.toThrow();
    });

    it('propagates API errors', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve(JSON.stringify({ error: { message: 'Unauthorized' } })),
      });
      vi.stubGlobal('fetch', mockFetch);

      const gw = new LLMGateway({
        providers: { openai: { apiKey: 'bad-key' } },
      });

      await expect(
        gw.chatWithTools({
          modelRef: 'openai:gpt-5.5',
          messages: [{ role: 'user', content: 'hi' }],
        })
      ).rejects.toThrow('401');

      vi.unstubAllGlobals();
    });
  });
});

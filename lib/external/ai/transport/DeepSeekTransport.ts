/**
 * DeepSeekTransport — DeepSeek Chat Completions API 协议转换
 *
 * V4 thinking 模式特殊处理：
 *   - thinking 模式下 temperature/top_p 无效
 *   - thinking 模式下 tool_choice 不支持
 *   - reasoning_content 在带 tool_calls 的 assistant 消息中必须回传
 *   - max_tokens 自动提升以容纳 reasoning token
 */

import type { ToolSchema, UnifiedMessage } from '../AiProvider.js';
import {
  LLMTransport,
  type TransportConfig,
  type TransportFunctionCall,
  type TransportRequest,
  type TransportResponse,
} from './LLMTransport.js';

const DEEPSEEK_BASE = 'https://api.deepseek.com';
const V4_PATTERN = /deepseek-v4/i;
const VALID_EFFORTS = new Set(['high', 'max']);

export class DeepSeekTransport extends LLMTransport {
  #reasoningEffort: string;

  constructor(config: TransportConfig) {
    super('deepseek', { ...config, baseUrl: config.baseUrl || DEEPSEEK_BASE });
    const effort = (config.reasoningEffort as string) || 'high';
    this.#reasoningEffort = VALID_EFFORTS.has(effort) ? effort : 'high';
  }

  async chat(request: TransportRequest): Promise<string> {
    this.requireApiKey('DeepSeek');

    const messages = this.#buildSimpleMessages(request.messages, request.systemPrompt);
    const isV4 = V4_PATTERN.test(request.model);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
    };
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (isV4) {
      body.thinking = { type: 'disabled' };
    }
    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const data = await this.post(
      `${this.baseUrl}/chat/completions`,
      body,
      this.#headers(),
      request.abortSignal
    );
    const choices = (data?.choices as Array<Record<string, unknown>>) || [];
    const message = choices[0]?.message as Record<string, string> | undefined;
    return message?.content || '';
  }

  async chatWithTools(request: TransportRequest): Promise<TransportResponse> {
    this.requireApiKey('DeepSeek');

    const hasTools = request.tools && request.tools.length > 0;
    const isV4 = V4_PATTERN.test(request.model);
    const v4Thinking = isV4 && hasTools;

    const messages = this.#buildToolMessages(request.messages, request.systemPrompt, v4Thinking);

    if (v4Thinking) {
      this.#validateV4Messages(messages);
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
    };

    if (!v4Thinking && request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (isV4) {
      if (hasTools) {
        body.thinking = { type: 'enabled' };
        const effort = request.reasoningEffort || this.#reasoningEffort;
        body.reasoning_effort = effort;
        const minTokens = effort === 'max' ? 32768 : 16384;
        if ((request.maxTokens || 0) < minTokens) {
          body.max_tokens = minTokens;
        }
      } else {
        body.thinking = { type: 'disabled' };
      }
    }

    if (hasTools) {
      body.tools = request.tools?.map((s: ToolSchema) => ({
        type: 'function',
        function: {
          name: s.name,
          description: s.description || '',
          parameters: s.parameters || { type: 'object', properties: {} },
        },
      }));
    }

    if (request.toolChoice && !v4Thinking) {
      body.tool_choice = request.toolChoice;
    }

    const data = await this.post(
      `${this.baseUrl}/chat/completions`,
      body,
      this.#headers(),
      request.abortSignal
    );

    return this.#parseResponse(data);
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.requireApiKey('DeepSeek');
    const body = {
      model: 'deepseek-embedding',
      input: texts.map((t) => t.slice(0, 8000)),
    };
    const data = await this.post(`${this.baseUrl}/embeddings`, body, this.#headers());
    const items = ((data as Record<string, unknown>)?.data || []) as Array<{
      index: number;
      embedding: number[];
    }>;
    return items.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  // ─── 消息转换 ──────────────────────────────────────

  #buildSimpleMessages(
    unified: UnifiedMessage[],
    systemPrompt?: string
  ): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    for (const msg of unified) {
      messages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      });
    }
    return messages;
  }

  #buildToolMessages(
    unified: UnifiedMessage[],
    systemPrompt?: string,
    v4Thinking?: boolean
  ): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of unified) {
      if (msg.role === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        const m: Record<string, unknown> = { role: 'assistant', content: msg.content || null };
        if (v4Thinking) {
          m.reasoning_content = msg.reasoningContent ?? '';
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          m.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
          }));
        }
        messages.push(m);
      } else if (msg.role === 'tool') {
        messages.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content: msg.content || '',
        });
      }
    }

    return messages;
  }

  #validateV4Messages(messages: Array<Record<string, unknown>>): void {
    for (const m of messages) {
      if (m.role !== 'assistant') {
        continue;
      }
      const hasTC = Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0;
      if (hasTC && m.reasoning_content == null) {
        m.reasoning_content = '';
      }
    }
  }

  // ─── 响应解析 ──────────────────────────────────────

  #parseResponse(data: Record<string, unknown>): TransportResponse {
    const choices = (data?.choices as Array<Record<string, unknown>>) || [];
    const choice = choices[0];
    const rawUsage = data?.usage as Record<string, unknown> | undefined;

    const usage = rawUsage
      ? {
          inputTokens: (rawUsage.prompt_tokens as number) || 0,
          outputTokens: (rawUsage.completion_tokens as number) || 0,
          totalTokens: (rawUsage.total_tokens as number) || 0,
          reasoningTokens:
            (rawUsage.completion_tokens_details as Record<string, number>)?.reasoning_tokens || 0,
          cacheHitTokens:
            (rawUsage.prompt_cache_hit_tokens as number) ||
            (rawUsage.prompt_tokens_details as Record<string, number>)?.cached_tokens ||
            0,
        }
      : null;

    if (!choice) {
      return { text: '', functionCalls: null, usage };
    }

    const message = choice.message as Record<string, unknown>;
    const text = (message?.content as string) || null;
    const reasoningContent = (message?.reasoning_content as string) ?? null;

    const toolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls && toolCalls.length > 0) {
      const functionCalls: TransportFunctionCall[] = toolCalls
        .filter((tc) => tc.type === 'function')
        .map((tc) => ({
          id: tc.id as string,
          name: (tc.function as Record<string, unknown>).name as string,
          args: (() => {
            try {
              return JSON.parse(
                ((tc.function as Record<string, unknown>).arguments as string) || '{}'
              );
            } catch {
              return {};
            }
          })(),
        }));

      if (functionCalls.length > 0) {
        return { text, functionCalls, usage, reasoningContent };
      }
    }

    return { text, functionCalls: null, usage, reasoningContent };
  }

  #headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }
}

/**
 * OpenAiTransport — OpenAI Chat Completions API 协议转换
 *
 * 纯协议层：UnifiedMessage ↔ OpenAI messages 格式
 * 不含参数校验逻辑（由 Gateway 层 ParameterGuard 负责）
 */

import type { ToolSchema, UnifiedMessage } from '../AiProvider.js';
import {
  LLMTransport,
  type TransportConfig,
  type TransportFunctionCall,
  type TransportRequest,
  type TransportResponse,
} from './LLMTransport.js';

const OPENAI_BASE = 'https://api.openai.com/v1';

export class OpenAiTransport extends LLMTransport {
  #embedModel: string;

  constructor(config: TransportConfig) {
    super('openai', { ...config, baseUrl: config.baseUrl || OPENAI_BASE });
    this.#embedModel = (config.embedModel as string) || 'text-embedding-3-small';
  }

  async chat(request: TransportRequest): Promise<string> {
    this.requireApiKey('OpenAI');

    const messages = this.#buildMessages(request.messages, request.systemPrompt);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
    };
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.reasoningEffort) {
      body.reasoning_effort = request.reasoningEffort;
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
    this.requireApiKey('OpenAI');

    const messages = this.#buildMessages(request.messages, request.systemPrompt);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
    };
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.reasoningEffort) {
      body.reasoning_effort = request.reasoningEffort;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((s: ToolSchema) => ({
        type: 'function',
        function: {
          name: s.name,
          description: s.description || '',
          parameters: s.parameters || { type: 'object', properties: {} },
        },
      }));
    }

    if (request.toolChoice) {
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
    this.requireApiKey('OpenAI');
    const body = {
      model: this.#embedModel,
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

  #buildMessages(unified: UnifiedMessage[], systemPrompt?: string): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of unified) {
      if (msg.role === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        const m: Record<string, unknown> = { role: 'assistant', content: msg.content || null };
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

  // ─── 响应解析 ──────────────────────────────────────

  #parseResponse(data: Record<string, unknown>): TransportResponse {
    const choices = data?.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const rawUsage = data?.usage as Record<string, number> | undefined;

    const usage = rawUsage
      ? {
          inputTokens: rawUsage.prompt_tokens || 0,
          outputTokens: rawUsage.completion_tokens || 0,
          totalTokens: rawUsage.total_tokens || 0,
        }
      : null;

    if (!choice) {
      return { text: '', functionCalls: null, usage };
    }

    const message = choice.message as Record<string, unknown>;
    const text = (message?.content as string) || null;

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
        return { text, functionCalls, usage };
      }
    }

    return { text, functionCalls: null, usage };
  }

  #headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }
}

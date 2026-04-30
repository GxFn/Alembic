/**
 * OllamaProvider - Ollama 本地 AI 提供商
 *
 * 连接本地 Ollama 服务（OpenAI 兼容 API 格式），独立实现。
 * 无需 API Key，使用固定 dummy key。
 * 支持本地部署的 LLM 和 Embedding 模型。
 */

import Logger from '#infra/logging/Logger.js';
import {
  AiProvider,
  type AiProviderConfig,
  type ApiResponse,
  type ChatContext,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type StructuredOutputOptions,
  type ToolSchema,
  type UnifiedMessage,
} from '../AiProvider.js';

const OLLAMA_DEFAULT_BASE = 'http://localhost:11434/v1';
const OLLAMA_DUMMY_KEY = 'ollama';

export class OllamaProvider extends AiProvider {
  embedModel: string;

  constructor(config: AiProviderConfig = {}) {
    super(config);
    this.name = 'ollama';
    this.model = config.model || 'llama3';
    this.apiKey = config.apiKey || OLLAMA_DUMMY_KEY;
    this.baseUrl = config.baseUrl || process.env.ALEMBIC_OLLAMA_BASE_URL || OLLAMA_DEFAULT_BASE;
    this.embedModel = config.embedModel || 'qwen3-embedding:0.6b';
    this.logger = Logger.getInstance() as unknown as import('../AiProvider.js').AiLogger;
  }

  get supportsNativeToolCalling() {
    return true;
  }

  async chat(prompt: string, context: ChatContext = {}) {
    return this._withRetry(async () => {
      const { history = [], temperature = 0.7, maxTokens = 4096 } = context;
      const messages: Array<{ role: string; content: string }> = [];

      for (const h of history) {
        messages.push({ role: h.role, content: h.content });
      }
      messages.push({ role: 'user', content: prompt });

      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      };

      const data = await this.#post(`${this.baseUrl}/chat/completions`, body);
      this.#emitUsage(data);
      return data?.choices?.[0]?.message?.content || '';
    });
  }

  async chatWithTools(
    prompt: string,
    opts: ChatWithToolsOptions = {}
  ): Promise<ChatWithToolsResult> {
    return this._withRetry(async () => {
      const {
        messages: rawMessages,
        toolSchemas: rawToolSchemas,
        toolChoice = 'auto',
        systemPrompt,
        temperature = 0.7,
        maxTokens = 4096,
      } = opts;
      const unifiedMessages = rawMessages as UnifiedMessage[] | undefined;
      const toolSchemas = rawToolSchemas as ToolSchema[] | undefined;

      const messages: Array<Record<string, unknown>> = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      const srcMessages: UnifiedMessage[] =
        unifiedMessages && unifiedMessages.length > 0
          ? unifiedMessages
          : [{ role: 'user' as const, content: prompt }];

      for (const msg of srcMessages) {
        if (msg.role === 'user') {
          messages.push({ role: 'user', content: msg.content });
        } else if (msg.role === 'assistant') {
          const m: Record<string, unknown> = { role: 'assistant', content: msg.content || null };
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            m.tool_calls = msg.toolCalls.map(
              (tc: { id: string; name: string; args: Record<string, unknown> }) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
              })
            );
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

      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      };

      if (toolSchemas && toolSchemas.length > 0) {
        body.tools = toolSchemas.map((s: ToolSchema) => ({
          type: 'function',
          function: {
            name: s.name,
            description: s.description || '',
            parameters: s.parameters || { type: 'object', properties: {} },
          },
        }));
      }

      if (toolChoice === 'required') {
        body.tool_choice = 'required';
      } else if (toolChoice === 'none') {
        body.tool_choice = 'none';
      } else {
        body.tool_choice = 'auto';
      }

      const data = await this.#post(`${this.baseUrl}/chat/completions`, body, opts.abortSignal);
      return this.#parseToolResponse(data);
    });
  }

  async summarize(code: string) {
    const prompt = `请对以下代码生成结构化摘要，返回 JSON 格式 {title, description, language, patterns: [], keyAPIs: []}:\n\n${code}`;
    return (
      (await this.chatWithStructuredOutput(prompt, { temperature: 0.3, maxTokens: 4096 })) || {
        title: '',
        description: '',
      }
    );
  }

  async chatWithStructuredOutput(prompt: string, opts: StructuredOutputOptions = {}) {
    return this._withRetry(async () => {
      const { temperature = 0.3, maxTokens = 32768, systemPrompt } = opts;

      const messages: Array<{ role: string; content: string }> = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      };

      const data = await this.#post(`${this.baseUrl}/chat/completions`, body);
      this.#emitUsage(data);

      const text = data?.choices?.[0]?.message?.content || '';
      if (!text) {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        const openChar = opts.openChar || '{';
        const closeChar = opts.closeChar || '}';
        return this.extractJSON(text, openChar, closeChar);
      }
    });
  }

  async embed(text: string | string[]) {
    const texts = Array.isArray(text) ? text : [text];
    try {
      const body = {
        model: this.embedModel,
        input: texts.map((t) => t.slice(0, 8000)),
      };
      const data = await this.#post(`${this.baseUrl}/embeddings`, body);
      const embeddings = (data?.data || [])
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
        .map((d: { embedding: number[] }) => d.embedding);

      if (embeddings.length === 0) {
        return Array.isArray(text) ? [] : [];
      }
      return Array.isArray(text) ? embeddings : embeddings[0];
    } catch (err: unknown) {
      this.logger?.warn(`Ollama embed failed, returning empty`, {
        error: (err as Error).message,
      });
      return Array.isArray(text) ? texts.map(() => []) : [];
    }
  }

  // ─── 响应解析 ──────────────────────────────────────────

  #parseToolResponse(data: ApiResponse) {
    const choice = data?.choices?.[0];

    const usage = data?.usage
      ? {
          inputTokens: data.usage.prompt_tokens || 0,
          outputTokens: data.usage.completion_tokens || 0,
          totalTokens: data.usage.total_tokens || 0,
        }
      : null;

    if (!choice) {
      return { text: '', functionCalls: null, usage };
    }

    const message = choice.message;
    const text = message?.content || null;

    if (message?.tool_calls?.length > 0) {
      const functionCalls = message.tool_calls
        .filter((tc: Record<string, unknown>) => tc.type === 'function')
        .map((tc: Record<string, unknown>) => ({
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
        this.logger?.debug(
          `[Ollama] native function calls: ${functionCalls.map((fc: { name: string }) => fc.name).join(', ')}`
        );
        return { text, functionCalls, usage };
      }
    }

    return { text, functionCalls: null, usage };
  }

  #emitUsage(data: ApiResponse) {
    if (data?.usage) {
      this._emitTokenUsage({
        inputTokens: data.usage.prompt_tokens || 0,
        outputTokens: data.usage.completion_tokens || 0,
        totalTokens: data.usage.total_tokens || 0,
      });
    }
  }

  // ─── HTTP ──────────────────────────────────────────────

  async #post(
    url: string,
    body: Record<string, unknown>,
    externalSignal?: AbortSignal
  ): Promise<ApiResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const res = await this._fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = '';
        try {
          const errBody = await res.text();
          const parsed = JSON.parse(errBody);
          detail = parsed?.error?.message || errBody.slice(0, 300);
        } catch {
          /* best effort */
        }
        const err = new Error(
          `Ollama API error: ${res.status}${detail ? ` — ${detail}` : ''}`
        ) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as ApiResponse;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

export default OllamaProvider;

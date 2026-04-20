/**
 * OpenAiProvider - OpenAI / DeepSeek / Ollama 兼容提供商
 * 使用标准 OpenAI Chat Completions API
 *
 * v2: 支持原生 Function Calling（结构化工具调用）
 *     - 使用 Chat Completions API 的 tools + tool_choice 参数
 *     - 兼容 DeepSeek / Ollama 等 OpenAI-compatible API
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

const OPENAI_BASE = 'https://api.openai.com/v1';

export class OpenAiProvider extends AiProvider {
  embedModel: string;

  constructor(config: AiProviderConfig = {}) {
    super(config);
    this.name = config.name || 'openai';
    this.model = config.model || 'gpt-5.4-mini';
    this.apiKey = config.apiKey || process.env.ALEMBIC_OPENAI_API_KEY || '';
    this.baseUrl = config.baseUrl || OPENAI_BASE;
    this.embedModel =
      config.embedModel || process.env.ALEMBIC_EMBED_MODEL || 'text-embedding-3-small';
    this.logger = Logger.getInstance() as unknown as import('../AiProvider.js').AiLogger;
  }

  /**
   * 是否支持原生结构化函数调用
   * OpenAI / DeepSeek Chat Completions API 均支持
   */
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

      const body = {
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      };

      const data = await this._post(`${this.baseUrl}/chat/completions`, body);

      // 提取 token 用量
      if (data?.usage) {
        this._emitTokenUsage({
          inputTokens: data.usage.prompt_tokens || 0,
          outputTokens: data.usage.completion_tokens || 0,
          totalTokens: data.usage.total_tokens || 0,
        });
      }

      return data?.choices?.[0]?.message?.content || '';
    });
  }

  /**
   * 带工具声明的结构化对话 — OpenAI Chat Completions Function Calling
   *
   * 接受统一消息格式，内部转换为 OpenAI Chat Completions 消息格式。
   * 兼容 DeepSeek / Ollama 等 OpenAI-Compatible API。
   *
   * @param prompt fallback prompt
   * @param opts 统一参数
   * @returns >|null}>}
   */
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

      // 统一消息 → OpenAI Chat Completions messages
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
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.args || {}),
                },
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

      // 标准 tool schemas → OpenAI tools format
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

      // toolChoice → OpenAI tool_choice
      if (toolChoice === 'required') {
        body.tool_choice = 'required';
      } else if (toolChoice === 'none') {
        body.tool_choice = 'none';
      } else {
        body.tool_choice = 'auto';
      }

      const data = await this._post(`${this.baseUrl}/chat/completions`, body, opts.abortSignal);
      return this.#parseToolResponse(data);
    });
  }

  /**
   * 解析 OpenAI Chat Completions 响应 — 提取 tool_calls 或 text
   *
   * OpenAI 返回格式:
   *   choices[0].message.tool_calls[]: { id, type: 'function', function: { name, arguments(JSON str) } }
   */
  #parseToolResponse(data: ApiResponse) {
    const choice = data?.choices?.[0];

    // 提取 token 用量 (OpenAI usage)
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
          `[OpenAI] native function calls: ${functionCalls.map((fc: { name: string }) => fc.name).join(', ')}`
        );
        return { text, functionCalls, usage };
      }
    }

    return { text, functionCalls: null, usage };
  }

  async summarize(code: string) {
    const prompt = `请对以下代码生成结构化摘要，返回 JSON 格式 {title, description, language, patterns: [], keyAPIs: []}:\n\n${code}`;
    return (
      (await this.chatWithStructuredOutput(prompt, {
        temperature: 0.3,
        maxTokens: 4096,
      })) || { title: '', description: '' }
    );
  }

  /**
   * Structured Output — OpenAI JSON mode
   *
   * 使用 response_format: { type: 'json_object' } 强制返回合法 JSON。
   * 兼容 DeepSeek / Ollama 等 OpenAI-Compatible API。
   */
  async chatWithStructuredOutput(prompt: string, opts: StructuredOutputOptions = {}) {
    return this._withRetry(async () => {
      const { temperature = 0.3, maxTokens = 32768, systemPrompt } = opts;

      const messages: Array<{ role: string; content: string }> = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      const body = {
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      };

      const data = await this._post(`${this.baseUrl}/chat/completions`, body);

      // 提取 token 用量
      if (data?.usage) {
        this._emitTokenUsage({
          inputTokens: data.usage.prompt_tokens || 0,
          outputTokens: data.usage.completion_tokens || 0,
          totalTokens: data.usage.total_tokens || 0,
        });
      }

      const text = data?.choices?.[0]?.message?.content || '';

      if (!text) {
        return null;
      }

      try {
        return JSON.parse(text);
      } catch {
        // JSON mode 极少出错，降级到 extractJSON
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

      const data = await this._post(`${this.baseUrl}/embeddings`, body);
      const embeddings = (data?.data || [])
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
        .map((d: { embedding: number[] }) => d.embedding);

      if (embeddings.length === 0) {
        return Array.isArray(text) ? [] : [];
      }
      return Array.isArray(text) ? embeddings : embeddings[0];
    } catch (err: unknown) {
      this.logger?.warn(`${this.name} embed failed, returning empty`, {
        error: (err as Error).message,
      });
      return Array.isArray(text) ? texts.map(() => []) : [];
    }
  }

  async _post(
    url: string,
    body: Record<string, unknown>,
    externalSignal?: AbortSignal
  ): Promise<ApiResponse> {
    // Ollama 使用固定 dummy key，不需要校验
    if (!this.apiKey && this.name !== 'ollama') {
      const envKey =
        this.name === 'deepseek' ? 'ALEMBIC_DEEPSEEK_API_KEY' : 'ALEMBIC_OPENAI_API_KEY';
      const err = new Error(
        `${this.name} API Key 未配置。请在 .env 中设置 ${envKey}，或运行 alembic setup 完成配置。`
      ) as Error & { code: string };
      err.code = 'API_KEY_MISSING';
      throw err;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    // 外部中止信号 → 联动本地 controller
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
        const err = new Error(`${this.name} API error: ${res.status}`) as Error & {
          status: number;
        };
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

export default OpenAiProvider;

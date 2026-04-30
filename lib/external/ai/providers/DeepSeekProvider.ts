/**
 * DeepSeekProvider - DeepSeek AI 提供商
 *
 * 使用 DeepSeek Chat Completions API（OpenAI 兼容格式），独立实现。
 *
 * V4 thinking 模式完整支持 (基于官方文档 2026-04):
 *   - chat() / chatWithStructuredOutput(): 单轮调用，关闭 thinking 节省 token
 *   - chatWithTools() 智能 thinking 策略:
 *     - 有 tools: 开启 thinking + reasoning_effort，帮助工具决策
 *     - 无 tools (SUMMARIZE/forced-summary): 关闭 thinking，纯文本生成
 *     - 有 tool_calls 的 assistant 消息: reasoning_content 必须回传（否则 400）
 *     - 纯文本 assistant 消息: reasoning_content 不回传（省 token）
 *     - V4 thinking 模式不支持 tool_choice，由模型自主决策
 *   - 支持 reasoning_effort: "high"(默认) / "max"(复杂 Agent 任务)
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

const DEEPSEEK_BASE = 'https://api.deepseek.com';
const V4_PATTERN = /deepseek-v4/i;
const VALID_EFFORTS = new Set(['high', 'max']);

export class DeepSeekProvider extends AiProvider {
  /** V4 推理力度: "high"(默认) 或 "max"(复杂 Agent 任务) */
  #reasoningEffort: string;

  constructor(config: AiProviderConfig = {}) {
    super(config);
    this.name = 'deepseek';
    this.model = config.model || process.env.ALEMBIC_AI_MODEL || 'deepseek-v4-flash';
    this.apiKey = config.apiKey || process.env.ALEMBIC_DEEPSEEK_API_KEY || '';
    this.baseUrl = config.baseUrl || process.env.ALEMBIC_DEEPSEEK_BASE_URL || DEEPSEEK_BASE;
    this.logger = Logger.getInstance() as unknown as import('../AiProvider.js').AiLogger;

    const effort =
      (config.reasoningEffort as string) || process.env.ALEMBIC_DEEPSEEK_REASONING_EFFORT || 'high';
    this.#reasoningEffort = VALID_EFFORTS.has(effort) ? effort : 'high';
  }

  #isV4() {
    return V4_PATTERN.test(this.model);
  }

  get supportsNativeToolCalling() {
    return true;
  }

  /**
   * chat() 是单轮调用，无多轮 reasoning_content 回传需求。
   * V4 关闭 thinking 以节省 token。
   */
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
      if (this.#isV4()) {
        body.thinking = { type: 'disabled' };
      }

      const data = await this.#post(`${this.baseUrl}/chat/completions`, body);
      this.#emitUsage(data);
      return data?.choices?.[0]?.message?.content || '';
    });
  }

  /**
   * chatWithTools() 是多轮 Agent 循环的核心。
   *
   * V4 thinking 模式策略 (遵循官方文档):
   *   - 开启 thinking，reasoning_effort 默认 "high"
   *   - 有 tool_calls 的 assistant 消息: 回传 reasoning_content（必须）
   *   - 纯文本 assistant 消息: 不回传 reasoning_content（省 token）
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
          const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;
          // 官方要求: 只有带 tool_calls 的 assistant 消息才必须回传 reasoning_content
          if (hasToolCalls && msg.reasoningContent) {
            m.reasoning_content = msg.reasoningContent;
          }
          if (hasToolCalls) {
            m.tool_calls = msg.toolCalls!.map(
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

      const hasTools = toolSchemas && toolSchemas.length > 0;

      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      };

      if (this.#isV4()) {
        if (hasTools) {
          // 有工具: 开启 thinking（V4 默认），设置 reasoning_effort
          // thinking 帮助模型决策何时/如何调用工具
          body.reasoning_effort = this.#reasoningEffort;
          // thinking 的 reasoning_content 也占 output token，确保留够空间
          if (maxTokens < 16384) {
            body.max_tokens = 16384;
          }
        } else {
          // 无工具: 关闭 thinking 节省 token（纯文本生成/总结场景）
          body.thinking = { type: 'disabled' };
        }
      }

      if (hasTools) {
        body.tools = toolSchemas!.map((s: ToolSchema) => ({
          type: 'function',
          function: {
            name: s.name,
            description: s.description || '',
            parameters: s.parameters || { type: 'object', properties: {} },
          },
        }));
      }

      // V4 thinking 模式下 API 不支持 tool_choice（内部走 reasoner 后端）
      if (!this.#isV4()) {
        if (toolChoice === 'required') {
          body.tool_choice = 'required';
        } else if (toolChoice === 'none') {
          body.tool_choice = 'none';
        } else {
          body.tool_choice = 'auto';
        }
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

  /**
   * chatWithStructuredOutput() 是单轮调用，关闭 thinking 节省 token。
   */
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
      if (this.#isV4()) {
        body.thinking = { type: 'disabled' };
      }

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
        model: 'deepseek-embedding',
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
      this.logger?.warn(`DeepSeek embed failed, returning empty`, {
        error: (err as Error).message,
      });
      return Array.isArray(text) ? texts.map(() => []) : [];
    }
  }

  // ─── 响应解析 ──────────────────────────────────────────

  #parseToolResponse(data: ApiResponse): ChatWithToolsResult {
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
    const reasoningContent = message?.reasoning_content || null;

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
          `[DeepSeek] native function calls: ${functionCalls.map((fc: { name: string }) => fc.name).join(', ')}`
        );
        return { text, functionCalls, usage, reasoningContent };
      }
    }

    return { text, functionCalls: null, usage, reasoningContent };
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
    if (!this.apiKey) {
      const err = new Error(
        'DeepSeek API Key 未配置。请在 .env 中设置 ALEMBIC_DEEPSEEK_API_KEY，或运行 alembic setup 完成配置。'
      ) as Error & { code: string };
      err.code = 'API_KEY_MISSING';
      throw err;
    }

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
          `DeepSeek API error: ${res.status}${detail ? ` — ${detail}` : ''}`
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

export default DeepSeekProvider;

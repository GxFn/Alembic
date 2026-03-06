/**
 * ClaudeProvider - Anthropic Claude AI 提供商
 *
 * v2: 支持原生 Function Calling（结构化工具调用）
 *     - 使用 Anthropic Messages API 的 tools + tool_choice 参数
 *     - 响应中的 tool_use content blocks → 结构化 functionCall
 *     - tool_result content blocks 用于回传工具执行结果
 */

import Logger from '../../../infrastructure/logging/Logger.js';
import { AiProvider } from '../AiProvider.js';

const CLAUDE_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

export class ClaudeProvider extends AiProvider {




  constructor(config: any = {}) {
    super(config);
    this.name = 'claude';
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.apiKey = config.apiKey || process.env.ASD_CLAUDE_API_KEY || '';
    this.maxRetries = 0; // Claude 不做重试
    this.logger = Logger.getInstance();
  }

  /**
   * 是否支持原生结构化函数调用
   */
  get supportsNativeToolCalling() {
    return true;
  }

  async chat(prompt, context: any = {}) {
    const { history = [], temperature = 0.7, maxTokens = 4096 } = context;
    const messages = [];

    for (const h of history) {
      messages.push({ role: h.role, content: h.content });
    }
    messages.push({ role: 'user', content: prompt });

    const body: any = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    };

    const data = await this._post(`${CLAUDE_BASE}/messages`, body);
    const textBlock = (data?.content || []).find((c) => c.type === 'text');
    return textBlock?.text || '';
  }

  /**
   * 带工具声明的结构化对话 — Anthropic Messages API Tool Use
   *
   * 接受统一消息格式，内部转换为 Anthropic Messages 格式。
   *
   * Anthropic 特殊之处:
   *   - system prompt 是顶层 `system` 字段（非 message）
   *   - assistant 消息的 content 是 content blocks 数组
   *   - 工具结果通过 user 消息中的 tool_result blocks 传递
   *   - tool_choice: {type: 'auto'|'any'|'tool'}（无 'none'，不传 tools 即可）
   *
   * @param {string} prompt - fallback prompt
   * @param {object} opts 统一参数
   * @returns {Promise<{text: string|null, functionCalls: Array<{id, name, args}>|null}>}
   */
  // @ts-expect-error TS migration: TS2416
  async chatWithTools(prompt, opts: any = {}) {
    const {
      messages: unifiedMessages,
      toolSchemas,
      toolChoice = 'auto',
      systemPrompt,
      temperature = 0.7,
      maxTokens = 4096,
    } = opts;

    // 统一消息 → Anthropic Messages 格式
    const srcMessages =
      unifiedMessages?.length > 0 ? unifiedMessages : [{ role: 'user', content: prompt }];

    const messages = this.#convertMessages(srcMessages);

    const body: any = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    };

    // system prompt → 顶层字段
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    // 工具声明 + tool_choice
    // toolChoice='none' 时不传 tools（Anthropic 没有 'none' tool_choice）
    if (toolChoice !== 'none' && toolSchemas?.length > 0) {
      body.tools = toolSchemas.map((s) => ({
        name: s.name,
        description: s.description || '',
        input_schema: s.parameters || { type: 'object', properties: {} },
      }));

      if (toolChoice === 'required') {
        body.tool_choice = { type: 'any' };
      } else {
        body.tool_choice = { type: 'auto' };
      }
    }

    const data = await this._post(`${CLAUDE_BASE}/messages`, body);
    return this.#parseToolResponse(data);
  }

  // ─── 内部转换方法 ──────────────────────

  /**
   * 统一消息格式 → Anthropic Messages 格式
   *
   * - user → {role: 'user', content: 'text'}
   * - assistant → {role: 'assistant', content: [{type:'text'}, {type:'tool_use'}...]}
   * - tool → grouped into {role: 'user', content: [{type:'tool_result'}...]}
   *
   * Anthropic 要求消息交替 user/assistant。连续 tool results 合并为一个 user 消息。
   * 连续同角色消息（如 L2/L3 压缩后的摘要）自动合并以避免 400 错误。
   */
  #convertMessages(messages) {
    const result = [];

    /**
     * 推入 result，如果上一个 entry 同角色则合并 content
     */
    const pushOrMerge = (entry) => {
      const last = result[result.length - 1];
      if (last && last.role === entry.role) {
        // Anthropic content 可以是 string 或 array
        const lastContent = Array.isArray(last.content)
          ? last.content
          : [{ type: 'text', text: last.content || '' }];
        const newContent = Array.isArray(entry.content)
          ? entry.content
          : [{ type: 'text', text: entry.content || '' }];
        last.content = [...lastContent, ...newContent];
      } else {
        result.push(entry);
      }
    };

    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === 'user') {
        pushOrMerge({ role: 'user', content: msg.content || '' });
        i++;
      } else if (msg.role === 'assistant') {
        const content = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        if (msg.toolCalls?.length > 0) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.args || {},
            });
          }
        }
        pushOrMerge({
          role: 'assistant',
          content: content.length > 0 ? content : [{ type: 'text', text: '' }],
        });
        i++;
      } else if (msg.role === 'tool') {
        // 收集连续 tool results → 合并为一个 user 消息
        const toolResults = [];
        while (i < messages.length && messages[i].role === 'tool') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: messages[i].toolCallId,
            content: messages[i].content || '',
          });
          i++;
        }
        pushOrMerge({ role: 'user', content: toolResults });
      } else {
        i++; // skip unknown roles
      }
    }

    return result;
  }

  /**
   * 解析 Anthropic Messages API 响应 — 提取 tool_use 或 text
   *
   * Anthropic 返回格式:
   *   content[]: { type: 'text', text } | { type: 'tool_use', id, name, input }
   *   stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'
   */
  #parseToolResponse(data) {
    // 提取 token 用量 (Claude usage)
    const usage = data?.usage
      ? {
          inputTokens: data.usage.input_tokens || 0,
          outputTokens: data.usage.output_tokens || 0,
          totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        }
      : null;

    if (!data?.content?.length) {
      return { text: '', functionCalls: null, usage };
    }

    const functionCalls = [];
    const textParts = [];

    for (const block of data.content) {
      if (block.type === 'tool_use') {
        functionCalls.push({
          id: block.id,
          name: block.name,
          args: block.input || {},
        });
      } else if (block.type === 'text') {
        textParts.push(block.text);
      }
    }

    if (functionCalls.length > 0) {
      this.logger.debug(
        `[Claude] native function calls: ${functionCalls.map((fc) => fc.name).join(', ')}`
      );
      return {
        text: textParts.length > 0 ? textParts.join('\n') : null,
        functionCalls,
        usage,
      };
    }

    return {
      text: textParts.join('\n'),
      functionCalls: null,
      usage,
    };
  }

  async summarize(code) {
    const prompt = `请对以下代码生成结构化摘要，返回 JSON 格式 {title, description, language, patterns: [], keyAPIs: []}:\n\n${code}`;
    return (
      (await this.chatWithStructuredOutput(prompt, {
        temperature: 0.3,
        maxTokens: 4096,
      })) || { title: '', description: '' }
    );
  }

  // @ts-expect-error TS migration: TS2416
  async embed(_text) {
    // Claude 不支持嵌入 API，返回空数组触发降级
    return [];
  }

  supportsEmbedding() {
    return false;
  }

  async _post(url, body) {
    if (!this.apiKey) {
      const err = new Error(
        'Claude API Key 未配置。请在 .env 中设置 ASD_CLAUDE_API_KEY，或运行 asd setup 完成配置。'
      );
      // @ts-expect-error TS migration: TS2339
      err.code = 'API_KEY_MISSING';
      throw err;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await this._fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = new Error(`Claude API error: ${res.status}`);
        // @ts-expect-error TS migration: TS2339
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

export default ClaudeProvider;

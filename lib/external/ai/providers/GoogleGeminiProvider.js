/**
 * GoogleGeminiProvider - Google Gemini AI 提供商
 * 直接调用 REST API（不依赖 SDK）
 *
 * v3: 统一消息格式 — chatWithTools() 接受 Provider-Agnostic 消息
 *     内部自动转换为 Gemini 原生 contents / functionDeclarations 格式
 *     支持 toolChoice: 'auto' | 'required' | 'none'
 */

import { AiProvider } from '../AiProvider.js';
import Logger from '../../../infrastructure/logging/Logger.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const EMBED_MODEL = 'models/gemini-embedding-001';

export class GoogleGeminiProvider extends AiProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'google-gemini';
    this.model = config.model || 'gemini-3-flash-preview';
    this.apiKey = config.apiKey || process.env.ASD_GOOGLE_API_KEY || '';
    this.logger = Logger.getInstance();
  }

  /**
   * 是否支持原生结构化函数调用
   */
  get supportsNativeToolCalling() {
    return true;
  }

  async chat(prompt, context = {}) {
    return this._withRetry(async () => {
      const { history = [], temperature = 0.7, maxTokens = 8192, systemPrompt } = context;
      const contents = [];

      for (const h of history) {
        contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] });
      }
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      const body = {
        contents,
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        },
      };

      // systemInstruction 支持（chat 也可用 systemPrompt）
      if (systemPrompt) {
        body.systemInstruction = { parts: [{ text: systemPrompt }] };
      }

      const url = `${GEMINI_BASE}/models/${this.model}:generateContent?key=${this.apiKey}`;
      const data = await this._post(url, body);
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    });
  }

  /**
   * 带工具声明的结构化对话 — Gemini 原生 Function Calling
   *
   * 接受统一消息格式，内部转换为 Gemini 原生 contents 格式。
   *
   * @param {string} prompt — 未使用 messages 时的 fallback prompt
   * @param {object} opts
   * @param {Array}  opts.messages — 统一格式消息
   * @param {Array}  opts.toolSchemas — [{name, description, parameters}]
   * @param {string} opts.toolChoice — 'auto' | 'required' | 'none'
   * @param {string} [opts.systemPrompt]
   * @param {number} [opts.temperature=0.7]
   * @param {number} [opts.maxTokens=8192]
   * @returns {Promise<{text: string|null, functionCalls: Array<{id, name, args}>|null}>}
   */
  async chatWithTools(prompt, opts = {}) {
    return this._withRetry(async () => {
      const {
        messages,
        toolSchemas,
        toolChoice = 'auto',
        systemPrompt,
        temperature = 0.7,
        maxTokens = 8192,
      } = opts;

      // 统一消息 → Gemini contents
      const contents = messages?.length > 0
        ? this.#convertMessages(messages)
        : [{ role: 'user', parts: [{ text: prompt }] }];

      const body = {
        contents,
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        },
      };

      // 工具声明: 标准 schema → Gemini functionDeclarations
      if (toolSchemas?.length > 0) {
        body.tools = [{
          functionDeclarations: toolSchemas.map(s => this.#toFunctionDeclaration(s)),
        }];
      }

      // toolChoice → Gemini mode
      body.toolConfig = {
        functionCallingConfig: { mode: this.#toGeminiMode(toolChoice) },
      };

      // 系统指令
      if (systemPrompt) {
        body.systemInstruction = { parts: [{ text: systemPrompt }] };
      }

      const url = `${GEMINI_BASE}/models/${this.model}:generateContent?key=${this.apiKey}`;
      const data = await this._post(url, body);

      return this.#parseToolResponse(data);
    });
  }

  // ─── 内部转换方法 ──────────────────────

  /**
   * 统一消息格式 → Gemini contents
   * - user → {role: 'user', parts: [{text}]}
   * - assistant → {role: 'model', parts: [{text}, {functionCall}...]}
   * - tool → grouped into {role: 'user', parts: [{functionResponse}...]}
   *
   * Gemini 要求严格交替 user/model 角色。
   * 连续同角色消息（如 L2/L3 压缩后的摘要）自动合并 parts 以避免 400 错误。
   */
  #convertMessages(messages) {
    const contents = [];
    let pendingToolResults = [];

    /**
     * 推入 contents，如果上一个 entry 同角色则合并 parts
     */
    const pushOrMerge = (entry) => {
      const last = contents[contents.length - 1];
      if (last && last.role === entry.role) {
        last.parts.push(...entry.parts);
      } else {
        contents.push(entry);
      }
    };

    for (const msg of messages) {
      if (msg.role === 'tool') {
        // 收集连续 tool results → 将在下一个非 tool 消息前或末尾 flush
        pendingToolResults.push({
          functionResponse: {
            name: msg.name,
            response: { result: msg.content || '' },
          },
        });
        continue;
      }

      // Flush pending tool results before non-tool message
      if (pendingToolResults.length > 0) {
        pushOrMerge({ role: 'user', parts: pendingToolResults });
        pendingToolResults = [];
      }

      if (msg.role === 'user') {
        pushOrMerge({ role: 'user', parts: [{ text: msg.content || '' }] });
      } else if (msg.role === 'assistant') {
        const parts = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.toolCalls?.length > 0) {
          for (const tc of msg.toolCalls) {
            const fcPart = { functionCall: { name: tc.name, args: tc.args || {} } };
            // Gemini 3+: 回填 thoughtSignature（首个 functionCall 必须携带）
            if (tc.thoughtSignature) {
              fcPart.thoughtSignature = tc.thoughtSignature;
            }
            parts.push(fcPart);
          }
        }
        if (parts.length > 0) pushOrMerge({ role: 'model', parts });
      }
    }

    // Flush remaining tool results
    if (pendingToolResults.length > 0) {
      pushOrMerge({ role: 'user', parts: pendingToolResults });
    }

    return contents;
  }

  /**
   * toolChoice → Gemini mode
   */
  #toGeminiMode(toolChoice) {
    switch (toolChoice) {
      case 'required': return 'ANY';
      case 'none':     return 'NONE';
      default:         return 'AUTO';
    }
  }

  /**
   * 标准 tool schema → Gemini functionDeclaration
   */
  #toFunctionDeclaration(schema) {
    return {
      name: schema.name,
      description: schema.description || '',
      parameters: this.#sanitizeSchemaForGemini(schema.parameters),
    };
  }

  /**
   * 清理 JSON Schema 使之兼容 Gemini API 的 OpenAPI 子集
   */
  #sanitizeSchemaForGemini(schema) {
    if (!schema || typeof schema !== 'object') {
      return { type: 'object', properties: {} };
    }

    const cleaned = { ...schema };
    if (!cleaned.type) cleaned.type = 'object';

    if (cleaned.properties) {
      const props = {};
      for (const [key, val] of Object.entries(cleaned.properties)) {
        const prop = { ...val };
        delete prop.default;
        delete prop.examples;
        if (!prop.type) prop.type = 'string';
        props[key] = prop;
      }
      cleaned.properties = props;
    }

    return cleaned;
  }

  /**
   * 解析 Gemini API 响应 — 提取 functionCall 或 text
   * 返回统一格式（含生成的 id）
   */
  #parseToolResponse(data) {
    const content = data?.candidates?.[0]?.content;

    // 提取 token 用量 (Gemini usageMetadata)
    const usage = data?.usageMetadata
      ? {
          inputTokens: data.usageMetadata.promptTokenCount || 0,
          outputTokens: data.usageMetadata.candidatesTokenCount || 0,
          totalTokens: data.usageMetadata.totalTokenCount || 0,
        }
      : null;

    if (!content || !content.parts || content.parts.length === 0) {
      return { text: '', functionCalls: null, usage };
    }

    const functionCalls = [];
    const textParts = [];
    let fcIndex = 0;

    for (const part of content.parts) {
      if (part.functionCall) {
        functionCalls.push({
          id: `gemini_fc_${Date.now()}_${fcIndex++}`,
          name: part.functionCall.name,
          args: part.functionCall.args || {},
          // Gemini 3+: thoughtSignature 必须原样回传，否则后续请求 400
          thoughtSignature: part.thoughtSignature || undefined,
        });
      } else if (part.text) {
        textParts.push(part.text);
      }
    }

    if (functionCalls.length > 0) {
      this.logger.debug(`[GeminiProvider] native function calls: ${functionCalls.map(fc => fc.name).join(', ')}`);
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
    const text = await this.chat(prompt, { temperature: 0.3 });
    return this.extractJSON(text) || { title: '', description: text };
  }

  async embed(text) {
    const texts = Array.isArray(text) ? text : [text];
    const results = [];

    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const requests = batch.map(t => ({
        model: EMBED_MODEL,
        content: { parts: [{ text: t.slice(0, 8000) }] },
      }));

      const url = `${GEMINI_BASE}/${EMBED_MODEL}:batchEmbedContents?key=${this.apiKey}`;
      const data = await this._post(url, { requests });
      if (data?.embeddings) {
        results.push(...data.embeddings.map(e => e.values));
      }
    }

    return Array.isArray(text) ? results : results[0] || [];
  }

  async _post(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await this._fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = '';
        try { const j = await res.json(); detail = j?.error?.message || JSON.stringify(j).slice(0, 300); } catch { /* ignore */ }
        const err = new Error(`Gemini API error: ${res.status}${detail ? ' — ' + detail : ''}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

export default GoogleGeminiProvider;

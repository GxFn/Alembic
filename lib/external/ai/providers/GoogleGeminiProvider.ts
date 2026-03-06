/**
 * GoogleGeminiProvider - Google Gemini AI 提供商
 * 直接调用 REST API（不依赖 SDK）
 *
 * v3: 统一消息格式 — chatWithTools() 接受 Provider-Agnostic 消息
 *     内部自动转换为 Gemini 原生 contents / functionDeclarations 格式
 *     支持 toolChoice: 'auto' | 'required' | 'none'
 */

import Logger from '../../../infrastructure/logging/Logger.js';
import { AiProvider } from '../AiProvider.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const EMBED_MODEL = 'models/gemini-embedding-001';

export class GoogleGeminiProvider extends AiProvider {



  constructor(config: any = {}) {
    super({
      ...config,
      maxConcurrency:
        config.maxConcurrency ||
        Number(process.env.ASD_GEMINI_MAX_CONCURRENCY || process.env.ASD_AI_MAX_CONCURRENCY || 2),
    });
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

  async chat(prompt, context: any = {}) {
    return this._withRetry(async () => {
      const { history = [], temperature = 0.7, maxTokens = 8192, systemPrompt } = context;
      const contents = [];

      for (const h of history) {
        contents.push({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content }],
        });
      }
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      const body: any = {
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
   * @param {string} prompt 未使用 messages 时的 fallback prompt
   * @param {object} opts
   * @param {Array}  opts.messages 统一格式消息
   * @param {Array}  opts.toolSchemas - [{name, description, parameters}]
   * @param {string} opts.toolChoice - 'auto' | 'required' | 'none'
   * @param {string} [opts.systemPrompt]
   * @param {number} [opts.temperature=0.7]
   * @param {number} [opts.maxTokens=8192]
   * @returns {Promise<{text: string|null, functionCalls: Array<{id, name, args}>|null}>}
   */
  async chatWithTools(prompt, opts: any = {}) {
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
      const contents =
        messages?.length > 0
          ? this.#convertMessages(messages)
          : [{ role: 'user', parts: [{ text: prompt }] }];

      const body: any = {
        contents,
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        },
      };

      // 工具声明: 标准 schema → Gemini functionDeclarations
      if (toolSchemas?.length > 0) {
        body.tools = [
          {
            functionDeclarations: toolSchemas.map((s) => this.#toFunctionDeclaration(s)),
          },
        ];
      }

      // toolChoice → Gemini mode (仅在有工具声明时设置，无工具时设 toolConfig 可能导致空响应)
      if (body.tools) {
        body.toolConfig = {
          functionCallingConfig: { mode: this.#toGeminiMode(toolChoice) },
        };
      }

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
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.toolCalls?.length > 0) {
          for (const tc of msg.toolCalls) {
            const fcPart: any = { functionCall: { name: tc.name, args: tc.args || {} } };
            // Gemini 3+: 回填 thoughtSignature（首个 functionCall 必须携带）
            if (tc.thoughtSignature) {
              fcPart.thoughtSignature = tc.thoughtSignature;
            }
            parts.push(fcPart);
          }
        }
        if (parts.length > 0) {
          pushOrMerge({ role: 'model', parts });
        }
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
      case 'required':
        return 'ANY';
      case 'none':
        return 'NONE';
      default:
        return 'AUTO';
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
   * 清理 JSON Schema 使之兼容 Gemini API 的 OpenAPI 子集（递归）
   * Gemini API 不支持 default、examples 等 JSON Schema 扩展字段
   */
  #sanitizeSchemaForGemini(schema) {
    if (!schema || typeof schema !== 'object') {
      return { type: 'object', properties: {} };
    }

    const cleaned = { ...schema };
    delete cleaned.default;
    delete cleaned.examples;
    if (!cleaned.type) {
      cleaned.type = 'object';
    }

    // 递归清理 properties
    if (cleaned.properties) {
      const props = {};
      for (const [key, val] of Object.entries(cleaned.properties)) {
        props[key] = this.#sanitizeSchemaForGemini(val);
      }
      cleaned.properties = props;
    }

    // 递归清理 items (array 类型)
    if (cleaned.type === 'array') {
      if (cleaned.items && typeof cleaned.items === 'object') {
        cleaned.items = this.#sanitizeSchemaForGemini(cleaned.items);
      } else {
        // Gemini 强制要求 array 必须有 items，缺失时补 string 兜底
        cleaned.items = { type: 'string' };
      }
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
      this.logger.debug(
        `[GeminiProvider] native function calls: ${functionCalls.map((fc) => fc.name).join(', ')}`
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
        maxTokens: 8192,
      })) || { title: '', description: '' }
    );
  }

  /**
   * Structured Output — Gemini 原生 JSON mode
   *
   * 使用 responseMimeType: 'application/json' 强制 Gemini 返回合法 JSON。
   * 可选传入 responseSchema 做编译期校验（Gemini 1.5+ / Gemini 2+）。
   */
  async chatWithStructuredOutput(prompt, opts: any = {}) {
    return this._withRetry(async () => {
      const { schema, temperature = 0.3, maxTokens = 32768, systemPrompt } = opts;

      const contents = [{ role: 'user', parts: [{ text: prompt }] }];

      const generationConfig: any = {
        temperature,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
      };

      // 如果提供了 JSON Schema，注入 responseSchema（Gemini 编译期校验）
      if (schema) {
        generationConfig.responseSchema = this.#sanitizeSchemaForGemini(schema);
      }

      const body: any = { contents, generationConfig };

      if (systemPrompt) {
        body.systemInstruction = { parts: [{ text: systemPrompt }] };
      }

      const url = `${GEMINI_BASE}/models/${this.model}:generateContent?key=${this.apiKey}`;
      const data = await this._post(url, body);
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      if (!text) {
        return null;
      }

      try {
        return JSON.parse(text);
      } catch {
        // Gemini JSON mode 偶尔返回前后有空白的 JSON，尝试 extractJSON 降级
        const openChar = opts.openChar || '{';
        const closeChar = opts.closeChar || '}';
        return this.extractJSON(text, openChar, closeChar);
      }
    });
  }

  async embed(text) {
    const texts = Array.isArray(text) ? text : [text];
    const results = [];

    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const requests = batch.map((t) => ({
        model: EMBED_MODEL,
        content: { parts: [{ text: t.slice(0, 8000) }] },
      }));

      const url = `${GEMINI_BASE}/${EMBED_MODEL}:batchEmbedContents?key=${this.apiKey}`;
      const data = await this._post(url, { requests });
      if (data?.embeddings) {
        results.push(...data.embeddings.map((e) => e.values));
      }
    }

    return Array.isArray(text) ? results : results[0] || [];
  }

  async _post(url, body) {
    if (!this.apiKey) {
      const err = new Error(
        'Google Gemini API Key 未配置。请在 .env 中设置 ASD_GOOGLE_API_KEY，或运行 asd setup 完成配置。'
      );
      (err as any).code = 'API_KEY_MISSING';
      throw err;
    }

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
        const retryAfterHeader = res.headers.get('retry-after');
        let retryAfterMs = 0;
        if (retryAfterHeader) {
          const sec = Number(retryAfterHeader);
          if (Number.isFinite(sec) && sec > 0) {
            retryAfterMs = sec * 1000;
          } else {
            const when = Date.parse(retryAfterHeader);
            if (Number.isFinite(when)) {
              retryAfterMs = Math.max(0, when - Date.now());
            }
          }
        }

        let detail = '';
        try {
          const j = await res.json();
          detail = j?.error?.message || JSON.stringify(j).slice(0, 300);
        } catch {
          /* ignore */
        }
        const err = new Error(`Gemini API error: ${res.status}${detail ? ` — ${detail}` : ''}`);
        (err as any).status = res.status;
        if (retryAfterMs > 0) {
          (err as any).retryAfterMs = retryAfterMs;
        }
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

export default GoogleGeminiProvider;

/**
 * AiProvider - AI 提供商抽象基类
 * 所有具体 Provider 必须实现这3个方法
 */

import { LanguageService } from '../../shared/LanguageService.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Loose JSON record for external API responses (inherently untyped) */
// biome-ignore lint: API responses are dynamic JSON
export type ApiResponse = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** AI provider 构造配置 */
export interface AiProviderConfig {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  circuitThreshold?: number;
  maxConcurrency?: number | string;
  name?: string;
  embedModel?: string;
  responses?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 对话历史条目 */
export interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

/** 对话上下文选项 */
export interface ChatContext {
  history?: ChatHistoryEntry[];
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/** 统一消息格式 */
export interface UnifiedMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string | null;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    thoughtSignature?: string;
  }>;
  toolCallId?: string;
  name?: string;
}

/** 工具 schema */
export interface ToolSchema {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** chatWithTools 选项 */
export interface ChatWithToolsOptions {
  messages?: unknown[];
  toolSchemas?: unknown[];
  toolChoice?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

/** 函数调用结果 */
export interface FunctionCallResult {
  id: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}

/** chatWithTools 返回值 */
export interface ChatWithToolsResult {
  text: string | null;
  functionCalls: FunctionCallResult[] | null;
  usage?: TokenUsage | null;
}

/** Token 用量 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** chatWithStructuredOutput 选项 */
export interface StructuredOutputOptions {
  schema?: Record<string, unknown>;
  openChar?: string;
  closeChar?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/** enrichCandidates 选项 */
export interface EnrichOptions {
  lang?: string;
}

/** enrichCandidates 候选条目 */
export interface EnrichCandidate {
  code?: string;
  language?: string;
  title?: string;
  description?: string;
  rationale?: string;
  knowledgeType?: string;
  complexity?: string;
  scope?: string;
  steps?: unknown[];
  constraints?: { preconditions?: unknown[]; boundaries?: unknown[]; sideEffects?: unknown[] };
  summary?: string;
  category?: string;
}

/** 文件内容条目（用于语言检测） */
export interface FileContentEntry {
  name?: string;
  [key: string]: unknown;
}

/** 语言 profile */
export interface LanguageProfile {
  primaryLanguage: string;
  role: string;
  patternExamples: string;
  extractionExamples: string;
  categories: string;
}

/** Logger 接口 — 兼容 winston.Logger 实例 */
export interface AiLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  [key: string]: unknown;
}

export class AiProvider {
  _activeRequests: number;
  _circuitCooldownMs: number;
  _circuitFailures: number;
  _circuitOpenedAt: number;
  _circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  _circuitThreshold: number;
  _maxConcurrency: number;
  _rateLimitedUntil: number;
  _requestQueue: Array<(value?: unknown) => void>;
  apiKey: string;
  baseUrl: string;
  logger: AiLogger | null = null;
  maxRetries: number;
  model: string;
  name: string;
  timeout: number;
  _fallbackFrom?: string;

  /**
   * Token 用量回调 — 每次 API 调用后触发（包括 chat / chatWithStructuredOutput / chatWithTools）
   * 由外部（如 DI 容器）注入以实现全局 token 计量。
   */
  _onTokenUsage: ((usage: TokenUsage & { source?: string }) => void) | null = null;

  constructor(config: AiProviderConfig = {}) {
    this.model = config.model || '';
    this.apiKey = config.apiKey || '';
    this.baseUrl = config.baseUrl || '';
    this.timeout = config.timeout || 300_000; // 5min
    this.maxRetries = config.maxRetries || 3;
    this.name = 'abstract';

    // ── CircuitBreaker 状态 ──
    this._circuitState = 'CLOSED'; // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
    this._circuitFailures = 0; // 连续失败计数
    this._circuitThreshold = config.circuitThreshold || 5; // 触发熔断的连续失败次数
    this._circuitOpenedAt = 0; // 熔断打开时间
    this._circuitCooldownMs = 30_000; // 初始冷却 30 秒

    // ── Provider 级全局并发闸门 + 429 冷却窗 ──
    this._maxConcurrency = Math.max(
      1,
      Number(config.maxConcurrency || process.env.ASD_AI_MAX_CONCURRENCY || 4)
    );
    this._activeRequests = 0;
    this._requestQueue = [];
    this._rateLimitedUntil = 0;
  }

  async _acquireRequestSlot() {
    if (this._activeRequests < this._maxConcurrency) {
      this._activeRequests += 1;
      return;
    }
    await new Promise<void>((resolve) => this._requestQueue.push(() => resolve()));
    this._activeRequests += 1;
  }

  _releaseRequestSlot() {
    this._activeRequests = Math.max(0, this._activeRequests - 1);
    const next = this._requestQueue.shift();
    if (next) {
      next();
    }
  }

  async _waitForRateLimitWindow() {
    const waitMs = (this._rateLimitedUntil || 0) - Date.now();
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  _setRateLimitWindow(waitMs: number) {
    const safeWait = Math.max(0, Number(waitMs) || 0);
    if (safeWait <= 0) {
      return;
    }
    const until = Date.now() + safeWait;
    if (until > (this._rateLimitedUntil || 0)) {
      this._rateLimitedUntil = until;
      this._log?.(
        'warn',
        `[RateLimit] ${this.name} enters cooldown ${Math.round(safeWait / 1000)}s (global)`
      );
    }
  }

  /**
   * 对话 - 发送 prompt + context，返回文本响应
   * @param context {history: [], temperature, maxTokens}
   */
  async chat(prompt: string, context: ChatContext = {}): Promise<string> {
    throw new Error(`${this.name}.chat() not implemented`);
  }

  /**
   * 从 API 原始响应中提取 token 用量并触发回调。
   * 子类在 chat() / chatWithStructuredOutput() 中调用。
   */
  _emitTokenUsage(usage: TokenUsage | null | undefined, source?: string) {
    if (!usage || !this._onTokenUsage) {
      return;
    }
    const total = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    if (total === 0) {
      return;
    }
    try {
      this._onTokenUsage({ ...usage, source });
    } catch {
      /* token tracking should never break execution */
    }
  }

  /** 摘要 - 对代码/文档生成结构化摘要 */
  async summarize(code: string): Promise<unknown> {
    throw new Error(`${this.name}.summarize() not implemented`);
  }

  /** 向量嵌入 - 返回浮点数组 */
  async embed(text: string | string[]): Promise<number[] | number[][]> {
    throw new Error(`${this.name}.embed() not implemented`);
  }

  /**
   * 探测 provider 是否可用（轻量级 API 调用验证连接性）
   * 子类可覆盖实现更具体的探测逻辑
   */
  async probe() {
    const result = await this.chat('ping', { maxTokens: 16, temperature: 0 });
    return !!result;
  }

  /** 检查是否支持 embedding */
  supportsEmbedding(): boolean {
    return true;
  }

  /**
   * 是否支持原生结构化函数调用（非文本解析）
   * 子类（如 GoogleGeminiProvider）覆盖返回 true
   */
  get supportsNativeToolCalling(): boolean {
    return false;
  }

  /**
   * 带工具声明的结构化对话 — 原生函数调用 API
   *
   * 支持原生函数调用的 Provider（Gemini / OpenAI / Claude）覆盖此方法,
   * 返回结构化 functionCall 而非文本，AgentRuntime 据此跳过正则解析。
   *
   * 默认实现降级为 chat()，由 AgentRuntime 进行文本解析。
   *
   * 统一消息格式 (Provider-Agnostic):
   *   - { role: 'user', content: 'text' }
   *   - { role: 'assistant', content: 'text or null', toolCalls: [{id, name, args}] }
   *   - { role: 'tool', toolCallId: 'id', name: 'tool_name', content: 'result string' }
   *
   * @param prompt 用户消息（仅在 messages 为空时使用）
   * @param opts.messages 统一格式消息历史
   * @param opts.toolSchemas [{name, description, parameters}]
   * @param opts.toolChoice 'auto' | 'required' | 'none'
   * @param [opts.systemPrompt] 系统指令
   * @returns >|null}>}
   */
  async chatWithTools(
    prompt: string,
    opts: ChatWithToolsOptions = {}
  ): Promise<ChatWithToolsResult> {
    // 默认降级: 忽略 tools/toolChoice，走纯文本 chat()
    const messages = (opts.messages || []) as UnifiedMessage[];
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content || '',
      }));
    const text = await this.chat(prompt, {
      history,
      systemPrompt: opts.systemPrompt,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });
    return { text, functionCalls: null };
  }

  /**
   * Structured Output — 请求 AI 返回严格 JSON 格式响应
   *
   * 子类覆盖以利用原生 JSON mode:
   *   - Gemini: responseMimeType: 'application/json' + responseSchema
   *   - OpenAI: response_format: { type: 'json_object' }
   *   - Claude: 无原生支持，使用默认实现 (chat + extractJSON)
   *
   * @param prompt 完整提示词（应包含返回 JSON 的指令）
   * @param [opts.schema] JSON Schema（Gemini/OpenAI 的 structured output 用）
   * @param [opts.openChar='{'] extractJSON 边界起始符（fallback 用）
   * @param [opts.closeChar='}'] extractJSON 边界终止符
   * @param [opts.systemPrompt] 可选系统指令
   * @returns 解析后的 JSON 对象/数组，解析失败返回 null
   */
  async chatWithStructuredOutput(
    prompt: string,
    opts: StructuredOutputOptions = {}
  ): Promise<unknown> {
    const response = await this.chat(prompt, {
      temperature: opts.temperature ?? 0.3,
      maxTokens: opts.maxTokens ?? 32768,
      systemPrompt: opts.systemPrompt,
    });
    if (!response || response.trim().length === 0) {
      return null;
    }
    const openChar = opts.openChar || '{';
    const closeChar = opts.closeChar || '}';
    return this.extractJSON(response, openChar, closeChar);
  }

  /** 内部日志辅助（子类可通过 this.logger 覆盖） */
  _log(level: string, message: string) {
    try {
      if (this.logger && typeof this.logger[level] === 'function') {
        this.logger[level](message);
      } else {
      }
    } catch {
      /* best effort */
    }
  }

  /**
   * 根据用户语言偏好生成输出语言指令
   * @param [lang] 语言代码，如 'zh', 'en'
   * @returns 语言指令段落（为空则返回空字符串）
   */
  _buildLangInstruction(lang: string | undefined) {
    if (!lang || lang === 'en') {
      return '';
    }
    if (lang === 'zh') {
      return `
# 输出语言要求
用户使用中文，请用**中文**书写以下字段的内容：
- title（标题）
- description（描述）
- doClause（做什么）
- dontClause（不要做什么）
- whenClause（适用场景）
- topicHint（分组标签）
- content.markdown（使用指南）
- content.rationale（设计原因）
- reasoning.whyStandard（为什么是最佳实践）
- aiInsight（核心洞察）
- constraints 中的 preconditions / sideEffects / boundaries

以下字段保持英文或代码原文，不要翻译：
- trigger（@快捷方式）
- content.pattern（源代码）
- coreCode（代码骨架）
- headers（import 语句）
- tags（搜索关键词，可中英混合）
- kind / knowledgeType / complexity / scope / category / language
`;
    }
    // 其他语言通用指令
    return `\n# Output Language\nThe user's preferred language is "${lang}". Write all human-readable text fields (title, description, doClause, dontClause, whenClause, topicHint, content.markdown, content.rationale, reasoning.whyStandard, aiInsight, constraints text) in "${lang}". Keep code fields (trigger, content.pattern, coreCode, headers, tags) in their original language.\n`;
  }

  /** 根据文件扩展名检测语言特征，返回提示词适配参数 */
  _detectLanguageProfile(filesContent: FileContentEntry[]): LanguageProfile {
    const extCounts: Record<string, number> = {};
    for (const f of filesContent) {
      const ext = (f.name || '').split('.').pop()?.toLowerCase() || '';
      extCounts[ext] = (extCounts[ext] || 0) + 1;
    }

    // 使用 LanguageService 推断主语言
    const primaryLang = LanguageService.detectPrimary(extCounts);
    const dominant =
      Object.entries(extCounts).sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0] || '';

    // iOS/macOS (Swift / Objective-C)
    if (primaryLang === 'swift' || primaryLang === 'objectivec') {
      return {
        primaryLanguage: primaryLang,
        role: 'Senior iOS/macOS Architect',
        patternExamples:
          'how to set up a ViewController, configure a TableView with delegate/datasource, build a login UI, handle network responses',
        extractionExamples: `Examples of good extractions:
- Complete \`init\` method with all tabBarItem/navigationItem configuration
- Complete \`viewDidLoad\` with all setup calls
- Complete \`setupUI\` method with subview creation and layout
- Complete UITableViewDataSource implementation
- Complete action handler method (e.g. loginButtonTapped)`,
        categories: 'View | Service | Tool | Model | Network | Storage | UI | Utility',
      };
    }

    // JavaScript / TypeScript
    if (primaryLang === 'javascript' || primaryLang === 'typescript') {
      return {
        primaryLanguage: primaryLang,
        role: 'Senior Software Engineer',
        patternExamples:
          'Express/Koa middleware, React component patterns, service class with dependency injection, data processing pipeline, error handling wrapper, factory/strategy patterns',
        extractionExamples: `Examples of good extractions:
- Complete class with constructor and key methods
- Express route handler with validation and error handling
- Utility function with edge case handling
- React component with hooks and event handlers
- Service method with retries and fallback logic`,
        categories: 'Service | Utility | Middleware | Component | Model | Config | Handler | Route',
      };
    }

    // Python
    if (primaryLang === 'python') {
      return {
        primaryLanguage: 'python',
        role: 'Senior Python Engineer',
        patternExamples:
          'Django/Flask views, data processing with pandas, async handlers, decorator patterns, class-based services',
        extractionExamples: `Examples of good extractions:
- Complete class with __init__ and key methods
- Decorator factory function
- API endpoint handler with request validation
- Data processing pipeline function
- Context manager implementation`,
        categories: 'Service | Utility | Model | View | Handler | Middleware | Config | Pipeline',
      };
    }

    // Go
    if (primaryLang === 'go') {
      return {
        primaryLanguage: 'go',
        role: 'Senior Go Engineer',
        patternExamples:
          'HTTP handler with middleware, goroutine patterns, interface implementations, struct methods with error handling',
        extractionExamples: `Examples of good extractions:
- Complete struct with constructor and methods
- HTTP handler function with error propagation
- Middleware function with context usage
- Interface implementation with all required methods`,
        categories: 'Service | Handler | Middleware | Model | Utility | Repository | Config',
      };
    }

    // Kotlin / Java
    if (primaryLang === 'kotlin' || primaryLang === 'java') {
      return {
        primaryLanguage: primaryLang,
        role: 'Senior Android/Backend Engineer',
        patternExamples:
          'Activity/Fragment lifecycle, repository pattern, ViewModel with LiveData, Retrofit service, dependency injection setup',
        extractionExamples: `Examples of good extractions:
- Complete class with constructor and key methods
- Repository with CRUD operations
- ViewModel with state management
- API service interface definition
- Custom view with measurement and drawing`,
        categories: 'View | Service | Repository | Model | Network | Storage | UI | Utility',
      };
    }

    // Rust
    if (primaryLang === 'rust') {
      return {
        primaryLanguage: 'rust',
        role: 'Senior Rust Engineer',
        patternExamples:
          'trait implementations, error handling with Result, async functions, builder patterns, iterator chains',
        extractionExamples: `Examples of good extractions:
- Complete impl block with key methods
- Trait implementation with all required methods
- Error type definition with From implementations
- Builder pattern struct and methods
- Async function with proper error handling`,
        categories: 'Service | Trait | Model | Handler | Utility | Config | Error | Pipeline',
      };
    }

    // Vue
    if (dominant === 'vue') {
      return {
        primaryLanguage: 'vue',
        role: 'Senior Frontend Engineer',
        patternExamples:
          'Vue component with composition API, composable functions, Vuex/Pinia store modules, router guards',
        extractionExamples: `Examples of good extractions:
- Complete Vue component with setup/template
- Composable function with reactive state
- Store module with actions and getters
- Custom directive implementation`,
        categories: 'Component | Composable | Store | Directive | Service | Utility | Config',
      };
    }

    // Ruby
    if (primaryLang === 'ruby') {
      return {
        primaryLanguage: 'ruby',
        role: 'Senior Ruby Engineer',
        patternExamples:
          'Rails controller actions, model concerns, service objects, background jobs, API serializers',
        extractionExamples: `Examples of good extractions:
- Complete controller with CRUD actions
- Service object with call method
- Model with validations and scopes
- Concern module with included block`,
        categories: 'Controller | Service | Model | Concern | Job | Serializer | Utility | Config',
      };
    }

    // Default / mixed
    return {
      primaryLanguage: dominant || 'unknown',
      role: 'Senior Software Engineer',
      patternExamples:
        'design patterns, service abstractions, data flow handling, error management, configuration setup',
      extractionExamples: `Examples of good extractions:
- Complete class/function with full implementation
- Service method with error handling and retries
- Configuration setup with all options
- Data processing pipeline`,
      categories: 'Service | Utility | Model | Handler | Config | Component | Pipeline',
    };
  }

  /**
   * AI 语义字段补全 — 分析候选代码，填补缺失的语义字段
   * @param candidates 候选对象数组，每项至少含 {code, language, title?}
   * @returns enriched 候选数组（仅含补全的字段）
   */
  async enrichCandidates(candidates: EnrichCandidate[], options: EnrichOptions = {}) {
    const prompt = this._buildEnrichPrompt(candidates, options);
    const parsed = await this.chatWithStructuredOutput(prompt, {
      openChar: '[',
      closeChar: ']',
      temperature: 0.3,
    });
    return Array.isArray(parsed) ? parsed : [];
  }

  /** 构建 enrichCandidates 提示词 */
  _buildEnrichPrompt(candidates: EnrichCandidate[], options: EnrichOptions = {}) {
    const items = candidates
      .map((c: EnrichCandidate, i: number) => {
        const existing: string[] = [];
        if (c.rationale) {
          existing.push(`rationale: ${c.rationale}`);
        }
        if (c.knowledgeType) {
          existing.push(`knowledgeType: ${c.knowledgeType}`);
        }
        if (c.complexity) {
          existing.push(`complexity: ${c.complexity}`);
        }
        if (c.scope) {
          existing.push(`scope: ${c.scope}`);
        }
        if (c.steps?.length) {
          existing.push(`steps: [${c.steps.length} steps already]`);
        }
        if (c.constraints?.preconditions?.length) {
          existing.push(`preconditions: [${c.constraints.preconditions.length} items]`);
        }
        const existingStr =
          existing.length > 0
            ? `\nAlready filled: ${existing.join(', ')}`
            : '\nNo semantic fields filled yet.';

        return `--- CANDIDATE #${i + 1} ---
Title: ${c.title || '(untitled)'}
Language: ${c.language || 'unknown'}
Category: ${c.category || ''}
Description: ${c.description || c.summary || ''}
${existingStr}
Code:
${(c.code || '').substring(0, 2000)}`;
      })
      .join('\n\n');

    return `# Role
You are a Senior Software Architect performing deep semantic analysis on code candidates.

# Goal
For each candidate below, analyze the code and fill in MISSING semantic fields only.
Do NOT overwrite fields that are already filled (listed under "Already filled").

# Fields to Fill (only if missing)

1. **rationale** (string): Why this pattern exists; what design intent or problem it solves. 2-3 sentences.
2. **knowledgeType** (string): One of: "code-standard", "code-pattern", "architecture", "best-practice", "code-relation", "inheritance", "call-chain", "data-flow", "module-dependency", "boundary-constraint", "code-style", "solution", "anti-pattern".
3. **complexity** (string): "beginner" | "intermediate" | "advanced". Evaluate usage difficulty.
4. **scope** (string): "universal" (reusable anywhere) | "project-specific" (specific to this project) | "target-specific" (specific to one module/target).
5. **steps** (array): Implementation steps. Each: { "title": "Step N title", "description": "What to do", "code": "optional code" }.
6. **constraints** (object): { "preconditions": ["iOS 15+", "需先配置 X", ...], "boundaries": ["Cannot be used with Y"], "sideEffects": ["Modifies global state"] }.

# Output Schema
Return a JSON array with one object per candidate. Each object contains ONLY the fields that were missing and you have now filled.
Include an "index" field (0-based) to match each result to its candidate.

Example:
[
  { "index": 0, "rationale": "...", "steps": [...], "constraints": { "preconditions": [...] } },
  { "index": 1, "knowledgeType": "architecture", "complexity": "advanced" }
]

Return ONLY a JSON array. No markdown, no explanation.
${this._buildLangInstruction(options.lang)}
# Candidates

${items}`;
  }

  // ─── 网络 / 代理 ────────────────────────────

  /**
   * 解析当前 Provider 应使用的代理 URL。
   * 优先级（从高到低）:
   *   1. Provider 专属: ASD_{PROVIDER}_PROXY_HTTPS / ASD_{PROVIDER}_PROXY_HTTP
   *   2. 全局 ASD 专属: ASD_AI_PROXY
   *   3. 系统通用: HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
   *
   * Provider 名称映射: google-gemini → GOOGLE, openai → OPENAI, claude → CLAUDE, deepseek → DEEPSEEK
   */
  _resolveProxyUrl() {
    // Provider-specific vars: ASD_GOOGLE_PROXY_HTTPS, ASD_OPENAI_PROXY_HTTPS, etc.
    const tag = (this.name || '')
      .replace(/-gemini$/, '') // google-gemini → google
      .replace(/-/g, '_') // 其他连字符 → 下划线
      .toUpperCase(); // google → GOOGLE

    if (tag) {
      const specific =
        process.env[`ASD_${tag}_PROXY_HTTPS`] || process.env[`ASD_${tag}_PROXY_HTTP`];
      if (specific) {
        return specific;
      }
    }

    return (
      process.env.ASD_AI_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy ||
      ''
    );
  }

  /**
   * 代理感知的 fetch — 自动检测代理并使用 undici ProxyAgent。
   * 子类的 _post() 应调用此方法替代全局 fetch()。
   */
  async _fetch(url: string, options: Record<string, unknown> = {}) {
    const proxyUrl = this._resolveProxyUrl();

    if (proxyUrl) {
      try {
        const undici = await import('undici');
        options.dispatcher = new undici.ProxyAgent(proxyUrl);
        return await undici.fetch(url, options);
      } catch {
        // undici 不可用，fallback 到全局 fetch
      }
    }
    return globalThis.fetch(url, options);
  }

  // ─── 工具方法 ─────────────────────────────

  /**
   * 从 LLM 响应提取 JSON (extractJSON kept below)
   * 支持截断修复：当 AI 输出被 token 限制截断时，尝试关闭未完成的 JSON 结构
   */
  extractJSON(text: string, openChar = '{', closeChar = '}') {
    if (!text) {
      return null;
    }
    // 去除 markdown 代码块
    const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');
    const start = cleaned.indexOf(openChar);
    if (start === -1) {
      return null;
    }
    const end = cleaned.lastIndexOf(closeChar);

    // 1. 常规路径：找到完整的 JSON 边界
    if (end > start) {
      try {
        let jsonStr = cleaned.slice(start, end + 1);
        jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(jsonStr);
      } catch {
        // 常规解析失败，尝试截断修复
      }
    }

    // 2. 截断修复：AI 输出被 token 限制截断，尝试回收已完成的条目
    if (openChar === '[') {
      return this._repairTruncatedArray(cleaned.slice(start));
    }
    return null;
  }

  /**
   * 修复被截断的 JSON 数组 — 回收已完成的对象
   * 策略 1（主路径）: 字符级解析找到最后一个完整的顶层 {...} 对象
   * 策略 2（回退路径）: 正则 + 渐进 JSON.parse 尝试（应对代码段中未转义引号导致 inString 追踪失效）
   */
  _repairTruncatedArray(text: string) {
    // ── 策略 1：字符级深度追踪 ──
    const charResult = this._repairByCharTracking(text);
    if (charResult) {
      return charResult;
    }

    // ── 策略 2：正则回退 — 找所有 "}," 或 "}\n" 位置，从后向前逐一尝试 JSON.parse ──
    const regexResult = this._repairByRegexFallback(text);
    if (regexResult) {
      return regexResult;
    }

    return null;
  }

  /** 字符级深度追踪修复（原逻辑，处理标准 JSON） */
  _repairByCharTracking(text: string) {
    let depth = 0;
    let inString = false;
    let isEscaped = false;
    let lastCompleteObjEnd = -1;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        isEscaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }

      if (ch === '{' || ch === '[') {
        depth++;
      } else if (ch === '}' || ch === ']') {
        depth--;
        // depth === 1 表示回到数组顶层，刚关闭了一个完整对象
        if (depth === 1 && ch === '}') {
          lastCompleteObjEnd = i;
        }
      }
    }

    if (lastCompleteObjEnd === -1) {
      return null;
    }
    return this._tryRepairAt(text, lastCompleteObjEnd);
  }

  /**
   * 正则回退修复 — 不依赖 inString 追踪
   * 寻找所有 "},\s*{" 或 "}\s*]" 边界，从后往前尝试 JSON.parse
   */
  _repairByRegexFallback(text: string) {
    // 收集所有 "}" 后跟 "," 或空白的位置（可能是对象边界）
    const candidates: number[] = [];
    const re = /\}[\s,]*(?=\s*[[{]|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      candidates.push(m.index); // "}" 的位置
    }

    // 从后往前尝试
    for (let i = candidates.length - 1; i >= 0; i--) {
      const result = this._tryRepairAt(text, candidates[i]);
      if (result) {
        return result;
      }
    }
    return null;
  }

  /** 在指定位置截断并尝试闭合 JSON 数组 */
  _tryRepairAt(text: string, endPos: number) {
    let repaired = text.slice(0, endPos + 1);
    // 去掉尾逗号
    repaired = repaired.replace(/,\s*$/, '');
    repaired += ']';
    // 修复尾逗号（对象/数组末尾多余逗号）
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');

    try {
      const result = JSON.parse(repaired);
      if (Array.isArray(result) && result.length > 0) {
        this._log(
          'warn',
          `[extractJSON] Repaired truncated JSON array: recovered ${result.length} items from truncated response`
        );
        return result;
      }
    } catch {
      /* this position didn't work, try next */
    }
    return null;
  }

  /**
   * 指数退避重试 + 熔断器（受 Cline 三级错误恢复启发）
   *
   * 熔断器三态:
   *   CLOSED  — 正常工作，计数连续失败
   *   OPEN    — 连续 N 次失败，直接拒绝请求（快速失败），持续 cooldownMs
   *   HALF_OPEN — 冷却期后尝试一次，成功则恢复，失败则重新 OPEN
   *
   * 这避免了 AI 服务宕机时无意义的重试风暴。
   */
  async _withRetry<T>(
    fn: () => Promise<T>,
    retries = this.maxRetries,
    baseDelay = 2000
  ): Promise<T> {
    // ── 熔断器检查 ──
    if (this._circuitState === 'OPEN') {
      const elapsed = Date.now() - (this._circuitOpenedAt || 0);
      if (elapsed < (this._circuitCooldownMs || 30000)) {
        const err = new Error(
          `AI 服务熔断中 (连续 ${this._circuitFailures} 次失败)，${Math.ceil(((this._circuitCooldownMs || 30000) - elapsed) / 1000)}s 后恢复`
        ) as Error & { code: string };
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
      // 冷却期结束 → HALF_OPEN
      this._circuitState = 'HALF_OPEN';
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      let slotAcquired = false;
      try {
        await this._waitForRateLimitWindow();
        await this._acquireRequestSlot();
        slotAcquired = true;

        const result = await fn();
        // 成功 → 完全重置熔断器（包括冷却时间）
        this._circuitFailures = 0;
        this._circuitState = 'CLOSED';
        this._circuitCooldownMs = 30_000; // 重置冷却时间
        return result;
      } catch (err: unknown) {
        const e = err as Error & {
          status?: number;
          code?: string;
          retryAfterMs?: number;
          cause?: { code?: string; message?: string };
        };
        // ── 综合判断是否为可重试的网络/服务端错误 ──
        const causeCode = e.cause?.code || '';
        // 网络级错误：无 HTTP status，底层连接失败
        const isNetworkError =
          !e.status &&
          (e.message === 'fetch failed' ||
            e.code === 'ECONNRESET' ||
            causeCode === 'ECONNRESET' ||
            e.code === 'ECONNREFUSED' ||
            causeCode === 'ECONNREFUSED' ||
            e.code === 'ENOTFOUND' ||
            causeCode === 'ENOTFOUND' ||
            e.code === 'ECONNABORTED' ||
            causeCode === 'ECONNABORTED' ||
            e.code === 'ETIMEDOUT' ||
            causeCode === 'ETIMEDOUT' ||
            e.code === 'UND_ERR_CONNECT_TIMEOUT' ||
            causeCode === 'UND_ERR_CONNECT_TIMEOUT' ||
            e.code === 'UND_ERR_SOCKET' ||
            causeCode === 'UND_ERR_SOCKET');
        const isRetryable = e.status === 429 || (e.status ?? 0) >= 500 || isNetworkError;

        // 429：触发 provider 级冷却窗，抑制并发重试风暴
        if (e.status === 429) {
          const retryAfterMs = Number(e.retryAfterMs || 0);
          const adaptiveCooldown = Math.max(
            retryAfterMs,
            Math.round(baseDelay * 2 ** attempt * 1.5 + Math.random() * 1000)
          );
          this._setRateLimitWindow(adaptiveCooldown);
        }

        // 首次失败记录详细诊断（含 cause）
        if (attempt === 0 && (isNetworkError || e.cause)) {
          this._log?.(
            'warn',
            `[_withRetry] ${e.message} — cause: ${e.cause?.message || causeCode || 'unknown'}`
          );
        }

        if (attempt >= retries || !isRetryable) {
          // 只有服务端错误 / 网络错误才累计熔断计数
          // 客户端错误 (4xx 非 429) 不应触发熔断 — 那是请求本身的问题
          const isServerError =
            isNetworkError || e.status === 429 || (e.status ?? 0) >= 500 || !e.status;
          if (isServerError) {
            this._circuitFailures = (this._circuitFailures || 0) + 1;
            if (this._circuitFailures >= (this._circuitThreshold || 5)) {
              this._circuitState = 'OPEN';
              this._circuitOpenedAt = Date.now();
              // 先用当前冷却值，再递增给下次: 30s → 60s → 120s（最大 5 分钟）
              const cooldown = this._circuitCooldownMs || 30_000;
              this._log?.(
                'warn',
                `[CircuitBreaker] OPEN — ${this._circuitFailures} consecutive failures, cooldown ${cooldown / 1000}s`
              );
              this._circuitCooldownMs = Math.min(cooldown * 2, 300_000);
            }
          }
          throw e;
        }
        const delay = baseDelay * 2 ** attempt + Math.random() * 1000;
        this._log?.(
          'info',
          `[_withRetry] attempt ${attempt + 1} failed (${e.message}), retrying in ${Math.round(delay / 1000)}s…`
        );
        await new Promise((r) => setTimeout(r, delay));
      } finally {
        if (slotAcquired) {
          this._releaseRequestSlot();
        }
      }
    }
    // Should never reach here — last iteration either returns or throws
    throw new Error('_withRetry: unexpected exhaustion');
  }
}

export default AiProvider;

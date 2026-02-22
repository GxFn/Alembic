/**
 * AiProvider - AI 提供商抽象基类
 * 所有具体 Provider 必须实现这3个方法
 */

import { LanguageService } from '../../shared/LanguageService.js';

export class AiProvider {
  constructor(config = {}) {
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
  }

  /**
   * 对话 - 发送 prompt + context，返回文本响应
   * @param {string} prompt
   * @param {object} context - {history: [], temperature, maxTokens}
   * @returns {Promise<string>}
   */
  async chat(prompt, context = {}) {
    throw new Error(`${this.name}.chat() not implemented`);
  }

  /**
   * 摘要 - 对代码/文档生成结构化摘要
   * @param {string} code
   * @returns {Promise<object>}
   */
  async summarize(code) {
    throw new Error(`${this.name}.summarize() not implemented`);
  }

  /**
   * 向量嵌入 - 返回浮点数组
   * @param {string|string[]} text
   * @returns {Promise<number[]|number[][]>}
   */
  async embed(text) {
    throw new Error(`${this.name}.embed() not implemented`);
  }

  /**
   * 探测 provider 是否可用（轻量级 API 调用验证连接性）
   * 子类可覆盖实现更具体的探测逻辑
   * @returns {Promise<boolean>}
   */
  async probe() {
    const result = await this.chat('ping', { maxTokens: 16, temperature: 0 });
    return !!result;
  }

  /**
   * 检查是否支持 embedding
   * @returns {boolean}
   */
  supportsEmbedding() {
    return true;
  }

  /**
   * 是否支持原生结构化函数调用（非文本解析）
   * 子类（如 GoogleGeminiProvider）覆盖返回 true
   * @returns {boolean}
   */
  get supportsNativeToolCalling() {
    return false;
  }

  /**
   * 带工具声明的结构化对话 — 原生函数调用 API
   *
   * 支持原生函数调用的 Provider（Gemini / OpenAI / Claude）覆盖此方法,
   * 返回结构化 functionCall 而非文本，ChatAgent 据此跳过正则解析。
   *
   * 默认实现降级为 chat()，由 ChatAgent 进行文本解析。
   *
   * 统一消息格式 (Provider-Agnostic):
   *   - { role: 'user', content: 'text' }
   *   - { role: 'assistant', content: 'text or null', toolCalls: [{id, name, args}] }
   *   - { role: 'tool', toolCallId: 'id', name: 'tool_name', content: 'result string' }
   *
   * @param {string} prompt — 用户消息（仅在 messages 为空时使用）
   * @param {object} opts
   * @param {Array} opts.messages — 统一格式消息历史
   * @param {Array} opts.toolSchemas — [{name, description, parameters}]
   * @param {string} opts.toolChoice — 'auto' | 'required' | 'none'
   * @param {string} [opts.systemPrompt] — 系统指令
   * @param {number} [opts.temperature=0.7]
   * @param {number} [opts.maxTokens=8192]
   * @returns {Promise<{text: string|null, functionCalls: Array<{id: string, name: string, args: object}>|null}>}
   */
  async chatWithTools(prompt, opts = {}) {
    // 默认降级: 忽略 tools/toolChoice，走纯文本 chat()
    const messages = opts.messages || [];
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
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
   * @param {string} prompt — 完整提示词（应包含返回 JSON 的指令）
   * @param {object} [opts]
   * @param {object} [opts.schema] — JSON Schema（Gemini/OpenAI 的 structured output 用）
   * @param {string} [opts.openChar='{'] — extractJSON 边界起始符（fallback 用）
   * @param {string} [opts.closeChar='}'] — extractJSON 边界终止符
   * @param {number} [opts.temperature=0.3]
   * @param {number} [opts.maxTokens=32768]
   * @param {string} [opts.systemPrompt] — 可选系统指令
   * @returns {Promise<any>} — 解析后的 JSON 对象/数组，解析失败返回 null
   */
  async chatWithStructuredOutput(prompt, opts = {}) {
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

  /**
   * 从源码文件批量提取 Recipe 结构（AI 驱动）
   * 默认实现使用 chat() + 标准提示词；子类可覆盖以使用专用 API
   * @param {string} targetName - SPM Target 名称
   * @param {Array<{name:string,content:string}>} filesContent
   * @param {object} [options] - 可选参数
   * @param {string} [options.skillReference] - 业界最佳实践参考内容（来自 Skills）
   * @returns {Promise<Array<object>>}
   */
  async extractRecipes(targetName, filesContent, options = {}) {
    const prompt = this._buildExtractPrompt(targetName, filesContent, options);
    const parsed = await this.chatWithStructuredOutput(prompt, {
      openChar: '[',
      closeChar: ']',
      temperature: 0.3,
      maxTokens: 32768,
    });
    if (!Array.isArray(parsed)) {
      this._log(
        'warn',
        `[extractRecipes] structured output parse failed for target: ${targetName}`
      );
      return [];
    }
    if (parsed.length === 0) {
      this._log('info', `[extractRecipes] AI returned empty array for target: ${targetName}`);
    }
    return parsed;
  }

  /**
   * 内部日志辅助（子类可通过 this.logger 覆盖）
   */
  _log(level, message) {
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
   * 构建 extractRecipes 标准提示词（语言自适应 + Skill 增强）
   */
  _buildExtractPrompt(targetName, filesContent, options = {}) {
    const files = filesContent.map((f) => `--- FILE: ${f.name} ---\n${f.content}`).join('\n\n');

    // 检测文件主要语言
    const langProfile = this._detectLanguageProfile(filesContent);

    // Skill 业界参考标准注入
    const skillSection = options.skillReference
      ? `\n# Industry Best Practice Reference\nUse the following industry standards as quality benchmarks. Extracted recipes should align with these practices when applicable:\n\n${options.skillReference.substring(0, 2000)}\n`
      : '';

    // AST 代码结构分析注入 — 帮助 AI 理解继承体系、设计模式、代码规模
    const astSection = options.astContext
      ? `\n# Code Structure Analysis (AST)\nThe following is a Tree-sitter AST analysis of the project. Use this structural context to better understand class hierarchies, design patterns, and code quality when extracting recipes:\n\n${options.astContext.substring(0, 3000)}\n`
      : '';

    // 用户语言偏好 — 控制 AI 输出人类可读字段的语言
    const langInstruction = this._buildLangInstruction(options.lang);

    // comprehensive 模式：全量分析整个文件，不跳过任何有意义的方法
    if (options.comprehensive) {
      return `# Role
You are a ${langProfile.role} performing a **comprehensive full-file analysis**.

# Goal
Thoroughly analyze ALL code in "${targetName}" and create Recipe entries for **every significant method, function, or code block**.
This is a full-file analysis — do NOT skip methods just because they seem "simple" or "standard".
${skillSection}${astSection}

# What to extract
- **Every** complete method/function with 5+ lines of implementation
- Initialization and configuration methods (init, viewDidLoad, setup, configure)
- Event handlers and action methods
- Data processing and business logic
- Protocol/delegate implementations
- ANY code block that a developer might reference, learn from, or reuse

# Extraction Rules
- Extract **BROADLY** — include all meaningful code units, not just "clever" or "novel" patterns
- Each recipe must be a **complete, standalone** code unit with full signature and body
- Put the complete code in \`content.pattern\`, and a meaningful project writeup in \`content.markdown\`
- Preserve the file's actual code. Use \`<#placeholder#>\` ONLY for literal strings/values a developer would customize
- Every recipe must be traceable to real code in the file. Do NOT invent code
- Include relevant \`headers\` (import/require lines) that the code depends on
- You **MUST** extract at least ONE recipe — every source file has something worth capturing
- For each recipe, provide a concise \`doClause\` (imperative sentence) and a \`topicHint\` group label

${langProfile.extractionExamples}

# Output (JSON Array)
Each item MUST use the following V3 KnowledgeEntry structure:
- title (string): Descriptive English name
- description (string): 2-3 sentences explaining what this code does, written as a project-specific guide
- trigger (string): @shortcut (kebab-case, e.g. "@url-parser")
- kind (string): "rule" | "pattern" | "fact" — rule = always-do/never-do, pattern = reusable recipe with code, fact = reference info
- knowledgeType (string): "code-pattern" | "architecture" | "api-usage" | "naming-convention" | "error-handling" | "performance" | "best-practice"
- complexity (string): "basic" | "intermediate" | "advanced"
- scope (string): "universal" | "project-specific" | "team-convention"
- category: ${langProfile.categories}
- language: "${langProfile.primaryLanguage}"
- content (object): { "pattern": "<complete function/method/class from the file>", "markdown": "<project-specific writeup: what this pattern does, when to use it, key design decisions>", "rationale": "<why this pattern is designed this way — design trade-offs, alternatives considered>" }
- reasoning (object): { "whyStandard": "<why this is a standard/best-practice worth following>", "sources": ["<source file names>"], "confidence": <0.0-1.0> }
- headers (string[]): Required import/require lines
- tags (string[]): Search keywords
- doClause (string): One-sentence imperative: what to do (e.g. "Use dependency injection via constructor")
- dontClause (string): What NOT to do (e.g. "Don't instantiate services with new directly")
- whenClause (string): When this pattern applies (e.g. "When creating a new ViewController subclass")
- topicHint (string): Group label for related patterns (e.g. "Networking", "UI-Layout", "Error-Handling")
- coreCode (string): Minimal 3-10 line code skeleton that captures the essence. Must be syntactically complete — balanced brackets/parentheses, never start with } or ) and never end with { or (
- constraints (object, optional): { "preconditions": ["<conditions that must be true before using this pattern>"], "sideEffects": ["<observable side effects of using this code>"], "boundaries": ["<usage limitations or scope restrictions>"] }
- aiInsight (string, optional): One-sentence concise insight — the single most important takeaway about this code pattern

IMPORTANT: content.pattern must contain the COMPLETE source code. content.markdown must be a meaningful project-specific writeup, NOT just a copy of description. content.rationale must explain WHY this pattern is designed this way. reasoning.whyStandard must explain WHY this pattern matters.
${langInstruction}
Return ONLY a JSON array. Do NOT return an empty array.

Files Content:
${files}`;
    }

    return `# Role
You are a ${langProfile.role} extracting production-quality reusable code patterns.

# Goal
Extract meaningful, complete code patterns from "${targetName}". Each recipe must provide real value to a developer.
${skillSection}${astSection}

# What makes a GOOD recipe
- A **complete function/method** or **logical code block** (10-40 lines typically), NOT individual statements
- Code that demonstrates a **real design pattern**: ${langProfile.patternExamples}
- Code that a developer would actually **copy-paste and adapt** for a new feature

# What makes a BAD recipe (AVOID these)
- Trivial 2-3 line snippets like just a single assignment or import
- Overly generic code that doesn't reflect the file's actual logic
- Breaking a single function into multiple tiny recipes

# Extraction Strategy
For each function/method/class in the file, ask: "Would a developer benefit from having this as a reusable template?" If yes, extract the **complete unit** with its full body.

${langProfile.extractionExamples}

# Rules
1. \`content.pattern\` must contain a **complete function/method or logical unit** — include the signature and full body
2. \`content.markdown\` must be a meaningful project-specific writeup explaining what this code does and when to use it
3. Preserve the file's actual code. Use \`<#placeholder#>\` ONLY for literal strings/values a developer would customize
4. Every recipe must be traceable to real code in the file. Do NOT invent code
5. Include relevant \`headers\` (import/require lines) that the code depends on
6. Every recipe must have a concise \`doClause\` and a \`topicHint\` group label

# Output (JSON Array)
Each item MUST use the following V3 KnowledgeEntry structure:
- title (string): Descriptive English name
- description (string): 2-3 sentences explaining what this code does, written as a project-specific guide
- trigger (string): @shortcut (kebab-case, e.g. "@url-parser")
- kind (string): "rule" | "pattern" | "fact" — rule = always-do/never-do, pattern = reusable recipe with code, fact = reference info
- knowledgeType (string): "code-pattern" | "architecture" | "api-usage" | "naming-convention" | "error-handling" | "performance" | "best-practice"
- complexity (string): "basic" | "intermediate" | "advanced"
- scope (string): "universal" | "project-specific" | "team-convention"
- category: ${langProfile.categories}
- language: "${langProfile.primaryLanguage}"
- content (object): { "pattern": "<complete function/method/class from the file>", "markdown": "<project-specific writeup: what this pattern does, when to use it, key design decisions>", "rationale": "<why this pattern is designed this way — design trade-offs, alternatives considered>" }
- reasoning (object): { "whyStandard": "<why this is a standard/best-practice worth following>", "sources": ["<source file names>"], "confidence": <0.0-1.0> }
- headers (string[]): Required import/require lines
- tags (string[]): Search keywords
- doClause (string): One-sentence imperative: what to do (e.g. "Use dependency injection via constructor")
- dontClause (string): What NOT to do (e.g. "Don't instantiate services with new directly")
- whenClause (string): When this pattern applies (e.g. "When creating a new ViewController subclass")
- topicHint (string): Group label (e.g. "Networking", "UI-Layout")
- coreCode (string): Minimal 3-10 line code skeleton that captures the essence. Must be syntactically complete — balanced brackets/parentheses, never start with } or ) and never end with { or (
- constraints (object, optional): { "preconditions": ["<conditions that must be true before using this pattern>"], "sideEffects": ["<observable side effects of using this code>"], "boundaries": ["<usage limitations or scope restrictions>"] }
- aiInsight (string, optional): One-sentence concise insight — the single most important takeaway about this code pattern

IMPORTANT: content.pattern must contain the COMPLETE source code. content.markdown must be a meaningful project-specific writeup, NOT just a copy of description. content.rationale must explain WHY this pattern is designed this way. reasoning.whyStandard must explain WHY this pattern matters.
${langInstruction}
Return ONLY a JSON array. If no meaningful patterns found, return [].

Files Content:
${files}`;
  }

  /**
   * 根据用户语言偏好生成输出语言指令
   * @param {string} [lang] - 语言代码，如 'zh', 'en'
   * @returns {string} 语言指令段落（为空则返回空字符串）
   */
  _buildLangInstruction(lang) {
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

  /**
   * 根据文件扩展名检测语言特征，返回提示词适配参数
   */
  _detectLanguageProfile(filesContent) {
    const extCounts = {};
    for (const f of filesContent) {
      const ext = (f.name || '').split('.').pop()?.toLowerCase() || '';
      extCounts[ext] = (extCounts[ext] || 0) + 1;
    }

    // 使用 LanguageService 推断主语言
    const primaryLang = LanguageService.detectPrimary(extCounts);
    const dominant = Object.entries(extCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

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
   * @param {Array<object>} candidates - 候选对象数组，每项至少含 {code, language, title?}
   * @returns {Promise<Array<object>>} enriched 候选数组（仅含补全的字段）
   */
  async enrichCandidates(candidates, options = {}) {
    const prompt = this._buildEnrichPrompt(candidates, options);
    const parsed = await this.chatWithStructuredOutput(prompt, {
      openChar: '[',
      closeChar: ']',
      temperature: 0.3,
    });
    return Array.isArray(parsed) ? parsed : [];
  }

  /**
   * 构建 enrichCandidates 提示词
   */
  _buildEnrichPrompt(candidates, options = {}) {
    const items = candidates
      .map((c, i) => {
        const existing = [];
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
  async _fetch(url, options = {}) {
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
  extractJSON(text, openChar = '{', closeChar = '}') {
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
  _repairTruncatedArray(text) {
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

  /**
   * 字符级深度追踪修复（原逻辑，处理标准 JSON）
   */
  _repairByCharTracking(text) {
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
  _repairByRegexFallback(text) {
    // 收集所有 "}" 后跟 "," 或空白的位置（可能是对象边界）
    const candidates = [];
    const re = /\}[\s,]*(?=\s*[[{]|$)/g;
    let m;
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

  /**
   * 在指定位置截断并尝试闭合 JSON 数组
   */
  _tryRepairAt(text, endPos) {
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
  async _withRetry(fn, retries = this.maxRetries, baseDelay = 2000) {
    // ── 熔断器检查 ──
    if (this._circuitState === 'OPEN') {
      const elapsed = Date.now() - (this._circuitOpenedAt || 0);
      if (elapsed < (this._circuitCooldownMs || 30000)) {
        const err = new Error(
          `AI 服务熔断中 (连续 ${this._circuitFailures} 次失败)，${Math.ceil(((this._circuitCooldownMs || 30000) - elapsed) / 1000)}s 后恢复`
        );
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
      // 冷却期结束 → HALF_OPEN
      this._circuitState = 'HALF_OPEN';
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await fn();
        // 成功 → 完全重置熔断器（包括冷却时间）
        this._circuitFailures = 0;
        this._circuitState = 'CLOSED';
        this._circuitCooldownMs = 30_000; // 重置冷却时间
        return result;
      } catch (err) {
        // ── 综合判断是否为可重试的网络/服务端错误 ──
        const causeCode = err.cause?.code || '';
        // 网络级错误：无 HTTP status，底层连接失败
        const isNetworkError =
          !err.status &&
          (err.message === 'fetch failed' ||
            err.code === 'ECONNRESET' ||
            causeCode === 'ECONNRESET' ||
            err.code === 'ECONNREFUSED' ||
            causeCode === 'ECONNREFUSED' ||
            err.code === 'ENOTFOUND' ||
            causeCode === 'ENOTFOUND' ||
            err.code === 'ECONNABORTED' ||
            causeCode === 'ECONNABORTED' ||
            err.code === 'ETIMEDOUT' ||
            causeCode === 'ETIMEDOUT' ||
            err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
            causeCode === 'UND_ERR_CONNECT_TIMEOUT' ||
            err.code === 'UND_ERR_SOCKET' ||
            causeCode === 'UND_ERR_SOCKET');
        const isRetryable = err.status === 429 || err.status >= 500 || isNetworkError;

        // 首次失败记录详细诊断（含 cause）
        if (attempt === 0 && (isNetworkError || err.cause)) {
          this._log?.(
            'warn',
            `[_withRetry] ${err.message} — cause: ${err.cause?.message || causeCode || 'unknown'}`
          );
        }

        if (attempt >= retries || !isRetryable) {
          // 只有服务端错误 / 网络错误才累计熔断计数
          // 客户端错误 (4xx 非 429) 不应触发熔断 — 那是请求本身的问题
          const isServerError =
            isNetworkError || err.status === 429 || err.status >= 500 || !err.status;
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
          throw err;
        }
        const delay = baseDelay * 2 ** attempt + Math.random() * 1000;
        this._log?.(
          'info',
          `[_withRetry] attempt ${attempt + 1} failed (${err.message}), retrying in ${Math.round(delay / 1000)}s…`
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}

export default AiProvider;

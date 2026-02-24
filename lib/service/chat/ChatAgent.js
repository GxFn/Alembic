/**
 * ChatAgent — 项目内唯一 AI 执行中心 (ReAct + DAG Pipeline)
 *
 * 设计原则: 项目内所有 AI 调用都走 ChatAgent + tool 体系。
 * bootstrapKnowledge() 等共享 handler 只做纯启发式，不直接调 AI。
 *
 * 三种调用模式:
 * - Dashboard Chat: execute(prompt, history) → ReAct 循环 → 自动调用工具 → 返回最终回答
 * - 程序化调用: executeTool(toolName, params) → 直接执行指定工具
 * - DAG 管线: runTask(taskName, params) → TaskPipeline 编排多工具协作（支持依赖、并行、条件跳过）
 *
 *   冷启动只是 DAG 管线的一个实例（bootstrap_full_pipeline），
 *   同样的机制可用于任何多步骤 AI 工作流。
 *
 * 与 MCP 外部 Agent 的分工:
 *   - ChatAgent: 项目内 AI（Dashboard、HTTP API），所有 AI 推理都经过 tool
 *   - MCP: 为外部 Agent（Cursor/Claude）暴露工具，外部 Agent 自带 AI 能力
 *   - 共享: handlers/bootstrap-internal.js 等底层 handler 被两者复用（纯数据处理，无 AI）
 *
 * ReAct 模式:
 *   Thought → Action(tool_name, params) → Observation → ... → Answer
 *   最多 MAX_ITERATIONS 轮，防止无限循环
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Logger from '../../infrastructure/logging/Logger.js';
import {
  buildNativeToolSystemPrompt,
  buildProjectBriefing,
  cleanFinalAnswer,
} from './ChatAgentPrompts.js';
import {
  taskCheckAndSubmit,
  taskDiscoverAllRelations,
  taskFullEnrich,
  taskGuardFullScan,
  taskQualityAudit,
} from './ChatAgentTasks.js';
import { ContextWindow, limitToolResult, PhaseRouter } from './ContextWindow.js';
import { ConversationStore } from './ConversationStore.js';
import { Memory } from './Memory.js';
import { ReasoningLayer } from './ReasoningLayer.js';
import { TaskPipeline } from './TaskPipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SKILLS_DIR = path.resolve(PROJECT_ROOT, 'skills');
const SOUL_PATH = path.resolve(PROJECT_ROOT, 'SOUL.md');
const MAX_ITERATIONS = 6;
/** 系统调用 (如 bootstrap) 允许更多迭代,因为每维度需要多次 submit_knowledge */
const MAX_ITERATIONS_SYSTEM = 30;
/** 原生函数调用模式下，已提交 ≥ MIN_SUBMITS_FOR_EARLY_EXIT 个候选后，连续 N 轮无新提交则提前退出 */
const _MIN_SUBMITS_FOR_EARLY_EXIT = 1;
const IDLE_ROUNDS_TO_EXIT = 2;
/** 单个维度最多提交候选数量 — 超过后跳过提交返回提醒 */
const MAX_SUBMITS_PER_DIMENSION = 6;
/** 提交达到软上限后注入收尾提示的阈值 */
const SOFT_SUBMIT_LIMIT = 4;
/** 连续搜索/阅读轮次预算 — 超过后注入提交提示并切 auto */
const SEARCH_BUDGET = 8;
/** 搜索预算耗尽后，额外容忍的轮次 — 再未提交则强制退出 */
const SEARCH_BUDGET_GRACE = 4;

/** 默认预算配置 — 可通过 execute() 的 opts.budget 覆盖 */
const DEFAULT_BUDGET = Object.freeze({
  maxIterations: MAX_ITERATIONS_SYSTEM,
  searchBudget: SEARCH_BUDGET,
  searchBudgetGrace: SEARCH_BUDGET_GRACE,
  maxSubmits: MAX_SUBMITS_PER_DIMENSION,
  softSubmitLimit: SOFT_SUBMIT_LIMIT,
  idleRoundsToExit: IDLE_ROUNDS_TO_EXIT,
});

export class ChatAgent {
  #toolRegistry;
  #aiProvider;
  #container;
  #logger;
  /** @type {Map<string, TaskPipeline>} */
  #pipelines = new Map();
  /** @type {string} 缓存的项目概况（每次 execute 刷新一次） */
  #projectBriefingCache = '';
  /** @type {Memory|null} 跨对话轻量记忆 */
  #memory = null;
  /** @type {ConversationStore|null} 对话持久化 */
  #conversations = null;
  /** @type {string|null} 当前 execute 调用的 source — 'user' | 'system' */
  #currentSource = null;
  /** @type {string|null} 当前 execute 调用的 UI 语言偏好 — 'zh' | 'en' | null */
  #currentLang = null;
  /** @type {string|null} 默认 UI 语言偏好（通过 setLang 设置，bootstrap 等非对话场景使用） */
  #defaultLang = null;
  /** @type {Array|null} 内存文件缓存（bootstrap 场景注入，search_project_code/read_project_file 优先使用） */
  #fileCache = null;
  /** @type {Set<string>} 跨维度已提交候选标题（bootstrap 全局去重） */
  #globalSubmittedTitles = new Set();
  /** @type {Set<string>} 跨维度已提交代码模式指纹（bootstrap 全局去重） */
  #globalSubmittedPatterns = new Set();
  /** @type {{ input: number, output: number }} 当前 execute() 累计 token 用量 */
  #currentTokenUsage = { input: 0, output: 0 };
  /** @type {import('./ProjectSemanticMemory.js').ProjectSemanticMemory|null} Tier 3 语义记忆 */
  #semanticMemory = null;

  /**
   * @param {object} opts
   * @param {import('./ToolRegistry.js').ToolRegistry} opts.toolRegistry
   * @param {import('../../external/ai/AiProvider.js').AiProvider} opts.aiProvider
   * @param {import('../../injection/ServiceContainer.js').ServiceContainer} opts.container
   */
  constructor({ toolRegistry, aiProvider, container }) {
    this.#toolRegistry = toolRegistry;
    this.#aiProvider = aiProvider;
    this.#container = container;
    this.#logger = Logger.getInstance();

    /** 是否有 AI Provider（只读） */
    this.hasAI = !!aiProvider;

    /**
     * 是否有真实（非 Mock）AI Provider
     * MockProvider 不具备实际推理能力，bootstrap 编排时应视为 AI 不可用
     */
    this.hasRealAI = !!aiProvider && aiProvider.name !== 'mock';

    /** AI Provider 引用（只读）— 用于外部模块直接调用 structuredOutput / extractJSON */
    this.aiProvider = aiProvider || null;

    // 初始化跨对话记忆 + 对话持久化
    try {
      const projectRoot = container?.singletons?._projectRoot || process.cwd();
      this.#memory = new Memory(projectRoot);
      this.#conversations = new ConversationStore(projectRoot);
    } catch {
      /* Memory/ConversationStore init failed, degrade silently */
    }

    // v4.1: 尝试初始化 ProjectSemanticMemory (Tier 3)
    this.#initSemanticMemory(container);

    // 注册内置 DAG 管线
    this.#registerBuiltinPipelines();

    // 从系统环境变量检测默认语言
    const sysLang = (process.env.LANG || '').split('.')[0];
    if (sysLang.startsWith('en')) {
      this.#defaultLang = 'en';
    } else if (sysLang.startsWith('zh')) {
      this.#defaultLang = 'zh';
    }
  }

  // ─── 公共 API ─────────────────────────────────────────

  /**
   * 注入内存文件缓存（bootstrap 场景: allFiles 已在内存中，避免重复磁盘读取）
   * 调用后 search_project_code / read_project_file 优先从缓存查找
   * @param {Array|null} files — [{ relativePath, content, name }]
   */
  setFileCache(files) {
    this.#fileCache = files;
  }

  /**
   * 设置 ProjectSemanticMemory 实例 (Tier 3)
   * @param {import('./ProjectSemanticMemory.js').ProjectSemanticMemory|null} sm
   */
  setSemanticMemory(sm) {
    this.#semanticMemory = sm;
  }

  /**
   * 重置跨维度全局提交标题（新 bootstrap session 开始时调用）
   */
  resetGlobalSubmittedTitles() {
    this.#globalSubmittedTitles.clear();
    this.#globalSubmittedPatterns.clear();
  }

  /**
   * 获取当前默认 UI 语言偏好
   * @returns {'zh'|'en'|null}
   */
  getLang() {
    return this.#defaultLang;
  }

  /**
   * 设置默认 UI 语言偏好（影响 Agent 回复语言）
   * 由前端通过 bootstrap/chat 等 API 设置，后续所有 AI 调用自动继承。
   * @param {'zh'|'en'|null} lang
   */
  setLang(lang) {
    this.#defaultLang = lang || null;
  }

  /**
   * 交互式对话（Dashboard Chat 入口）
   * 自动带 ReAct 循环: LLM 可决定调用工具或直接回答
   *
   * @param {string} prompt — 用户消息
   * @param {object} opts
   * @param {Array}  opts.history — 对话历史 [{role, content}]
   * @param {string} [opts.conversationId] — 对话 ID（启用持久化时）
   * @param {'user'|'system'} [opts.source='user'] — 调用来源（影响 Memory 隔离）
   * @param {object} [opts.dimensionMeta] — Bootstrap 维度元数据 { id, outputType, allowedKnowledgeTypes }
   * @param {string} [opts.projectLanguage] — 项目主语言 (e.g. 'swift', 'objectivec')，注入到 submit tool ctx
   * @returns {Promise<{reply: string, toolCalls: Array, hasContext: boolean, conversationId?: string}>}
   */
  async execute(
    prompt,
    {
      history = [],
      conversationId,
      source = 'user',
      budget: budgetOverrides,
      dimensionId,
      dimensionMeta,
      // v3.0: Agent 分离选项
      systemPromptOverride, // 覆盖默认 system prompt (Analyst/Producer 各自使用)
      allowedTools, // 覆盖默认工具白名单 (string[])
      disablePhaseRouter = false, // 禁用 PhaseRouter (Analyst 不需要阶段控制)
      temperature: temperatureOverride, // 覆盖默认温度
      projectLanguage, // 项目主语言，注入到 submit tool 的 ctx._projectLanguage
      lang, // UI 语言偏好 ('zh'|'en')，控制回复语言
      // v4.0: Agent Memory 集成
      workingMemory, // WorkingMemory 实例 (由 orchestrator 注入)
      episodicMemory, // EpisodicMemory 实例 (跨维度情景记忆)
      toolResultCache, // ToolResultCache 实例 (跨维度工具结果缓存)
      // v5.1: SSE 流式进度回调
      onProgress, // (event: {type, ...}) => void — 实时推送思考/工具/回答事件
    } = {}
  ) {
    this.#currentSource = source;
    this.#currentLang = lang || this.#defaultLang || null;
    this.#currentTokenUsage = { input: 0, output: 0 };
    const execStartTime = Date.now();
    const promptPreview = prompt.length > 80 ? `${prompt.substring(0, 80)}…` : prompt;
    this.#logger.info(
      `[ChatAgent] ▶ execute — source=${source}${dimensionMeta?.id ? `, dim=${dimensionMeta.id}(${dimensionMeta.outputType})` : dimensionId ? `, dim=${dimensionId}` : ''}, prompt="${promptPreview}", historyLen=${history.length}${conversationId ? `, convId=${conversationId.substring(0, 8)}` : ''}`
    );

    // 合并预算配置: 默认值 + 外部覆盖
    const budget = budgetOverrides
      ? { ...DEFAULT_BUDGET, ...budgetOverrides }
      : { ...DEFAULT_BUDGET };

    // 对话持久化: 如果传了 conversationId，从 ConversationStore 加载历史
    let effectiveHistory = history;
    if (conversationId && this.#conversations) {
      effectiveHistory = this.#conversations.load(conversationId);
      this.#logger.info(
        `[ChatAgent] loaded ${effectiveHistory.length} messages from conversation store`
      );
      this.#conversations.append(conversationId, { role: 'user', content: prompt });
    }

    // 每次对话刷新项目概况（不是每轮 ReAct）
    this.#projectBriefingCache = await buildProjectBriefing({ container: this.#container });

    // ── 统一原生函数调用路径（v5.0: 移除文本解析路径） ──
    // 所有 Provider 均通过 chatWithTools() 进行结构化工具调用。
    // 不支持原生函数调用的 Provider 在基类 chatWithTools() 中降级为 chat()，
    // 返回 { text, functionCalls: null }，被 native 循环视为最终回答。
    this.#logger.info(`[ChatAgent] ✨ using NATIVE tool calling mode (${this.#aiProvider.name})`);
    let result;
    result = await this.#executeWithNativeTools(prompt, {
      effectiveHistory,
      conversationId,
      source,
      execStartTime,
      budget,
      dimensionMeta,
      systemPromptOverride,
      allowedTools,
      disablePhaseRouter,
      temperatureOverride,
      projectLanguage,
      workingMemory,
      episodicMemory,
      toolResultCache,
      onProgress,
    });

    // SSE: 推送最终回答（分块模拟流式）
    if (onProgress && result.reply) {
      const textId = `ans_${Date.now()}`;
      onProgress({ type: 'text:start', id: textId, role: 'answer' });
      // 分块推送：每 ~20 字符一块，模拟逐 token 打字效果
      const CHUNK = 20;
      const text = result.reply;
      for (let i = 0; i < text.length; i += CHUNK) {
        onProgress({ type: 'text:delta', id: textId, delta: text.slice(i, i + CHUNK) });
      }
      onProgress({ type: 'text:end', id: textId });
    }

    // 持久化 assistant 回复
    if (conversationId && this.#conversations) {
      this.#conversations.append(conversationId, { role: 'assistant', content: result.reply });
      this.#autoSummarize(conversationId).catch((err) => {
        this.#logger.debug('[ChatAgent] autoSummarize failed', {
          conversationId,
          error: err.message,
        });
      });
    }

    this.#extractMemory(prompt, result.reply);

    // 附加 token 用量统计
    result.tokenUsage = { ...this.#currentTokenUsage };

    // 持久化 token 消耗到数据库（fire-and-forget）
    try {
      const tokenStore = this.#container?.get?.('tokenUsageStore');
      if (tokenStore) {
        const aiProvider = this.#aiProvider;
        tokenStore.record({
          source: source || 'unknown',
          dimension: dimensionId || dimensionMeta?.id || null,
          provider: aiProvider?.name || null,
          model: aiProvider?.model || null,
          inputTokens: this.#currentTokenUsage.input,
          outputTokens: this.#currentTokenUsage.output,
          durationMs: Date.now() - execStartTime,
          toolCalls: result.toolCalls?.length || 0,
          sessionId: conversationId || null,
        });

        // 通知前端 token 用量变化
        try {
          const realtime = this.#container?.get?.('realtimeService');
          realtime?.broadcastTokenUsageUpdated?.();
        } catch {
          /* optional */
        }
      }
    } catch {
      /* token logging should never break execution */
    }

    return { ...result, conversationId };
  }

  // ─── Native Tool Calling ReAct 循环 ──────────────────────

  /**
   * 原生结构化函数调用 ReAct 循环
   *
   * 三层架构:
   *   1. ContextWindow — 消息生命周期 + 三级递进压缩
   *   2. PhaseRouter — 阶段状态机 (EXPLORE→PRODUCE→SUMMARIZE)
   *   3. ToolResultLimiter — 工具结果入口压缩 (动态配额)
   *
   * @param {string} prompt
   * @param {object} opts
   * @returns {Promise<{reply: string, toolCalls: Array, hasContext: boolean}>}
   */
  async #executeWithNativeTools(
    prompt,
    {
      effectiveHistory,
      conversationId,
      source,
      execStartTime,
      budget = DEFAULT_BUDGET,
      dimensionMeta,
      // v3.0: Agent 分离新增选项
      systemPromptOverride,
      allowedTools,
      disablePhaseRouter = false,
      temperatureOverride,
      projectLanguage,
      // v4.0: Agent Memory 集成
      workingMemory,
      episodicMemory,
      toolResultCache,
      // v5.1: SSE 流式进度回调
      onProgress,
    }
  ) {
    const isSystem = source === 'system';
    const isSkillOnly = dimensionMeta?.outputType === 'skill';
    const temperature = temperatureOverride ?? (isSystem ? 0.3 : 0.7);

    // ── Layer 1: ContextWindow ──
    // messages[0] = prompt（不可压缩），历史消息在前面
    // token 预算按模型动态适配：大窗口模型(Gemini/Claude)给更多预算，小窗口(Ollama)限制预算
    const tokenBudget = ContextWindow.resolveTokenBudget(this.#aiProvider?.model, { isSystem });
    const ctx = new ContextWindow(tokenBudget);
    for (const h of effectiveHistory) {
      if (h.role === 'assistant') {
        ctx.appendAssistantText(h.content);
      } else {
        ctx.appendUserMessage(h.content);
      }
    }
    // prompt 作为最终 user message（Anthropic 最佳实践: 查询放在所有上下文之后）
    ctx.appendUserMessage(prompt);

    // ── P5: Pre-check — 首条 prompt 过大时预警 ──
    const initialUsage = ctx.getTokenUsageRatio();
    if (initialUsage > 0.7) {
      this.#logger.warn(
        `[ChatAgent] ⚠ initial prompt already at ${(initialUsage * 100).toFixed(0)}% of token budget (${ctx.estimateTokens()}/${ctx.tokenBudget})`
      );
      if (initialUsage > 0.9 && isSystem) {
        // 仅 1 条消息时 compactIfNeeded 无法压缩（需 >4 条），
        // 依赖 P0/P1 信号限制来控制 prompt 大小
        this.#logger.warn(
          `[ChatAgent] ⚠ prompt exceeds 90% budget — P0/P1 signal limiting should have prevented this. Check PROMPT_LIMITS config.`
        );
      }
    }

    // ── Layer 2: PhaseRouter (仅 system 源且未禁用时使用) ──
    const phaseRouter =
      isSystem && !disablePhaseRouter ? new PhaseRouter(budget, isSkillOnly) : null;

    // ── 系统提示词 (支持外部覆盖) ──
    let baseSystemPrompt =
      systemPromptOverride ||
      buildNativeToolSystemPrompt({
        currentSource: this.#currentSource,
        projectBriefingCache: this.#projectBriefingCache,
        memory: this.#memory,
        semanticMemory: this.#semanticMemory,
        budget,
        soulPath: SOUL_PATH,
      });

    // ── 统一注入语言指令（对所有来源生效: user 对话 / system bootstrap / analyst / producer）──
    const effectiveLang = this.#currentLang;
    if (effectiveLang === 'en') {
      baseSystemPrompt +=
        '\n\n## Language\nYou MUST respond in English. All output text, analysis, titles and descriptions must be in English.';
    } else if (effectiveLang === 'zh') {
      baseSystemPrompt +=
        '\n\n## 语言\n你必须使用中文回复。所有输出文本、分析、标题和描述都必须是中文。';
    }

    // 统一注入轮次预算，确保 AI 始终知道具体数字和节奏
    if (isSystem && !baseSystemPrompt.includes('轮次预算')) {
      const exploreEnd = Math.floor(budget.maxIterations * 0.6);
      const verifyEnd = Math.floor(budget.maxIterations * 0.8);
      baseSystemPrompt += `\n\n## 轮次预算\n- 总轮次: **${budget.maxIterations} 轮**\n- 探索阶段: 第 1-${exploreEnd} 轮（搜索和结构化查询）\n- 验证阶段: 第 ${exploreEnd + 1}-${verifyEnd} 轮（读取关键文件确认细节）\n- 总结阶段: 第 ${verifyEnd + 1}-${budget.maxIterations} 轮（**停止工具调用，输出分析文本**）\n\n到达第 ${verifyEnd} 轮时你必须开始输出总结，不要继续搜索。`;
    }

    // Bootstrap 场景限制可用工具集 (支持外部覆盖)
    const effectiveAllowedTools =
      allowedTools ||
      (isSystem
        ? [
            'search_project_code',
            'read_project_file',
            'submit_knowledge',
            'submit_with_check',
            'list_project_structure',
            'get_file_summary',
            'semantic_search_code',
            // AST 结构化分析工具
            'get_project_overview',
            'get_class_hierarchy',
            'get_class_info',
            'get_protocol_info',
            'get_method_overrides',
            'get_category_map',
            'get_previous_analysis',
            // Agent Memory 工具 (v4.0)
            'note_finding',
            'get_previous_evidence',
          ]
        : null);
    const toolSchemas = this.#toolRegistry.getToolSchemas(effectiveAllowedTools);

    const toolCalls = [];
    const maxIter = isSystem ? budget.maxIterations : MAX_ITERATIONS;
    let consecutiveAiErrors = 0;
    let consecutiveEmptyResponses = 0;
    let iterationCount = 0; // v3: 独立迭代计数器
    const submittedTitles = new Set(this.#globalSubmittedTitles);
    const sharedState = {}; // P2.2: 跨工具调用共享状态（搜索计数器等）

    // ── 进度感知收敛 (Analyst 专用: disablePhaseRouter=true) ──
    // 追踪搜索/读取新信息的效率，当探索饱和时提前引导 AI 收敛
    const explorationMetrics = {
      uniqueFiles: new Set(), // 已读取的唯一文件
      uniquePatterns: new Set(), // 已搜索的唯一 pattern
      uniqueQueries: new Set(), // 已查询的唯一类名/目录（AST + list_project_structure）
      totalToolCalls: 0, // 总工具调用数
      newInfoRounds: 0, // 最近 N 轮中获取到新信息的轮次
      staleRounds: 0, // 连续未获取新信息的轮次
      convergenceNudged: false, // 是否已注入收敛 nudge
    };
    const MIN_EXPLORE_ITERS = 16; // 最少探索轮次（冷启动质量保障）
    const STALE_THRESHOLD = 3; // 连续无新信息轮次触发收敛

    // ── Layer 4: ReasoningLayer — 推理链采集 + 结构化观察 + 反思 + 规划 ──
    const reasoning = new ReasoningLayer({
      enabled: true,
      reflectionEnabled: isSystem, // 仅 system 模式启用反思
      reflectionInterval: isSystem ? 5 : 0,
      planningEnabled: isSystem, // 仅 system 模式启用规划
      replanInterval: isSystem ? 8 : 0,
      deviationThreshold: 0.6,
    });

    // ── 主循环 ──
    while (true) {
      // PhaseRouter tick + 退出检查
      if (phaseRouter) {
        phaseRouter.tick();
        if (phaseRouter.shouldExit()) {
          this.#logger.info(
            `[ChatAgent] PhaseRouter exit: phase=${phaseRouter.phase}, iter=${phaseRouter.totalIterations}, submits=${phaseRouter.totalSubmits}`
          );
          break;
        }
        // PhaseRouter 因 maxIterations 强制转入 SUMMARIZE → 注入收尾 nudge
        if (phaseRouter.consumeForcedSummarize()) {
          const submitCount = toolCalls.filter(
            (tc) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check'
          ).length;
          ctx.appendUserNudge(
            `⚠️ 轮次即将耗尽 (${phaseRouter.totalIterations}/${budget.maxIterations})，**必须立即结束**。请在回复中直接输出 dimensionDigest JSON 总结（用 \`\`\`json 包裹），不要再调用任何工具。\n` +
              `\`\`\`json\n{"dimensionDigest":{"summary":"分析总结","candidateCount":${submitCount},"keyFindings":["发现"],"crossRefs":{},"gaps":["缺口"],"remainingTasks":[{"signal":"未处理信号","reason":"轮次耗尽","priority":"high","searchHints":["搜索词"]}]}}\n\`\`\`\n> remainingTasks: 列出未来得及处理的信号。已覆盖则留空 \`[]\`。`
          );
          this.#logger.info(
            '[ChatAgent] 📝 injected forced SUMMARIZE nudge (maxIterations reached)'
          );
        }
      } else if (
        isSystem &&
        !phaseRouter &&
        !ctx.__gracefulExitInjected &&
        !explorationMetrics.convergenceNudged &&
        iterationCount >= MIN_EXPLORE_ITERS &&
        explorationMetrics.staleRounds >= STALE_THRESHOLD
      ) {
        // ── 进度感知收敛：探索已饱和，提前引导 AI 总结 ──
        this.#logger.info(
          `[ChatAgent] 📊 Exploration saturated at iter ${iterationCount}/${maxIter} — ` +
            `files=${explorationMetrics.uniqueFiles.size}, patterns=${explorationMetrics.uniquePatterns.size}, ` +
            `queries=${explorationMetrics.uniqueQueries.size}, staleRounds=${explorationMetrics.staleRounds} — nudging convergence`
        );
        ctx.appendUserNudge(
          `你已经充分探索了项目代码（${explorationMetrics.uniqueFiles.size} 个文件，${explorationMetrics.uniquePatterns.size} 次不同搜索，${explorationMetrics.uniqueQueries.size} 次结构化查询）。` +
            `最近 ${explorationMetrics.staleRounds} 轮没有发现新信息，建议开始撰写分析总结。\n` +
            `如果你确信还有重要方面未覆盖，可以继续探索（剩余 ${maxIter - iterationCount} 轮）；否则请直接输出你的分析发现。`
        );
        explorationMetrics.convergenceNudged = true;
        // 不 break，不设 toolChoice=none — 这是软 nudge，AI 仍可继续探索
      } else if (
        isSystem &&
        !phaseRouter &&
        !ctx.__budgetWarningInjected &&
        iterationCount >= Math.floor(maxIter * 0.75)
      ) {
        // ── 预算感知提醒：75% 预算消耗时轻量提示 ──
        ctx.appendUserNudge(
          `📌 进度提醒：你已使用 ${iterationCount}/${maxIter} 轮次（${Math.round((iterationCount / maxIter) * 100)}%）。` +
            `请确保核心方面已覆盖，开始准备总结。剩余 ${maxIter - iterationCount} 轮，优先填补最重要的分析空白。`
        );
        ctx.__budgetWarningInjected = true;
        this.#logger.info(
          `[ChatAgent] 📌 Budget warning at ${iterationCount}/${maxIter} (${Math.round((iterationCount / maxIter) * 100)}%)`
        );
      } else if (isSystem && iterationCount >= maxIter && !ctx.__gracefulExitInjected) {
        // 达到上限 → 注入收尾消息让 AI 快速总结（而非硬中断）
        this.#logger.info(
          `[ChatAgent] Iteration cap reached (${iterationCount}/${maxIter}) — injecting graceful exit nudge`
        );
        const submitCount = toolCalls.filter(
          (tc) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check'
        ).length;
        ctx.appendUserNudge(
          `⚠️ 你已使用 ${iterationCount}/${maxIter} 轮次，**必须立即结束**。请在回复中直接输出 dimensionDigest JSON 总结（用 \`\`\`json 包裹），不要再调用任何工具。\n` +
            `\`\`\`json\n{"dimensionDigest":{"summary":"分析总结","candidateCount":${submitCount},"keyFindings":["发现"],"crossRefs":{},"gaps":["缺口"],"remainingTasks":[{"signal":"未处理信号","reason":"轮次耗尽","priority":"high","searchHints":["搜索词"]}]}}\n\`\`\`\n> remainingTasks: 列出未来得及处理的信号。已覆盖则留空 \`[]\`。`
        );
        ctx.__gracefulExitInjected = true;
        // 不 break，给 AI 2 轮 grace 来产出总结
        // 继续 while 循环
      } else if (isSystem && iterationCount >= maxIter + 2) {
        // 硬上限兜底：grace 轮次也耗尽
        this.#logger.info(`[ChatAgent] Hard cap reached: ${iterationCount}/${maxIter + 2}`);
        break;
      } else if (!isSystem && ctx.length > maxIter * 2 + 2) {
        // 用户对话模式: 简单的消息数限制
        break;
      }
      iterationCount++;

      const iterStartTime = Date.now();
      const currentIter = phaseRouter?.totalIterations || iterationCount;

      // ── 动态 toolChoice (由 PhaseRouter 决定) ──
      let currentChoice;
      if (ctx.__gracefulExitInjected) {
        // graceful exit: 禁止工具调用，强制 AI 输出文本总结
        currentChoice = 'none';
      } else if (phaseRouter) {
        currentChoice = phaseRouter.getToolChoice();
      } else {
        currentChoice = 'auto';
      }

      // ── ReasoningLayer Hook 1: beforeAICall — 开始新轮次 + 反思检查 ──
      const reflectionNudge = reasoning.beforeAICall(iterationCount, {
        explorationMetrics,
        budget,
        phase: phaseRouter?.phase,
      });
      if (reflectionNudge) {
        ctx.appendUserNudge(reflectionNudge);
        this.#logger.info(`[ChatAgent] 💭 injected reflection at iteration ${iterationCount}`);
      }

      // ── 压缩检查 (每次 AI 调用前) ──
      const compactResult = ctx.compactIfNeeded();
      if (compactResult.level > 0) {
        this.#logger.info(
          `[ChatAgent] context compacted: L${compactResult.level}, removed ${compactResult.removed} items`
        );
      }

      // ── 构建 systemPrompt (含阶段提示) ──
      let systemPrompt = baseSystemPrompt;
      if (phaseRouter) {
        const hint = phaseRouter.getPhaseHint();
        if (hint) {
          systemPrompt += `\n\n## 当前状态\n${hint}`;
        }
      } else if (isSystem) {
        // 非 PhaseRouter 路径：注入实时轮次计数器，让 AI 始终感知进度
        const verifyStart = Math.floor(maxIter * 0.8);
        const remaining = maxIter - iterationCount;
        let phaseLabel;
        if (iterationCount <= Math.floor(maxIter * 0.6)) {
          phaseLabel = '探索阶段';
        } else if (iterationCount <= verifyStart) {
          phaseLabel = '验证阶段';
        } else {
          phaseLabel = '⚠ 总结阶段 — 请停止工具调用，直接输出分析文本';
        }
        systemPrompt += `\n\n## 当前进度\n第 ${iterationCount}/${maxIter} 轮 | ${phaseLabel} | 剩余 ${remaining} 轮`;
      }

      // ── v4.0: WorkingMemory 上下文注入 ──
      // 当有压缩后的旧观察或 scratchpad 发现时，注入到 system prompt
      if (workingMemory && isSystem) {
        const wmContext = workingMemory.buildContext();
        if (wmContext) {
          systemPrompt += `\n\n${wmContext}`;
        }
      }

      // ── AI 调用 ──
      let aiResult;
      try {
        const messages = ctx.toMessages();
        const currentPhase = phaseRouter?.phase || 'user';
        this.#logger.info(
          `[ChatAgent] 🔄 iteration ${currentIter}/${maxIter} — phase=${currentPhase}, ${messages.length} msgs, toolChoice=${currentChoice}, tokens~${ctx.estimateTokens()}`
        );

        // SSE: 推送步骤开始
        onProgress?.({
          type: 'step:start',
          step: currentIter,
          maxSteps: maxIter,
          phase: currentPhase,
        });

        aiResult = await this.#aiProvider.chatWithTools(prompt, {
          messages,
          toolSchemas,
          toolChoice: currentChoice,
          systemPrompt,
          temperature,
          maxTokens: 8192,
        });

        const aiDuration = Date.now() - iterStartTime;

        // 累计 token 用量
        if (aiResult.usage) {
          this.#currentTokenUsage.input += aiResult.usage.inputTokens || 0;
          this.#currentTokenUsage.output += aiResult.usage.outputTokens || 0;
        }

        if (aiResult.functionCalls?.length > 0) {
          this.#logger.info(
            `[ChatAgent] ✓ AI returned ${aiResult.functionCalls.length} function calls in ${aiDuration}ms: [${aiResult.functionCalls.map((fc) => fc.name).join(', ')}]`
          );
        } else {
          const textPreview = (aiResult.text || '').substring(0, 120).replace(/\n/g, '↵');
          this.#logger.info(
            `[ChatAgent] ✓ AI returned text in ${aiDuration}ms (${(aiResult.text || '').length} chars) — "${textPreview}…"`
          );
        }
        consecutiveAiErrors = 0;

        // ── ReasoningLayer Hook 2: afterAICall — 提取 Thought ──
        reasoning.afterAICall(aiResult);
      } catch (aiErr) {
        consecutiveAiErrors++;
        this.#logger.warn(
          `[ChatAgent] AI call failed (attempt ${consecutiveAiErrors}): ${aiErr.message}`
        );

        // 熔断器已打开时立即跳出 — 不要继续浪费重试、也避免失败计数加速累积
        if (aiErr.code === 'CIRCUIT_OPEN') {
          if (isSystem) {
            this.#logger.warn(`[ChatAgent] 🛑 circuit breaker is OPEN — skipping to summary`);
            break;
          }
          reasoning.afterRound();
          return {
            reply: `抱歉，AI 服务暂时不可用（${aiErr.message}）。请稍后重试，或检查 API 配置。`,
            toolCalls,
            hasContext: toolCalls.length > 0,
            reasoningTrace: reasoning.trace,
            reasoningQuality: reasoning.getQualityMetrics(),
          };
        }

        if (consecutiveAiErrors >= 2) {
          if (isSystem) {
            this.#logger.warn(
              `[ChatAgent] 🛑 2 consecutive AI errors — resetting context, breaking to summary`
            );
            ctx.resetToPromptOnly();
            break;
          }
          reasoning.afterRound();
          onProgress?.({ type: 'step:end', step: currentIter });
          return {
            reply: `抱歉，AI 服务暂时不可用（${aiErr.message}）。请稍后重试，或检查 API 配置。`,
            toolCalls,
            hasContext: toolCalls.length > 0,
            reasoningTrace: reasoning.trace,
            reasoningQuality: reasoning.getQualityMetrics(),
          };
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      // ── 处理 functionCalls ──
      if (aiResult.functionCalls && aiResult.functionCalls.length > 0) {
        // ── Graceful exit 保护: Gemini 有时会无视 toolChoice='none' 继续返回工具调用
        //    强制忽略工具调用，将附带文本视为最终回复
        if (ctx.__gracefulExitInjected) {
          this.#logger.warn(
            `[ChatAgent] ⚠ AI returned ${aiResult.functionCalls.length} tool calls despite toolChoice=none (graceful exit) — ignoring tools, treating as text`
          );
          if (aiResult.text) {
            const reply = cleanFinalAnswer(aiResult.text);
            const totalDuration = Date.now() - execStartTime;
            reasoning.afterRound();
            this.#logger.info(
              `[ChatAgent] ✅ final answer (graceful exit, forced) — ${reply.length} chars, ${toolCalls.length} tool calls, ${totalDuration}ms`
            );
            return {
              reply,
              toolCalls,
              hasContext: toolCalls.length > 0,
              reasoningTrace: reasoning.trace,
              reasoningQuality: reasoning.getQualityMetrics(),
            };
          }
          // 无文本时继续循环，下一轮硬上限兜底
          continue;
        }

        // 限制单次工具调用数量（防上下文溢出）
        const MAX_TOOL_CALLS_PER_ITER = 8;
        let activeCalls = aiResult.functionCalls;
        if (activeCalls.length > MAX_TOOL_CALLS_PER_ITER) {
          this.#logger.warn(
            `[ChatAgent] ⚠ ${activeCalls.length} tool calls, capping to ${MAX_TOOL_CALLS_PER_ITER}`
          );
          activeCalls = activeCalls.slice(0, MAX_TOOL_CALLS_PER_ITER);
        }

        // ContextWindow: 原子追加 assistant + tool results
        ctx.appendAssistantWithToolCalls(aiResult.text || null, activeCalls);

        let roundSubmitCount = 0;
        let roundHasNewInfo = false; // 本轮是否获取到新信息

        for (const fc of activeCalls) {
          const toolStartTime = Date.now();
          this.#logger.info(
            `[ChatAgent] 🔧 ${fc.name}(${JSON.stringify(fc.args).substring(0, 100)})`
          );

          // SSE: 推送工具调用开始
          onProgress?.({
            type: 'tool:start',
            id: `tc_${fc.name}_${Date.now()}`,
            tool: fc.name,
            args: fc.args,
          });

          let toolResult;
          let cacheHit = false;

          // v4.0: ToolResultCache — 先检查缓存，命中则跳过实际执行
          if (toolResultCache) {
            const cached = toolResultCache.get(fc.name, fc.args);
            if (cached !== null) {
              toolResult = cached;
              cacheHit = true;
              this.#logger.info(`[ChatAgent] 🔧 CACHE HIT: ${fc.name} → skipped execution`);
            }
          }

          if (!cacheHit) {
            try {
              toolResult = await this.#toolRegistry.execute(
                fc.name,
                fc.args,
                this.#getToolContext({
                  _sessionToolCalls: toolCalls,
                  _dimensionMeta: dimensionMeta,
                  _submittedTitles: submittedTitles,
                  _submittedPatterns: this.#globalSubmittedPatterns,
                  _sharedState: sharedState,
                  _projectLanguage: projectLanguage,
                  // v4.0: Agent Memory
                  _workingMemory: workingMemory || null,
                  _episodicMemory: episodicMemory || null,
                  _toolResultCache: toolResultCache || null,
                  _currentRound: iterationCount,
                })
              );
              const toolDuration = Date.now() - toolStartTime;
              const resultSize =
                typeof toolResult === 'string'
                  ? toolResult.length
                  : JSON.stringify(toolResult).length;
              this.#logger.info(
                `[ChatAgent] 🔧 done: ${fc.name} → ${resultSize} chars in ${toolDuration}ms`
              );

              // SSE: 推送工具调用完成
              onProgress?.({
                type: 'tool:end',
                tool: fc.name,
                status: 'ok',
                resultSize,
                duration: toolDuration,
              });
            } catch (toolErr) {
              this.#logger.warn(`[ChatAgent] 🔧 FAILED: ${fc.name} — ${toolErr.message}`);
              toolResult = { error: `tool "${fc.name}" failed: ${toolErr.message}` };

              // SSE: 推送工具调用失败
              onProgress?.({
                type: 'tool:end',
                tool: fc.name,
                status: 'error',
                error: toolErr.message,
                duration: Date.now() - toolStartTime,
              });
            }
          }

          // v4.0: WorkingMemory — 记录工具观察
          if (workingMemory && fc.name !== 'note_finding') {
            workingMemory.observe(fc.name, toolResult, iterationCount);
          }

          // v4.0: ToolResultCache — 缓存搜索/读文件结果 (仅非缓存命中时写入)
          if (toolResultCache && !cacheHit) {
            toolResultCache.set(fc.name, fc.args, toolResult);
          }

          // 记录到全局 toolCalls
          const summarized = this.#summarizeResult(toolResult);
          toolCalls.push({ tool: fc.name, params: fc.args, result: summarized });

          // ── ReasoningLayer Hook 3: afterToolExec — 记录 Action + 构建 Observation ──
          reasoning.afterToolExec(fc.name, fc.args, toolResult, explorationMetrics);

          // ── 探索进度追踪 (非 PhaseRouter 路径) ──
          if (!phaseRouter && isSystem) {
            explorationMetrics.totalToolCalls++;
            let foundNewInfo = false;

            if (fc.name === 'search_project_code') {
              const pattern = fc.args?.pattern || '';
              const patterns = fc.args?.patterns || [];
              // 单模式
              if (pattern && !explorationMetrics.uniquePatterns.has(pattern)) {
                explorationMetrics.uniquePatterns.add(pattern);
                foundNewInfo = true;
              }
              // 批量模式
              for (const p of patterns) {
                if (!explorationMetrics.uniquePatterns.has(p)) {
                  explorationMetrics.uniquePatterns.add(p);
                  foundNewInfo = true;
                }
              }
              // 检查搜索结果是否有新文件
              if (toolResult && typeof toolResult === 'object') {
                const matches = toolResult.matches || [];
                const batchResults = toolResult.batchResults || {};
                for (const m of matches) {
                  if (m.file && !explorationMetrics.uniqueFiles.has(m.file)) {
                    explorationMetrics.uniqueFiles.add(m.file);
                    foundNewInfo = true;
                  }
                }
                for (const sub of Object.values(batchResults)) {
                  for (const m of sub.matches || []) {
                    if (m.file && !explorationMetrics.uniqueFiles.has(m.file)) {
                      explorationMetrics.uniqueFiles.add(m.file);
                      foundNewInfo = true;
                    }
                  }
                }
              }
            } else if (fc.name === 'read_project_file') {
              const fp = fc.args?.filePath || '';
              const fps = fc.args?.filePaths || [];
              if (fp && !explorationMetrics.uniqueFiles.has(fp)) {
                explorationMetrics.uniqueFiles.add(fp);
                foundNewInfo = true;
              }
              for (const f of fps) {
                if (!explorationMetrics.uniqueFiles.has(f)) {
                  explorationMetrics.uniqueFiles.add(f);
                  foundNewInfo = true;
                }
              }
            } else if (fc.name === 'list_project_structure') {
              // 目录结构：同一目录只算一次新信息
              const dir = fc.args?.directory || '/';
              const qKey = `list:${dir}`;
              if (!explorationMetrics.uniqueQueries.has(qKey)) {
                explorationMetrics.uniqueQueries.add(qKey);
                foundNewInfo = true;
              }
            } else if (
              fc.name === 'get_class_info' ||
              fc.name === 'get_class_hierarchy' ||
              fc.name === 'get_protocol_info' ||
              fc.name === 'get_method_overrides' ||
              fc.name === 'get_category_map'
            ) {
              // AST 结构化查询：同一类名/协议名只算一次新信息
              const queryTarget =
                fc.args?.className || fc.args?.protocolName || fc.args?.name || '';
              const qKey = `${fc.name}:${queryTarget}`;
              if (!explorationMetrics.uniqueQueries.has(qKey)) {
                explorationMetrics.uniqueQueries.add(qKey);
                foundNewInfo = true;
              }
            } else if (fc.name === 'get_project_overview') {
              // 项目概览只需调一次
              const qKey = 'overview';
              if (!explorationMetrics.uniqueQueries.has(qKey)) {
                explorationMetrics.uniqueQueries.add(qKey);
                foundNewInfo = true;
              }
            } else if (fc.name !== 'submit_knowledge' && fc.name !== 'submit_with_check') {
              // 其他未分类工具 — 首次算新信息，之后同工具名+同参数去重
              const qKey = `${fc.name}:${JSON.stringify(fc.args || {}).substring(0, 80)}`;
              if (!explorationMetrics.uniqueQueries.has(qKey)) {
                explorationMetrics.uniqueQueries.add(qKey);
                foundNewInfo = true;
              }
            }

            if (foundNewInfo) {
              explorationMetrics.staleRounds = 0;
              explorationMetrics.newInfoRounds++;
              roundHasNewInfo = true;
            }
          }

          // ── Layer 3: ToolResultLimiter — 动态配额压缩 ──
          const quota = ctx.getToolResultQuota();
          let resultStr = limitToolResult(fc.name, toolResult, quota);

          // ── 重复提交 / 维度范围校验 ──
          if (fc.name === 'submit_knowledge' || fc.name === 'submit_with_check') {
            const title = fc.args?.title || fc.args?.category || '';
            const isRejected = typeof toolResult === 'object' && toolResult?.status === 'rejected';
            const isError =
              typeof toolResult === 'object' &&
              (toolResult?.error || toolResult?.status === 'error');

            if (isRejected) {
              this.#logger.info(`[ChatAgent] 🚫 off-topic rejected: "${title}"`);
            } else if (isError) {
              // 候选创建失败（如 validation error）— 不加入 submittedTitles，允许 AI 重试
              this.#logger.info(
                `[ChatAgent] ⚠ submit error: "${title}" — ${toolResult.error || 'unknown'}`
              );
            } else if (submittedTitles.has(title.toLowerCase().trim())) {
              resultStr = `⚠ 重复提交: "${title}" 已存在。`;
              this.#logger.info(`[ChatAgent] 🔁 duplicate: "${title}"`);
            } else {
              submittedTitles.add(title.toLowerCase().trim());
              this.#globalSubmittedTitles.add(title.toLowerCase().trim());
              // 记录代码模式指纹用于跨维度去重
              const pattern = fc.args?.content?.pattern || '';
              if (pattern.length >= 30) {
                const fp = pattern
                  .replace(/\/\/[^\n]*/g, '')
                  .replace(/\/\*[\s\S]*?\*\//g, '')
                  .replace(/[\s]+/g, '')
                  .toLowerCase()
                  .slice(0, 200);
                if (fp.length >= 20) {
                  this.#globalSubmittedPatterns.add(fp);
                }
              }
              roundSubmitCount++;
            }
          }

          // ContextWindow: 追加 tool result（与 assistant 保持原子性）
          ctx.appendToolResult(fc.id, fc.name, resultStr);
        }

        // ── 探索饱和度更新 (非 PhaseRouter 路径) ──
        if (!phaseRouter && isSystem && !roundHasNewInfo) {
          explorationMetrics.staleRounds++;
        }

        // ── ReasoningLayer Hook 4: afterRound — 关闭轮次 + 写入摘要 ──
        reasoning.afterRound({
          newInfoCount: roundHasNewInfo ? 1 : 0,
          totalCalls: activeCalls.length,
          submitCount: roundSubmitCount,
          explorationMetrics,
        });

        // ── PhaseRouter 更新 ──
        if (phaseRouter) {
          const transition = phaseRouter.update({
            functionCalls: activeCalls,
            submitCount: roundSubmitCount,
            isTextOnly: false,
          });

          // ── EXPLORE→PRODUCE 阶段过渡: 注入提交引导消息 ──
          // 原生工具调用模式下，仅靠 systemPrompt 附加 hint 不够显著，
          // 需要一条 user 消息明确告知 AI 切换到提交模式
          if (transition.transitioned && transition.newPhase === 'PRODUCE') {
            ctx.appendUserNudge(
              '你已充分探索了项目代码，现在请开始调用 submit_knowledge 工具来提交你发现的知识候选。不要再搜索，直接提交。'
            );
            this.#logger.info('[ChatAgent] 📝 injected PRODUCE transition nudge');
          }

          // ── EXPLORE→SUMMARIZE / PRODUCE→SUMMARIZE 阶段过渡: 注入 digest 引导 ──
          // skill-only 维度从 EXPLORE 直接进入 SUMMARIZE (跳过 PRODUCE)，
          // 需要明确告知 AI 输出 dimensionDigest JSON
          if (transition.transitioned && transition.newPhase === 'SUMMARIZE') {
            const submitCount = toolCalls.filter(
              (tc) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check'
            ).length;
            ctx.appendUserNudge(
              `你已完成分析探索。请在回复中直接输出 dimensionDigest JSON（用 \`\`\`json 包裹），包含以下字段：\n\`\`\`json\n{"dimensionDigest":{"summary":"分析总结(100-200字)","candidateCount":${submitCount},"keyFindings":["关键发现"],"crossRefs":{},"gaps":["未覆盖方面"],"remainingTasks":[{"signal":"未处理的信号/主题","reason":"未完成原因(如:提交上限已达)","priority":"high|medium|low","searchHints":["建议搜索词"]}]}}\n\`\`\`\n> 如果所有信号都已覆盖，remainingTasks 留空数组 \`[]\`。如果有未来得及处理的信号，请在此标记，系统会在下次运行时续传。`
            );
            this.#logger.info('[ChatAgent] 📝 injected SUMMARIZE transition nudge');
          }
        }

        // SSE: 步骤结束
        onProgress?.({ type: 'step:end', step: currentIter });
        continue;
      }

      // ── 文字回答 ──
      // SSE: 文字回答意味着步骤结束
      onProgress?.({ type: 'step:end', step: currentIter });
      // 空响应重试（Gemini 偶发）
      if (!aiResult.text && isSystem && consecutiveEmptyResponses < 2) {
        consecutiveEmptyResponses++;
        this.#logger.warn(
          `[ChatAgent] ⚠ empty response from system source — retrying (${consecutiveEmptyResponses}/2)`
        );
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      // 收到非空响应时重置空响应计数器
      if (aiResult.text) {
        consecutiveEmptyResponses = 0;
      }

      // PhaseRouter: 文字回答触发阶段转换
      if (phaseRouter) {
        const transition = phaseRouter.update({
          functionCalls: null,
          submitCount: 0,
          isTextOnly: true,
        });

        // SUMMARIZE 阶段的文字回答 = 最终回答
        if (phaseRouter.phase === 'SUMMARIZE') {
          // 刚从 EXPLORE/PRODUCE 转入 SUMMARIZE 的文字回答可能不含 digest，
          // 注入 nudge 让 AI 再输出一次 digest JSON
          if (transition.transitioned) {
            ctx.appendAssistantText(aiResult.text || '');
            const submitCount = toolCalls.filter(
              (tc) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check'
            ).length;
            ctx.appendUserNudge(
              `请在回复中直接输出 dimensionDigest JSON 总结（用 \`\`\`json 包裹）：\n\`\`\`json\n{"dimensionDigest":{"summary":"分析总结","candidateCount":${submitCount},"keyFindings":["发现"],"crossRefs":{},"gaps":["缺口"],"remainingTasks":[{"signal":"未处理的信号","reason":"原因","priority":"high","searchHints":["搜索词"]}]}}\n\`\`\`\n> remainingTasks: 记录未来得及处理的信号。已全部覆盖则留空 \`[]\`。`
            );
            this.#logger.info(
              '[ChatAgent] 📝 injected SUMMARIZE nudge (text-triggered transition)'
            );
            continue;
          }
          // 已在 SUMMARIZE 阶段 — 这就是最终回答
          const reply = cleanFinalAnswer(aiResult.text || '');
          const totalDuration = Date.now() - execStartTime;
          reasoning.afterRound();
          this.#logger.info(
            `[ChatAgent] ✅ final answer — ${reply.length} chars, ${phaseRouter.totalIterations} iters, ${toolCalls.length} tool calls, ${totalDuration}ms`
          );
          return {
            reply,
            toolCalls,
            hasContext: toolCalls.length > 0,
            reasoningTrace: reasoning.trace,
            reasoningQuality: reasoning.getQualityMetrics(),
          };
        }

        if (!transition.transitioned) {
          // 在 EXPLORE/PRODUCE 阶段收到文本但未转阶段 — 可能是 AI 的中间分析
          // 注入提交引导并继续循环，而非立即返回
          if (phaseRouter.phase === 'EXPLORE' || phaseRouter.phase === 'PRODUCE') {
            ctx.appendAssistantText(aiResult.text || '');
            if (phaseRouter.phase === 'PRODUCE') {
              ctx.appendUserNudge(
                '你的分析很好。请继续调用 submit_knowledge 提交你发现的知识候选，每个值得记录的模式/实践都应该提交。'
              );
              this.#logger.info(
                '[ChatAgent] 📝 injected submit nudge (text in PRODUCE, not transitioning)'
              );
            }
            continue;
          }
          // 非生产阶段的未转换文本 = 最终回答
          const reply = cleanFinalAnswer(aiResult.text || '');
          const totalDuration = Date.now() - execStartTime;
          reasoning.afterRound();
          this.#logger.info(
            `[ChatAgent] ✅ final answer — ${reply.length} chars, ${phaseRouter.totalIterations} iters, ${toolCalls.length} tool calls, ${totalDuration}ms`
          );
          return {
            reply,
            toolCalls,
            hasContext: toolCalls.length > 0,
            reasoningTrace: reasoning.trace,
            reasoningQuality: reasoning.getQualityMetrics(),
          };
        }

        // 其他阶段的文字回答 → 继续循环（PhaseRouter 已自动转换阶段）
        ctx.appendAssistantText(aiResult.text || '');
        continue;
      }

      // 用户对话 / graceful exit: 文字回答即最终回答
      if (ctx.__gracefulExitInjected || !isSystem) {
        const reply = cleanFinalAnswer(aiResult.text || '');
        const totalDuration = Date.now() - execStartTime;
        reasoning.afterRound();
        this.#logger.info(
          `[ChatAgent] ✅ final answer (${ctx.__gracefulExitInjected ? 'graceful exit' : 'user'}) — ${reply.length} chars, ${toolCalls.length} tool calls, ${totalDuration}ms`
        );
        return {
          reply,
          toolCalls,
          hasContext: toolCalls.length > 0,
          reasoningTrace: reasoning.trace,
          reasoningQuality: reasoning.getQualityMetrics(),
        };
      }

      // system 模式非 graceful exit 的文字回答（理论上不应到这里）
      const reply = cleanFinalAnswer(aiResult.text || '');
      const totalDuration = Date.now() - execStartTime;
      reasoning.afterRound();
      this.#logger.info(
        `[ChatAgent] ✅ final answer — ${reply.length} chars, ${toolCalls.length} tool calls, ${totalDuration}ms`
      );
      return {
        reply,
        toolCalls,
        hasContext: toolCalls.length > 0,
        reasoningTrace: reasoning.trace,
        reasoningQuality: reasoning.getQualityMetrics(),
      };
    }

    // ── 循环退出: 产出 dimensionDigest 总结 ──
    reasoning.afterRound();
    const forcedResult = await this.#produceForcedSummary({
      source,
      toolCalls,
      toolSchemas,
      ctx,
      phaseRouter,
      execStartTime,
      prompt,
    });
    forcedResult.reasoningTrace = reasoning.trace;
    forcedResult.reasoningQuality = reasoning.getQualityMetrics();
    return forcedResult;
  }

  /**
   * 强制退出后的摘要生成 — 独立方法，避免主循环代码膨胀
   * @private
   */
  async #produceForcedSummary({
    source,
    toolCalls,
    toolSchemas,
    ctx,
    phaseRouter,
    execStartTime,
    prompt,
  }) {
    const iterations = phaseRouter?.totalIterations || 0;
    const isSystem = source === 'system';
    this.#logger.info(
      `[ChatAgent] ⚠ producing forced summary (${iterations} iters, ${toolCalls.length} calls, source=${source})`
    );

    const candidateCount = toolCalls.filter(
      (tc) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check'
    ).length;

    let finalReply;

    // 如果熔断器已打开，跳过 AI 调用直接合成摘要（避免无用的失败 + 计数累积）
    const isCircuitOpen = this.#aiProvider._circuitState === 'OPEN';
    if (isCircuitOpen) {
      this.#logger.warn(
        `[ChatAgent] circuit breaker is OPEN — skipping AI summary, using synthetic ${isSystem ? 'digest' : 'summary'}`
      );
    }

    // ── 收集工具调用摘要（user / system 共用） ──
    const submitSummary = toolCalls
      .filter((tc) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check')
      .map((tc, i) => `${i + 1}. ${tc.params?.title || tc.params?.category || 'untitled'}`)
      .join('\n');

    // ── 收集工具调用上下文（user 源需要更丰富的上下文来生成自然语言总结） ──
    const toolContextSummary = isSystem ? '' : this.#buildToolContextForUserSummary(toolCalls);

    try {
      if (isCircuitOpen) {
        throw new Error('circuit open — skip to synthetic summary');
      }

      let summaryPrompt;
      let systemPrompt;

      if (isSystem) {
        // ── system 源: 输出 dimensionDigest JSON（供 Bootstrap 管线消费） ──
        summaryPrompt = `你已完成 ${iterations} 轮工具调用（共 ${toolCalls.length} 次），提交了 ${candidateCount} 个候选。
${submitSummary ? `已提交候选:\n${submitSummary}\n` : ''}
**必须**输出 dimensionDigest JSON（用 \`\`\`json 包裹）：
\`\`\`json
{
  "dimensionDigest": {
    "summary": "本维度分析总结",
    "candidateCount": ${candidateCount},
    "keyFindings": ["发现1", "发现2"],
    "crossRefs": {},
    "gaps": ["未覆盖方面"],
    "remainingTasks": [
      { "signal": "未处理信号名", "reason": "达到提交上限/时间限制", "priority": "high", "searchHints": ["搜索词"] }
    ]
  }
}
\`\`\`
> remainingTasks: 列出本次未来得及处理的信号/主题。已全部覆盖则留空 \`[]\`。`;
        systemPrompt = '直接输出 dimensionDigest JSON 总结，不要调用工具。';
      } else {
        // ── user 源: 输出人类可读的 Markdown 结构化总结（前端 AI Chat 展示） ──
        const userQuestion = prompt ? `用户的原始问题：「${prompt.slice(0, 500)}」\n\n` : '';
        summaryPrompt = `${userQuestion}你刚才通过 ${toolCalls.length} 次工具调用分析了项目代码。以下是你调用过的工具和获取到的关键信息：

${toolContextSummary}

请基于以上收集到的信息，用**清晰易读的 Markdown** 格式撰写分析总结，直接回答用户的问题。

要求：
- 使用二级/三级标题组织内容
- 要有具体的代码文件路径、类名、模式名称等细节
- 关键发现用列表项罗列
- 如果发现了架构模式或最佳实践，用简短代码块举例
- 语言自然流畅，像一份技术分析报告`;
        systemPrompt =
          '你是项目分析助手。请用纯 Markdown 格式输出结构清晰的分析总结，只输出人类可读的自然语言文档，不要输出 JSON 格式的数据。';
      }

      // 用空 messages 避免累积上下文导致 400
      const summaryResult = await this.#aiProvider.chatWithTools(summaryPrompt, {
        messages: [],
        toolSchemas,
        toolChoice: 'none',
        systemPrompt,
        temperature: isSystem ? 0.3 : 0.5,
        maxTokens: 8192,
      });
      // 累计 token 用量
      if (summaryResult.usage) {
        this.#currentTokenUsage.input += summaryResult.usage.inputTokens || 0;
        this.#currentTokenUsage.output += summaryResult.usage.outputTokens || 0;
      }
      finalReply = cleanFinalAnswer(summaryResult.text || '');
    } catch (err) {
      this.#logger.warn(`[ChatAgent] forced summary AI call failed: ${err.message}`);

      if (isSystem) {
        // ── system 源兜底: 合成 dimensionDigest JSON ──
        const titles = toolCalls
          .filter((tc) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check')
          .map((tc) => tc.params?.title || 'untitled');
        finalReply = `\`\`\`json
{
  "dimensionDigest": {
    "summary": "通过 ${toolCalls.length} 次工具调用分析了项目代码，提交了 ${candidateCount} 个候选。",
    "candidateCount": ${candidateCount},
    "keyFindings": ${JSON.stringify(titles.slice(0, 5))},
    "crossRefs": {},
    "gaps": ["AI 服务异常，部分分析未完成"]
  }
}
\`\`\``;
      } else {
        // ── user 源兜底: 合成人类可读的 Markdown 摘要 ──
        const toolNames = [...new Set(toolCalls.map((tc) => tc.tool))];
        const filesRead = toolCalls
          .filter((tc) => tc.tool === 'read_project_file')
          .flatMap((tc) => {
            if (tc.params?.filePaths) {
              return tc.params.filePaths;
            }
            if (tc.params?.filePath) {
              return [tc.params.filePath];
            }
            return [];
          })
          .slice(0, 10);
        const searches = toolCalls
          .filter((tc) => tc.tool === 'search_project_code' || tc.tool === 'semantic_search_code')
          .map((tc) => tc.params?.patterns?.[0] || tc.params?.query || tc.params?.pattern)
          .filter(Boolean)
          .slice(0, 5);

        finalReply = `## 分析总结\n\n通过 **${toolCalls.length} 次工具调用**探索了项目代码。\n\n`;
        if (searches.length > 0) {
          finalReply += `### 搜索的关键词\n${searches.map((s) => `- \`${s}\``).join('\n')}\n\n`;
        }
        if (filesRead.length > 0) {
          finalReply += `### 读取的文件\n${filesRead.map((f) => `- \`${f}\``).join('\n')}\n\n`;
        }
        finalReply += `### 使用的工具\n${toolNames.map((t) => `- ${t}`).join('\n')}\n\n`;
        finalReply += `> ⚠️ AI 服务异常，未能生成完整分析。请稍后重试或缩小分析范围。`;
      }
    }

    const totalDuration = Date.now() - execStartTime;
    this.#logger.info(
      `[ChatAgent] ✅ forced summary — ${finalReply.length} chars, ${totalDuration}ms total`
    );
    return { reply: finalReply, toolCalls, hasContext: toolCalls.length > 0 };
  }

  /**
   * 从工具调用记录中提取上下文摘要（供 user 源强制总结使用）
   * @private
   */
  #buildToolContextForUserSummary(toolCalls) {
    const sections = [];

    // 目录结构探索
    const structureCalls = toolCalls.filter((tc) => tc.tool === 'list_project_structure');
    if (structureCalls.length > 0) {
      const dirs = structureCalls.map((tc) => tc.params?.directory || '/').slice(0, 5);
      sections.push(`**目录探索**: ${dirs.map((d) => `\`${d}\``).join(', ')}`);
    }

    // 项目概况
    const overviewCalls = toolCalls.filter((tc) => tc.tool === 'get_project_overview');
    if (overviewCalls.length > 0) {
      sections.push('**项目概况**: 已获取');
    }

    // 代码搜索
    const searchCalls = toolCalls.filter(
      (tc) => tc.tool === 'search_project_code' || tc.tool === 'semantic_search_code'
    );
    if (searchCalls.length > 0) {
      const queries = searchCalls
        .map((tc) => tc.params?.patterns?.[0] || tc.params?.query || tc.params?.pattern)
        .filter(Boolean)
        .slice(0, 8);
      sections.push(
        `**代码搜索** (${searchCalls.length} 次): ${queries.map((q) => `\`${q}\``).join(', ')}`
      );
    }

    // 文件读取
    const readCalls = toolCalls.filter((tc) => tc.tool === 'read_project_file');
    if (readCalls.length > 0) {
      const files = readCalls
        .flatMap((tc) => {
          if (tc.params?.filePaths) {
            return tc.params.filePaths;
          }
          if (tc.params?.filePath) {
            return [tc.params.filePath];
          }
          return [];
        })
        .slice(0, 10);
      sections.push(
        `**文件读取** (${readCalls.length} 次): ${files.map((f) => `\`${f}\``).join(', ')}`
      );
    }

    // AST 分析
    const astCalls = toolCalls.filter((tc) =>
      [
        'get_class_hierarchy',
        'get_class_info',
        'get_protocol_info',
        'get_method_overrides',
        'get_category_map',
      ].includes(tc.tool)
    );
    if (astCalls.length > 0) {
      const entities = astCalls
        .map(
          (tc) =>
            tc.params?.className ||
            tc.params?.name ||
            tc.params?.protocolName ||
            tc.params?.rootClass
        )
        .filter(Boolean)
        .slice(0, 5);
      sections.push(
        `**AST 结构分析** (${astCalls.length} 次): ${entities.map((e) => `\`${e}\``).join(', ')}`
      );
    }

    // 知识库搜索
    const kbCalls = toolCalls.filter((tc) =>
      ['search_knowledge', 'search_recipes', 'knowledge_overview'].includes(tc.tool)
    );
    if (kbCalls.length > 0) {
      sections.push(`**知识库查询**: ${kbCalls.length} 次`);
    }

    return sections.length > 0 ? sections.join('\n') : '（工具调用记录为空）';
  }

  // ─── Text Parsing 已移除 (v5.0) ────────────────────────
  // 所有 Provider 统一走 chatWithTools() 原生函数调用路径。
  // 不支持 native tool calling 的 Provider 在基类 chatWithTools()
  // 中降级为 chat()，返回 { text, functionCalls: null }。

  /**
   * 程序化直接调用指定工具（跳过 ReAct 循环）
   * 用于: 候选提交时自动查重、定时任务等
   *
   * @param {string} toolName
   * @param {object} params
   * @returns {Promise<any>}
   */
  async executeTool(toolName, params = {}) {
    return this.#toolRegistry.execute(toolName, params, this.#getToolContext());
  }

  // ─── 对话管理 API ──────────────────────────────────────

  /**
   * 创建新对话（用于 Dashboard 前端）
   * @param {object} [opts]
   * @param {'user'|'system'} [opts.category='user']
   * @param {string} [opts.title]
   * @returns {string} conversationId
   */
  createConversation({ category = 'user', title = '' } = {}) {
    if (!this.#conversations) {
      return null;
    }
    return this.#conversations.create({ category, title });
  }

  /**
   * 获取对话列表
   * @param {object} [opts]
   * @param {'user'|'system'} [opts.category]
   * @param {number} [opts.limit=20]
   * @returns {Array}
   */
  getConversations({ category, limit = 20 } = {}) {
    if (!this.#conversations) {
      return [];
    }
    return this.#conversations.list({ category, limit });
  }

  /**
   * 获取 ConversationStore 实例（供外部使用，如 HTTP 路由）
   * @returns {ConversationStore|null}
   */
  getConversationStore() {
    return this.#conversations;
  }

  /**
   * 预定义任务流
   * 将常见多步骤操作封装为一个任务名。
   * 优先查找 DAG 管线（TaskPipeline），其次使用硬编码任务方法。
   */
  async runTask(taskName, params = {}) {
    // DAG 管线优先
    if (this.#pipelines.has(taskName)) {
      return this.runPipeline(taskName, params);
    }
    // 构建任务上下文（提供给外部任务函数）
    const taskContext = {
      executeTool: (name, p) => this.executeTool(name, p),
      aiProvider: this.#aiProvider,
      container: this.#container,
      logger: this.#logger,
    };
    // 降级到硬编码任务（复杂交互逻辑无法用 DAG 表达的场景）
    switch (taskName) {
      case 'check_and_submit':
        return taskCheckAndSubmit(taskContext, params);
      case 'discover_all_relations':
        return taskDiscoverAllRelations(taskContext, params);
      case 'full_enrich':
        return taskFullEnrich(taskContext, params);
      case 'quality_audit':
        return taskQualityAudit(taskContext, params);
      case 'guard_full_scan':
        return taskGuardFullScan(taskContext, params);
      default:
        throw new Error(`Unknown task: ${taskName}`);
    }
  }

  /**
   * 注册自定义 DAG 管线
   *
   * @param {TaskPipeline} pipeline — TaskPipeline 实例
   */
  registerPipeline(pipeline) {
    if (!(pipeline instanceof TaskPipeline)) {
      throw new Error('Expected TaskPipeline instance');
    }
    this.#pipelines.set(pipeline.id, pipeline);
    this.#logger.info(`Pipeline registered: ${pipeline.id} (${pipeline.size} steps)`);
  }

  /**
   * 执行 DAG 管线
   *
   * @param {string} pipelineId — 管线 ID
   * @param {object} [inputs={}] — 管线初始输入
   * @returns {Promise<import('./TaskPipeline.js').PipelineResult>}
   */
  async runPipeline(pipelineId, inputs = {}) {
    const pipeline = this.#pipelines.get(pipelineId);
    if (!pipeline) {
      throw new Error(`Pipeline '${pipelineId}' not found`);
    }
    const executor = (toolName, params) => this.executeTool(toolName, params);
    return pipeline.execute(executor, inputs);
  }

  /**
   * 获取已注册的管线列表
   */
  getPipelines() {
    return [...this.#pipelines.values()].map((p) => p.describe());
  }

  /**
   * 获取 Agent 能力清单（供 MCP / API 描述）
   */
  getCapabilities() {
    return {
      tools: this.#toolRegistry.getToolSchemas(),
      tasks: [
        { name: 'check_and_submit', description: '提交候选前自动查重 + 质量预评' },
        { name: 'discover_all_relations', description: '批量发现 Recipe 之间的知识图谱关系' },
        { name: 'full_enrich', description: '批量 AI 语义补全候选字段' },
        { name: 'quality_audit', description: '批量质量审计全部 Recipe，标记低分项' },
        { name: 'guard_full_scan', description: '用全部 Guard 规则扫描指定代码，生成完整报告' },
        {
          name: 'bootstrap_full_pipeline',
          description:
            '冷启动全流程 DAG: bootstrap(纯启发式) → enrich(AI结构补齐) + loadSkill(并行) → refine(AI内容润色)',
        },
      ],
      pipelines: this.getPipelines(),
    };
  }

  // ─── 内置 DAG 管线注册 ─────────────────────────────────

  /**
   * 注册内置 DAG 管线
   *
   * v6 变更:
   *   - 移除旧的 4 步 DAG (bootstrap → enrich → loadSkill → refine)
   *   - 冷启动 AI 增强现在通过 orchestrator.js 中的 ChatAgent per-dimension production 完成
   *   - 保留简化版 bootstrap_full_pipeline: 只做 Phase 1-4 启发式
   *     (Phase 5 ChatAgent 生产由 orchestrator.js 管理,不再走 DAG 编排)
   */
  #registerBuiltinPipelines() {
    // ── bootstrap_full_pipeline (v6 简化版) ──────────────────
    // 只做启发式 Phase 1-5.5 (含 ChatAgent per-dimension production)
    // 不再需要 enrich/refine 后置步骤
    this.registerPipeline(
      new TaskPipeline('bootstrap_full_pipeline', [
        {
          name: 'bootstrap',
          tool: 'bootstrap_knowledge',
          params: {
            maxFiles: (ctx) => ctx._inputs.maxFiles || 500,
            skipGuard: (ctx) => ctx._inputs.skipGuard || false,
            contentMaxLines: (ctx) => ctx._inputs.contentMaxLines || 120,
            loadSkills: true,
          },
        },
      ])
    );
  }

  // ─── Native Tool Calling 内部方法 ──────────────────────

  /**
   * 获取工具执行上下文
   * @param {object} [extras] — 额外注入到上下文的字段（如 _sessionToolCalls）
   */
  #getToolContext(extras) {
    return {
      container: this.#container,
      aiProvider: this.#aiProvider,
      projectRoot: this.#container?.singletons?._projectRoot || process.cwd(),
      logger: this.#logger,
      source: this.#currentSource,
      fileCache: this.#fileCache || null,
      lang: this.#currentLang || this.#defaultLang || 'en',
      ...extras,
    };
  }

  /**
   * 列出可用的 Skills 及其摘要（用于系统提示词）
   * 加载顺序: 内置 skills/ → 项目级 AutoSnippet/skills/（同名覆盖）
   * @returns {{ name: string, summary: string }[]}
   */
  #listAvailableSkills() {
    const skillMap = new Map();

    // 1. 内置 Skills
    this.#loadSkillsFromDir(SKILLS_DIR, skillMap);

    // 2. 项目级 Skills（覆盖同名内置 Skill）
    const projectSkillsDir = path.resolve(PROJECT_ROOT, '.autosnippet', 'skills');
    this.#loadSkillsFromDir(projectSkillsDir, skillMap);

    return Array.from(skillMap.values());
  }

  /**
   * 从目录加载 Skills 到 Map
   */
  #loadSkillsFromDir(dir, skillMap) {
    try {
      const dirs = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const name of dirs) {
        const skillPath = path.join(dir, name, 'SKILL.md');
        let summary = '';
        try {
          const raw = fs.readFileSync(skillPath, 'utf-8');
          const fmMatch = raw.match(/^---[\s\S]*?description:\s*["']?(.+?)["']?\s*$/m);
          if (fmMatch) {
            summary = fmMatch[1];
          } else {
            const lines = raw.split('\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
                summary = trimmed.length > 80 ? `${trimmed.substring(0, 80)}...` : trimmed;
                break;
              }
            }
          }
        } catch {
          /* SKILL.md not found */
        }
        skillMap.set(name, { name, summary });
      }
    } catch {
      /* directory not found */
    }
  }

  /**
   * 异步初始化 ProjectSemanticMemory (Tier 3)
   * 在构造函数中调用 (fire-and-forget)
   */
  #initSemanticMemory(container) {
    try {
      const db = container?.get?.('database');
      if (db) {
        import('./ProjectSemanticMemory.js')
          .then(({ ProjectSemanticMemory }) => {
            this.#semanticMemory = new ProjectSemanticMemory(db, { logger: this.#logger });
          })
          .catch(() => {
            /* Semantic Memory not available */
          });
      }
    } catch {
      /* container.get failed, degrade silently */
    }
  }

  /**
   * 从对话中提取值得记忆的信息写入 Memory
   *
   * 双层策略:
   *   1. 规则快速匹配（零延迟，覆盖明确的中英文模式）
   *   2. AI 驱动提取（异步后台，从 reply 中提取 [MEMORY] 标签）
   *
   * source 隔离: 标记 memory 来源，避免系统分析污染用户记忆
   */
  #extractMemory(prompt, reply) {
    if (!this.#memory && !this.#semanticMemory) {
      return;
    }
    const source = this.#currentSource || 'user';

    try {
      // ── 层 1: 规则快速匹配（中文 + 英文） ──
      const prefPatterns = [
        /我们(项目|团队)?(不用|不使用|禁止|避免|偏好|习惯|规范是)/,
        /以后(都|请|要)/,
        /记住/,
        /we\s+(don'?t|never|always|prefer|avoid)\s+use/i,
        /remember\s+(to|that)/i,
        /our\s+(convention|standard|rule)\s+is/i,
      ];
      if (prefPatterns.some((p) => p.test(prompt))) {
        const entry = {
          type: 'preference',
          content: prompt.substring(0, 200),
          source,
          ttl: 30,
        };
        this.#memory?.append(entry);
        this.#semanticMemory?.append({ ...entry, ttl: undefined });
      }

      const decisionPatterns = [
        /决定(了|用|采用|使用)/,
        /(确认|同意|通过)(了|这个方案|审核)/,
        /就(这样|这么)(做|定|办)/,
        /let'?s\s+(go\s+with|use|adopt)/i,
        /approved|confirmed|decided/i,
      ];
      if (decisionPatterns.some((p) => p.test(prompt))) {
        const entry = {
          type: 'decision',
          content: prompt.substring(0, 200),
          source,
          ttl: 60,
        };
        this.#memory?.append(entry);
        this.#semanticMemory?.append({ ...entry, ttl: undefined });
      }

      // ── 层 2: 从 AI reply 中提取 [MEMORY] 标签 ──
      // AI 可在回复中嵌入: [MEMORY:preference] 内容 [/MEMORY]
      if (reply) {
        const memoryTagRegex = /\[MEMORY:(\w+)\]\s*([\s\S]*?)\s*\[\/MEMORY\]/g;
        let match;
        while ((match = memoryTagRegex.exec(reply)) !== null) {
          const type = match[1]; // preference | decision | context
          const content = match[2].trim();
          if (content && ['preference', 'decision', 'context'].includes(type)) {
            const entry = {
              type,
              content: content.substring(0, 200),
              source,
              ttl: type === 'context' ? 90 : type === 'decision' ? 60 : 30,
            };
            this.#memory?.append(entry);
            this.#semanticMemory?.append({ ...entry, ttl: undefined });
          }
        }
      }
    } catch {
      /* memory write failure is non-critical */
    }
  }

  /**
   * 自动压缩过长的对话（异步后台执行）
   * 当对话消息数超过 12 条时触发 AI 摘要压缩
   */
  async #autoSummarize(conversationId) {
    if (!this.#conversations || !this.#aiProvider) {
      return;
    }
    try {
      const messages = this.#conversations.load(conversationId, { tokenBudget: Infinity });
      if (messages.length >= 12) {
        await this.#conversations.summarize(conversationId, {
          aiProvider: this.#aiProvider,
        });
      }
    } catch {
      // 摘要失败不影响主流程
    }
  }

  /**
   * 事件驱动入口（P2 预留接口）
   * @param {{ type: string, payload: object, source?: string }} event
   */
  async executeEvent(event) {
    const { type, payload } = event;
    const prompt = this.#eventToPrompt(type, payload);
    return this.execute(prompt, { history: [], source: 'system' });
  }

  #eventToPrompt(type, payload) {
    switch (type) {
      case 'file_saved':
        return `文件 ${payload.filePath} 刚被保存，变更了 ${payload.changedLines} 行。请分析是否有值得提取为 Recipe 的代码模式。如果有，说明原因；没有就说"无需操作"。`;
      case 'candidate_backlog':
        return `当前有 ${payload.count} 条候选积压（最早 ${payload.oldest}）。请按质量分类：哪些值得审核、哪些可以直接拒绝、哪些需要补充信息。`;
      case 'scheduled_health':
        return `请执行知识库健康检查：Recipe 覆盖率、过时标记、Guard 规则有效性。给出简要报告。`;
      default:
        return `事件: ${type}\n${JSON.stringify(payload)}`;
    }
  }

  /**
   * 截断长文本
   */
  #truncate(text, maxLen = 4000) {
    if (!text || text.length <= maxLen) {
      return text;
    }
    return `${text.substring(0, maxLen)}\n...(truncated, ${text.length - maxLen} chars omitted)`;
  }

  /**
   * 精简工具结果（避免过长的 observation）
   */
  #summarizeResult(result) {
    if (!result) {
      return null;
    }
    const str = typeof result === 'string' ? result : JSON.stringify(result);
    if (str.length <= 500) {
      return result;
    }
    // 返回截断版
    if (typeof result === 'object') {
      if (Array.isArray(result)) {
        return { _summary: `Array with ${result.length} items`, first3: result.slice(0, 3) };
      }
      // 保留 key 结构
      const keys = Object.keys(result);
      const summary = {};
      for (const k of keys) {
        const v = result[k];
        if (typeof v === 'string' && v.length > 200) {
          summary[k] = `${v.substring(0, 200)}...`;
        } else if (Array.isArray(v)) {
          summary[k] = { _count: v.length, first2: v.slice(0, 2) };
        } else {
          summary[k] = v;
        }
      }
      return summary;
    }
    return str.substring(0, 500);
  }
}

export default ChatAgent;

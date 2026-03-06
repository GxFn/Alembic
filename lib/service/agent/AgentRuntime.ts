/**
 * AgentRuntime — 统一 Agent 执行引擎 (The Brain)
 *
 * 核心思想: 不存在类型分野，只有 ONE Runtime。
 * 只有 ONE Runtime，由 Capability + Strategy + Policy 配置驱动。
 *
 * AgentRuntime 是:
 *   - ReAct 循环的宿主 (Thought → Action → Observation)
 *   - Capability 的组合容器 (加载哪些技能)
 *   - Policy 的执行者 (遵守哪些约束)
 *   - Strategy 的被委托者 (Strategy 调用 runtime.reactLoop())
 *
 * 认知架构 (CoALA):
 *   Perception → Working Memory → Reasoning → Action → Reflection
 *   │             │                │           │         │
 *   AgentMessage   history+memory   LLM call    Tools    Policy.validateAfter
 *
 * 引擎级能力:
 *   - ContextWindow: 三级递进压缩，动态 token 预算 (可选注入)
 *   - ExplorationTracker: 阶段状态机 + 信号收集 + Nudge + Graceful exit (可选注入)
 *   - AI 错误恢复: consecutiveAiErrors 2-strike → context reset → forced summary
 *   - 空响应重试: consecutiveEmptyResponses + rollback (system 场景)
 *   - 熔断器感知: _circuitState === 'OPEN' → 直接合成摘要
 *   - 工具调用数量限制: MAX_TOOL_CALLS_PER_ITER = 8
 *   - 提交去重: submittedTitles / submittedPatterns
 *   - cleanFinalAnswer: 去除 nudge 噪声
 *
 * @module AgentRuntime
 */

import { randomUUID } from 'node:crypto';
import Logger from '../../infrastructure/logging/Logger.js';
import { AgentEventBus, AgentEvents } from './AgentEventBus.js';
import { AgentState } from './AgentState.js';
import { Capability, CapabilityRegistry } from './capabilities.js';
import { cleanFinalAnswer } from './core/ChatAgentPrompts.js';
import { continueResult, LLMResultType } from './core/LLMResultType.js';
import { LoopContext } from './core/LoopContext.js';
import { createMessageAdapter } from './core/MessageAdapter.js';
import { SystemPromptBuilder } from './core/SystemPromptBuilder.js';
import { createToolPipeline } from './core/ToolExecutionPipeline.js';
import { produceForcedSummary } from './forced-summary.js';
import { PolicyEngine } from './policies.js';

/** 单次迭代允许的最大工具调用数 */
const MAX_TOOL_CALLS_PER_ITER = 8;

/**
 * @typedef {Object} RuntimeConfig
 * @property {string} [id] 运行时唯一 ID
 * @property {string} [presetName] 使用的 Preset 名称 (仅标识)
 * @property {import('../../external/ai/AiProvider.js').AiProvider} aiProvider - LLM 提供商
 * @property {import('./tools/ToolRegistry.js').ToolRegistry} toolRegistry 工具注册表
 * @property {Object} [container] - DI 容器
 * @property {Capability[]} capabilities 已实例化的 Capability 列表
 * @property {import('./strategies.js').Strategy} strategy 执行策略
 * @property {PolicyEngine} policies 策略引擎
 * @property {Object} [persona] 人格配置
 * @property {Object} [memory] 记忆配置
 * @property {Function} [onProgress] 进度回调
 * @property {Function} [onToolCall] 工具调用通知钩子 (name, args, result, iteration)
 * @property {string} [lang] 语言偏好
 * @property {string} [projectRoot] 项目根目录 (传入工具上下文)
 */

export class AgentRuntime {
  onToolCall: any;
  /** @type {string} */
  id;
  /** @type {string} */
  presetName;
  /** @type {AgentState} */
  state;
  /** @type {AgentEventBus} */
  bus;
  /** @type {import('../../external/ai/AiProvider.js').AiProvider} */
  aiProvider;
  /** @type {import('./tools/ToolRegistry.js').ToolRegistry} */
  toolRegistry;
  /** @type {Object} */
  container;
  /** @type {Capability[]} */
  capabilities;
  /** @type {import('./strategies.js').Strategy} */
  strategy;
  /** @type {PolicyEngine} */
  policies;
  /** @type {Object} */
  persona;
  /** @type {Object} */
  memoryConfig;
  /** @type {Function|null} */
  onProgress;
  /** @type {string|null} */
  lang;
  /** @type {import('winston').Logger} */
  logger;
  /** @type {string} */
  #projectRoot;
  /** @type {Array|null} 文件缓存 (bootstrap 场景注入) */
  #fileCache = null;
  /** @type {string[]} 额外工具白名单 (调用方按需注入，不经 Capability) */
  #additionalTools: any[] = [];
  /** @type {import('./core/ToolExecutionPipeline.js').ToolExecutionPipeline} */
  #toolPipeline;
  /** @type {SystemPromptBuilder} */
  #promptBuilder;

  // ── 执行统计 ──
  iterationCount = 0;
  toolCallHistory: any[] = [];
  tokenUsage = { input: 0, output: 0 };
  startTime = 0;

  /**
   * @param {RuntimeConfig} config
   */
  constructor(config: any) {
    this.id = config.id || `runtime_${randomUUID().slice(0, 8)}`;
    this.presetName = config.presetName || 'custom';
    this.aiProvider = config.aiProvider;
    this.toolRegistry = config.toolRegistry;
    this.container = config.container || null;
    this.capabilities = config.capabilities || [];
    this.strategy = config.strategy;
    this.policies = config.policies || new PolicyEngine([]);
    this.persona = config.persona || {};
    this.memoryConfig = config.memory || {};
    this.onProgress = config.onProgress || null;
    this.onToolCall = config.onToolCall || null;
    this.lang = config.lang || null;
    this.logger = Logger.getInstance();
    this.bus = AgentEventBus.getInstance();
    this.#projectRoot = config.projectRoot || process.cwd();
    this.#additionalTools = config.additionalTools || [];
    this.#toolPipeline = createToolPipeline();
    this.#promptBuilder = new SystemPromptBuilder({
      persona: this.persona,
      fileCache: this.#fileCache,
      lang: this.lang,
      memoryConfig: this.memoryConfig,
    });

    this.state = new AgentState({
      initialData: { runtimeId: this.id, preset: this.presetName },
    });

    this.bus.publish(
      AgentEvents.AGENT_CREATED,
      {
        agentId: this.id,
        preset: this.presetName,
        capabilities: this.capabilities.map((c: any) => c.name),
        strategy: this.strategy?.name,
      },
      { source: this.id }
    );
  }

  // ─── 公共 API ─────────────────────────────────

  /**
   * 执行 Agent — 入口
   *
   * @param {import('./AgentMessage.js').AgentMessage} message 统一消息
   * @param {Object} [opts] 策略特定选项 (如 FanOut 的 items)
   * @returns {Promise<AgentResult>}
   *
   * @typedef {Object} AgentResult
   * @property {string} reply 最终文本回复
   * @property {Array} toolCalls 工具调用记录
   * @property {Object} tokenUsage - Token 用量
   * @property {number} iterations 循环次数
   * @property {number} durationMs 执行耗时
   * @property {Object} [phases] - Pipeline/FanOut 阶段详情
   * @property {Object} state 状态快照
   */
  async execute(message: any, opts: any = {}) {
    this.startTime = Date.now();
    this.iterationCount = 0;
    this.toolCallHistory = [];
    this.tokenUsage = { input: 0, output: 0 };

    // ── Policy: 执行前校验 ──
    const beforeCheck = this.policies.validateBefore({ message, capabilities: this.capabilities });
    if (!beforeCheck.ok) {
      this.logger.warn(`[AgentRuntime] Policy rejected: ${beforeCheck.reason}`);
      return {
        reply: `⚠️ ${beforeCheck.reason}`,
        toolCalls: [],
        tokenUsage: { input: 0, output: 0 },
        iterations: 0,
        durationMs: 0,
        state: this.state.toJSON(),
      };
    }

    // ── 超时保护 ──
    const budget = this.policies.getBudget();
    const timeoutMs = budget?.timeoutMs || 300_000;

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Agent timeout after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    try {
      // ── 委托给 Strategy ──
      const resultPromise = this.strategy.execute(this, message, opts);
      const result = await Promise.race([resultPromise, timeoutPromise]);
      clearTimeout(timeoutId);

      // ── Policy: 执行后校验 ──
      const afterCheck = this.policies.validateAfter(result);
      if (!afterCheck.ok) {
        this.logger.warn(`[AgentRuntime] Quality check: ${afterCheck.reason}`);
        result.qualityWarning = afterCheck.reason;
      }

      // 状态完成
      this.#safeTransition('finish', { reply: result.reply?.slice(0, 100) });

      // 回复给原始渠道
      if (message.replyFn && result.reply) {
        await message.reply(result.reply);
      }

      result.state = this.state.toJSON();
      result.durationMs = Date.now() - this.startTime;

      this.bus.publish(
        AgentEvents.AGENT_COMPLETED,
        {
          agentId: this.id,
          preset: this.presetName,
          iterations: result.iterations,
          durationMs: result.durationMs,
        },
        { source: this.id }
      );

      return result;
    } catch (err: any) {
      clearTimeout(timeoutId);
      this.state.send('error', { error: err.message });
      this.bus.publish(
        AgentEvents.AGENT_FAILED,
        {
          agentId: this.id,
          error: err.message,
        },
        { source: this.id }
      );
      throw err;
    }
  }

  // ─── ReAct Loop — 供 Strategy 调用 ──────────

  /**
   * 核心 ReAct 循环。Strategy 调用此方法执行实际的 LLM + Tool 交互。
   *
   * 引擎级能力通过可选参数注入:
   *   - contextWindow → 三级递进压缩 + 动态工具结果限额
   *   - tracker → ExplorationTracker 阶段管理 + Nudge + Graceful exit
   *   - trace → ActiveContext 推理链记录
   *   - memoryCoordinator → 缓存/动态提示/观察记录
   *   - sharedState → 提交去重 { submittedTitles, submittedPatterns }
   *   - source → 'user' | 'system' (影响错误恢复 + 强制摘要行为)
   *
   * 向后兼容: 以上参数均为可选。不提供时退化为原始裸循环。
   *
   * @param {string} prompt 用户/系统提示
   * @param {Object} [opts]
   * @param {Array} [opts.history] 对话历史
   * @param {Object} [opts.context] 额外上下文
   * @param {string[]} [opts.capabilityOverride] 临时覆盖 capability (Pipeline 阶段用)
   * @param {Object} [opts.budgetOverride] 临时覆盖 budget
   * @param {string} [opts.systemPromptOverride] 完全覆盖系统提示词 (Bootstrap 阶段专用)
   * @param {Function} [opts.onToolCall] 本轮独立的工具调用钩子，优先于 runtime 级
   * @param {import('./context/ContextWindow.js').ContextWindow} [opts.contextWindow] 上下文窗口管理器
   * @param {Object} [opts.tracker] - ExplorationTracker 实例
   * @param {Object} [opts.trace] - ActiveContext 实例
   * @param {Object} [opts.memoryCoordinator] - MemoryCoordinator 实例
   * @param {Object} [opts.sharedState] 共享状态 { submittedTitles, submittedPatterns }
   * @param {string} [opts.source] - 'user' | 'system'
   * @param {string} [opts.toolChoiceOverride] 首轮 toolChoice 覆盖 ('required'/'auto'/'none')
   *   首轮强制 LLM 生成 tool call（LLM 自行决定调哪个工具、传什么参数）。
   *   这不是替 LLM 做决定，而是告诉 LLM "你必须调用某个工具"。
   *   仅在第一轮生效，后续轮次恢复正常 toolChoice 逻辑。
   * @returns {Promise<AgentResult>}
   */
  async reactLoop(prompt: any, opts: any = {}) {
    const ctx = this.#initLoop(prompt, opts);

    // ─── ReAct 主循环 (编排骨架) ─────
    while (true) {
      ctx.iteration++;
      this.iterationCount++;

      // ActiveContext: 开始新轮次 (必须在 #shouldExit 前, 保证 endRound 有配对)
      ctx.trace?.startRound(ctx.iteration);

      // 退出判定 (tracker + policy)
      if (this.#shouldExit(ctx)) {
        break;
      }

      // 迭代准备 (hooks + nudge + compact + toolChoice + prompt)
      const { toolChoice, effectiveSystemPrompt, effectivePrompt } = this.#prepareIteration(ctx);

      // LLM 调用 (含错误恢复 + 空响应重试)
      const llmResult = await this.#callLLM(
        ctx,
        toolChoice,
        effectiveSystemPrompt,
        effectivePrompt
      );
      if (!llmResult) {
        break;
      }
      if (llmResult.type === LLMResultType.CONTINUE) {
        continue;
      }

      // ActiveContext: 记录 AI 的推理文本 + 提取/更新计划
      if (ctx.trace && llmResult.text) {
        ctx.trace.setThought(llmResult.text);
        ctx.trace.extractAndSetPlan?.(llmResult.text, ctx.iteration);
      }

      // 分支: 有 Tool Call
      if (llmResult.functionCalls?.length > 0) {
        const exitAfterTools = await this.#processToolCalls(ctx, llmResult, effectiveSystemPrompt);
        if (exitAfterTools) {
          break;
        }
        continue;
      }

      // 分支: 纯文本回复
      if (this.#processTextResponse(ctx, llmResult)) {
        break;
      }
    }

    return this.#finalize(ctx);
  }

  // ─── 提取方法: reactLoop 内部阶段 ────────────

  /**
   * 初始化循环上下文 — 封装 reactLoop 前 ~60 行初始化逻辑
   * @param {string} prompt
   * @param {Object} opts
   * @returns {LoopContext}
   */
  #initLoop(prompt: any, opts: any) {
    const {
      history = [],
      context = {},
      capabilityOverride,
      budgetOverride,
      systemPromptOverride,
      onToolCall,
      contextWindow,
      tracker,
      trace,
      memoryCoordinator,
      sharedState,
      source,
      toolChoiceOverride,
    } = opts;

    // 解析 capabilities
    const caps = capabilityOverride
      ? this.#resolveCapabilities(capabilityOverride)
      : this.capabilities;

    // 构建基础系统提示词 (委托 SystemPromptBuilder)
    let baseSystemPrompt = systemPromptOverride || this.#promptBuilder.build(caps, context);

    // 收集工具 (caps 为空数组时 = 明确无工具)
    const allowedTools = this.#collectTools(caps);
    const noToolsExplicit = Array.isArray(capabilityOverride) && capabilityOverride.length === 0;
    const toolSchemas = noToolsExplicit
      ? []
      : this.toolRegistry.getToolSchemas(allowedTools.length > 0 ? allowedTools : null);

    // 创建统一消息适配器 (消除 useCtxWin 双模式)
    const messages = createMessageAdapter(contextWindow);

    // 加载历史 + 用户 prompt
    for (const h of history) {
      if (h.role === 'assistant') {
        messages.appendAssistantText(h.content);
      } else {
        messages.appendUserMessage(h.content);
      }
    }
    messages.appendUserMessage(prompt);

    // 预算
    const budget = budgetOverride ||
      this.policies.getBudget() || {
        maxIterations: 20,
        maxTokens: 4096,
        temperature: 0.7,
      };

    // 系统源: 注入轮次预算 (委托 SystemPromptBuilder)
    baseSystemPrompt = SystemPromptBuilder.injectBudget(baseSystemPrompt, {
      source,
      tracker,
      budget,
    });

    // 状态转移
    this.#safeTransition('start', { prompt: prompt.slice(0, 100) });
    this.#safeTransition('plan_ready');

    this.bus.publish(
      AgentEvents.AGENT_STARTED,
      {
        agentId: this.id,
        prompt: prompt.slice(0, 100),
        capabilities: caps.map((c: any) => c.name),
      },
      { source: this.id }
    );

    return new LoopContext({
      messages,
      tracker: tracker || null,
      trace: trace || null,
      memoryCoordinator: memoryCoordinator || null,
      sharedState: sharedState || null,
      source: source || 'user',
      budget,
      capabilities: caps,
      baseSystemPrompt,
      toolSchemas,
      prompt,
      onToolCall: onToolCall || null,
      context: context || {},
      contextWindow: contextWindow || null,
      toolChoiceOverride: toolChoiceOverride || null,
    });
  }

  /**
   * 退出判定 — 合并 tracker/policy 退出检查
   * @param {LoopContext} ctx
   * @returns {boolean} true = 应退出循环
   */
  #shouldExit(ctx: any) {
    // ExplorationTracker: tick + 退出检查
    if (ctx.tracker) {
      ctx.tracker.tick();
      if (ctx.tracker.shouldExit()) {
        this.logger.info(
          `[AgentRuntime] tracker exit: phase=${ctx.tracker.phase}, iter=${ctx.tracker.iteration}, submits=${ctx.tracker.totalSubmits}`
        );
        return true;
      }
    }

    // Capability 前置钩子
    for (const cap of ctx.capabilities) {
      cap.onBeforeStep({
        iteration: ctx.iteration,
        messages: ctx.messages.toMessages(),
        prompt: ctx.prompt,
      });
    }

    // ── Per-stage budget timeout (从 budgetOverride 注入) ──
    // 与 BudgetPolicy 的全局 timeoutMs (600s) 不同，此处使用阶段级 budget.timeoutMs
    // 保证 Analyst/Producer 各自有独立的超时边界，避免一个阶段消耗完所有时长
    if (ctx.budget?.timeoutMs && Date.now() - ctx.loopStartTime > ctx.budget.timeoutMs) {
      this.logger.info(
        `[AgentRuntime] ⏰ Stage budget timeout: ${ctx.budget.timeoutMs}ms exceeded (elapsed: ${Date.now() - ctx.loopStartTime}ms)`
      );
      return true;
    }

    // Policy 实时校验
    // 当 ExplorationTracker 存在时，由 tracker 自己管理 maxIterations + grace 轮次，
    // 跳过 BudgetPolicy 的 iteration 限制，避免竞争（tracker 给了 grace 但 policy 立即杀掉循环）。
    // tracker 内部有硬上限 (maxIterations + 2) 保证不会无限循环。
    const skipPolicyIterCheck = !!ctx.tracker;
    const duringCheck = this.policies.validateDuring({
      iteration: skipPolicyIterCheck ? 0 : ctx.iteration, // tracker 模式下用 0 绕过 iteration 检查
      toolCalls: this.toolCallHistory,
      tokenUsage: this.tokenUsage,
      startTime: ctx.loopStartTime,
    });
    if (!duringCheck.ok) {
      this.logger.info(`[AgentRuntime] Policy stop: ${duringCheck.reason}`);
      return true;
    }

    return false;
  }

  /**
   * 迭代准备 — 合并 nudge/压缩/提示词增强/toolChoice
   * @param {LoopContext} ctx
   * @returns {{ toolChoice: string, effectiveSystemPrompt: string, effectivePrompt: string }}
   */
  #prepareIteration(ctx: any) {
    const { tracker, trace, capabilities: _capabilities, messages, prompt } = ctx;
    const maxIterations = ctx.maxIterations;

    this.#emitProgress('thinking', { iteration: ctx.iteration, maxIterations });

    // Nudge 注入 (ExplorationTracker)
    if (tracker) {
      const nudge = tracker.getNudge(trace);
      if (nudge) {
        messages.appendUserNudge(nudge.text);
        this.logger.info(`[AgentRuntime] 💬 injected ${nudge.type} nudge at iter ${ctx.iteration}`);
        const _dim = ctx.sharedState?._dimensionMeta?.id || '';
      }
    }

    // 压缩检查
    const compactResult = messages.compactIfNeeded();
    if (compactResult.level > 0) {
      this.logger.info(
        `[AgentRuntime] context compacted: L${compactResult.level}, removed ${compactResult.removed} items`
      );
    }

    // 动态 toolChoice
    const forceSummaryAt = Math.max(2, Math.ceil(maxIterations * 0.8));
    const forceSummary = !tracker && ctx.iteration >= forceSummaryAt;
    let toolChoice;
    if (ctx.toolChoiceOverride && ctx.iteration === 1) {
      // 首轮 toolChoice 覆盖: 强制 LLM 生成 tool call (LLM 自行决定调哪个、传什么)
      toolChoice = ctx.toolChoiceOverride;
    } else if (tracker) {
      toolChoice = tracker.getToolChoice();
    } else {
      toolChoice = ctx.toolSchemas.length > 0 ? (forceSummary ? 'none' : 'auto') : 'none';
    }

    // 系统提示词增强 (阶段上下文 + 动态记忆)
    let effectiveSystemPrompt = ctx.baseSystemPrompt;
    if (tracker) {
      effectiveSystemPrompt += tracker.getPhaseContext();
    } else if (ctx.isSystem && !tracker) {
      const remaining = maxIterations - ctx.iteration;
      effectiveSystemPrompt += `\n\n## 当前进度\n第 ${ctx.iteration}/${maxIterations} 轮 | 剩余 ${remaining} 轮`;
    }
    if (ctx.isSystem && ctx.memoryCoordinator) {
      const wmContext = ctx.memoryCoordinator.buildDynamicMemoryPrompt?.({
        mode: ctx.source || 'analyst',
        scopeId: ctx.context?.dimensionScopeId || null,
      });
      if (wmContext) {
        effectiveSystemPrompt += `\n\n${wmContext}`;
      }
    }

    // 非 tracker 模式的强制摘要提示注入
    const effectivePrompt = forceSummary
      ? `${prompt}\n\n[系统提示] 已进入最后阶段，请停止调用工具，基于已有信息输出总结。`
      : prompt;

    return { toolChoice, effectiveSystemPrompt, effectivePrompt };
  }

  /**
   * LLM 调用 — 含错误恢复 + 空响应重试
   *
   * @param {LoopContext} ctx
   * @param {string} toolChoice
   * @param {string} effectiveSystemPrompt
   * @param {string} effectivePrompt
   * @returns {Promise<Object|null>} llmResult 或 null (表示应退出)
   */
  async #callLLM(ctx: any, toolChoice: any, effectiveSystemPrompt: any, effectivePrompt: any) {
    this.bus.publish(
      AgentEvents.LLM_CALL_START,
      {
        agentId: this.id,
        iteration: ctx.iteration,
      },
      { source: this.id }
    );

    let llmResult;
    try {
      // toolChoice='none' 时不发送 toolSchemas —— 部分 LLM (Gemini) 在看到
      // 工具定义但被禁止调用时会返回空内容，导致 SUMMARIZE 阶段失败
      const effectiveToolSchemas =
        toolChoice === 'none'
          ? undefined
          : ctx.toolSchemas.length > 0
            ? ctx.toolSchemas
            : undefined;
      llmResult = await this.aiProvider.chatWithTools(effectivePrompt, {
        messages: ctx.messages.toMessages(),
        toolSchemas: effectiveToolSchemas,
        toolChoice: effectiveToolSchemas ? toolChoice : undefined,
        systemPrompt: effectiveSystemPrompt,
        temperature: ctx.budget.temperature ?? (ctx.isSystem ? 0.3 : 0.7),
        maxTokens: ctx.budget.maxTokens ?? (ctx.isSystem ? 8192 : 4096),
      });
      ctx.consecutiveAiErrors = 0;
    } catch (aiErr: any) {
      return this.#handleAiError(ctx, aiErr);
    }

    // 累计 Token (runtime 级 + loop 级)
    if (llmResult.usage) {
      this.tokenUsage.input += llmResult.usage.inputTokens || 0;
      this.tokenUsage.output += llmResult.usage.outputTokens || 0;
      ctx.addTokenUsage(llmResult.usage);
    }

    this.bus.publish(
      AgentEvents.LLM_CALL_END,
      {
        agentId: this.id,
        hasToolCalls: !!llmResult.functionCalls?.length,
        hasText: !!llmResult.text,
        usage: llmResult.usage,
      },
      { source: this.id }
    );

    // 空响应重试
    if (!llmResult.text && !llmResult.functionCalls?.length) {
      // B4 fix: SUMMARIZE 阶段也允许重试 — force_exit nudge 刚注入时 LLM 可能
      // 需要额外一轮才能生成有效输出。与 ExplorationTracker 的 2 轮 grace 对齐，
      // 避免 grace 机制被架空。重试次数由 tracker.phaseRounds 控制而非独立计数。
      const isTerminal = ctx.tracker && ctx.tracker.phase === 'SUMMARIZE';
      if (isTerminal) {
        const phaseRounds = ctx.tracker.metrics?.phaseRounds ?? 0;
        if (phaseRounds < 2) {
          ctx.consecutiveEmptyResponses++;
          this.logger.warn(
            `[AgentRuntime] ⚠ empty response in SUMMARIZE — retrying (grace ${phaseRounds + 1}/2)`
          );
          // 不 rollbackTick: 让 tracker 计入 phaseRounds 以便到达 grace 上限退出
          await new Promise((r) => setTimeout(r, 1500));
          return continueResult();
        }
        this.logger.warn(
          '[AgentRuntime] ⚠ empty response in SUMMARIZE (grace exhausted) — proceeding to forced summary'
        );
        return null;
      }
      if (ctx.isSystem && ctx.consecutiveEmptyResponses < 2) {
        ctx.consecutiveEmptyResponses++;
        this.logger.warn(
          `[AgentRuntime] ⚠ empty response — retrying (${ctx.consecutiveEmptyResponses}/2)`
        );
        ctx.tracker?.rollbackTick?.();
        await new Promise((r) => setTimeout(r, 1500));
        // 返回 CONTINUE 信号 — 调用方需重走循环
        return continueResult();
      }
      return null; // 退出
    }
    if (llmResult.text || llmResult.functionCalls?.length) {
      ctx.consecutiveEmptyResponses = 0;
    }

    // Graceful exit 保护
    if (ctx.tracker?.isGracefulExit && llmResult.functionCalls?.length > 0) {
      this.logger.warn(
        `[AgentRuntime] ⚠ AI returned ${llmResult.functionCalls.length} tool calls despite toolChoice=none (graceful exit) — ignoring`
      );
      if (llmResult.text) {
        ctx.lastReply = cleanFinalAnswer(llmResult.text);
        return null; // 退出
      }
      return continueResult();
    }

    return llmResult;
  }

  /**
   * AI 错误处理 — 熔断器感知 + 2-strike 策略
   * @returns {Promise<Object|null>} - continueResult() 或 null (退出)
   */
  async #handleAiError(ctx: any, aiErr: any) {
    ctx.consecutiveAiErrors++;
    this.logger.warn(
      `[AgentRuntime] AI call failed (attempt ${ctx.consecutiveAiErrors}): ${aiErr.message}`
    );

    ctx.tracker?.rollbackTick?.();

    // 熔断器感知
    if (aiErr.code === 'CIRCUIT_OPEN') {
      this.logger.warn('[AgentRuntime] 🛑 circuit breaker OPEN — breaking to summary');
      if (!ctx.isSystem) {
        ctx.lastReply = `抱歉，AI 服务暂时不可用（${aiErr.message}）。请稍后重试，或检查 API 配置。`;
      }
      return null;
    }

    // 2-strike 策略
    if (ctx.consecutiveAiErrors >= 2) {
      this.logger.warn('[AgentRuntime] 🛑 2 consecutive AI errors — breaking to summary');
      ctx.messages.resetToPromptOnly();
      if (!ctx.isSystem) {
        ctx.lastReply = `抱歉，AI 服务暂时不可用（${aiErr.message}）。请稍后重试，或检查 API 配置。`;
      }
      return null;
    }

    await new Promise((r) => setTimeout(r, 2000));
    return continueResult();
  }

  /**
   * 工具调用处理 — 执行 + 记录 + 去重 + 阶段转换
   *
   * @param {LoopContext} ctx
   * @param {Object} llmResult
   * @param {string} effectiveSystemPrompt 用于 budget 耗尽时的摘要调用
   * @returns {Promise<boolean>} true = 应退出循环
   */
  async #processToolCalls(ctx: any, llmResult: any, effectiveSystemPrompt: any) {
    const { tracker, trace, messages } = ctx;

    // 工具调用数量限制
    let activeCalls = llmResult.functionCalls;
    if (activeCalls.length > MAX_TOOL_CALLS_PER_ITER) {
      this.logger.warn(
        `[AgentRuntime] ⚠ ${activeCalls.length} tool calls, capping to ${MAX_TOOL_CALLS_PER_ITER}`
      );
      tracker?.recordTruncatedCalls?.(activeCalls.length - MAX_TOOL_CALLS_PER_ITER);
      activeCalls = activeCalls.slice(0, MAX_TOOL_CALLS_PER_ITER);
    }

    // 追加 assistant 消息
    messages.appendAssistantWithToolCalls(llmResult.text || null, activeCalls);

    let roundSubmitCount = 0;
    let roundHasNewInfo = false;
    const roundToolNames: any[] = [];

    // 执行每个工具
    for (const fc of activeCalls) {
      this.#emitProgress('tool_call', { tool: fc.name, args: fc.args });

      this.bus.publish(
        AgentEvents.TOOL_CALL_START,
        {
          agentId: this.id,
          tool: fc.name,
        },
        { source: this.id }
      );

      // 通过 Pipeline 执行 (safety → cache → execute → observe → track → trace → dedup)
      const { result: toolResult, metadata } = await this.#toolPipeline.execute(fc, {
        runtime: this,
        loopCtx: ctx,
        iteration: ctx.iteration,
      });

      const durationMs = metadata.durationMs;
      const toolEntry = { tool: fc.name, args: fc.args, result: toolResult, durationMs };
      ctx.toolCalls.push(toolEntry);
      this.toolCallHistory.push(toolEntry);

      if (metadata.isNew) {
        roundHasNewInfo = true;
      }
      roundToolNames.push(fc.name);

      // onToolCall 通知
      const effectiveHook = ctx.onToolCall || this.onToolCall;
      if (effectiveHook) {
        try {
          effectiveHook(fc.name, fc.args, toolResult, ctx.iteration);
        } catch {
          /* 观察者错误不中断 */
        }
      }

      this.bus.publish(
        AgentEvents.TOOL_CALL_END,
        {
          agentId: this.id,
          tool: fc.name,
          durationMs,
          success: !toolResult?.error,
        },
        { source: this.id }
      );

      // 工具结果格式化 (统一通过 MessageAdapter)
      let resultStr = messages.formatToolResult(fc.name, toolResult);

      // 提交去重: pipeline 中间件已标记 metadata
      if ((metadata as any).dedupMessage) {
        resultStr = (metadata as any).dedupMessage;
      } else if ((metadata as any).isSubmit) {
        roundSubmitCount++;
      }

      // 进度回调 (tool_end 需要 resultStr.length)
      this.#emitProgress('tool_end', {
        tool: fc.name,
        duration: durationMs,
        status: toolResult?.error ? 'error' : 'ok',
        error: toolResult?.error || undefined,
        resultSize: resultStr.length,
      });

      // 追加 tool result
      messages.appendToolResult(fc.id, fc.name, resultStr);
    }

    // ExplorationTracker: endRound → 检查阶段转换
    if (tracker) {
      tracker.updatePlanProgress?.(trace);
      const transitionNudge = tracker.endRound({
        hasNewInfo: roundHasNewInfo,
        submitCount: roundSubmitCount,
        toolNames: roundToolNames,
      });
      if (transitionNudge) {
        messages.appendUserNudge(transitionNudge.text);
        this.logger.info(
          `[AgentRuntime] 📝 injected ${transitionNudge.type} nudge (${tracker.phase})`
        );
        const _dimT = ctx.sharedState?._dimensionMeta?.id || '';
      }
    }

    // ActiveContext: 关闭轮次
    if (trace) {
      trace.setRoundSummary?.({
        newInfoCount: roundHasNewInfo ? 1 : 0,
        totalCalls: activeCalls.length,
        submits: roundSubmitCount,
        cumulativeFiles: tracker?.getMetrics?.()?.uniqueFiles || 0,
        cumulativePatterns: tracker?.getMetrics?.()?.uniquePatterns || 0,
      });
      trace.endRound?.();
    }

    // Capability 后置钩子
    const stepToolEntries = ctx.toolCalls.slice(-activeCalls.length);
    const stepResult = {
      type: 'tool_calls',
      toolCalls: stepToolEntries,
      iteration: ctx.iteration,
    };
    for (const cap of ctx.capabilities) {
      cap.onAfterStep(stepResult);
    }

    this.#safeTransition('step_done', stepResult);

    // 检查预算 (非 tracker 模式)
    if (!tracker && ctx.iteration >= ctx.maxIterations) {
      const summary = await this.aiProvider.chatWithTools(ctx.prompt, {
        messages: messages.toMessages(),
        systemPrompt: effectiveSystemPrompt,
        toolChoice: 'none',
        temperature: ctx.budget.temperature ?? 0.7,
        maxTokens: ctx.budget.maxTokens ?? 4096,
      });
      if (summary.usage) {
        this.tokenUsage.input += summary.usage.inputTokens || 0;
        this.tokenUsage.output += summary.usage.outputTokens || 0;
        ctx.addTokenUsage(summary.usage);
      }
      ctx.lastReply = cleanFinalAnswer(summary.text || '');
      return true; // 退出
    }

    this.#safeTransition('continue');
    return false; // 继续循环
  }

  /**
   * 文本响应处理 — tracker 阶段路由 + 非 tracker 直接终止
   *
   * @param {LoopContext} ctx
   * @param {Object} llmResult
   * @returns {boolean} true = 应退出循环
   */
  #processTextResponse(ctx: any, llmResult: any) {
    const { tracker, trace, messages } = ctx;

    if (tracker) {
      // (setThought + extractAndSetPlan 已在主循环中统一处理)

      const textResult = tracker.onTextResponse();

      if (textResult.isFinalAnswer) {
        ctx.lastReply = cleanFinalAnswer(llmResult.text || '');
        this.logger.info(
          `[AgentRuntime] ✅ final answer — ${ctx.lastReply.length} chars, ${tracker.iteration} iters, ${ctx.toolCalls.length} tool calls`
        );
        trace?.endRound?.();
        return true;
      }

      if (textResult.needsDigestNudge) {
        messages.appendAssistantText(llmResult.text || '');
        messages.appendUserNudge(textResult.nudge);
        this.logger.info('[AgentRuntime] 📝 injected SUMMARIZE nudge (text-triggered transition)');
        const _dimD = ctx.sharedState?._dimensionMeta?.id || '';
        trace?.endRound?.();
        return false; // continue
      }

      if (textResult.shouldContinue) {
        messages.appendAssistantText(llmResult.text || '');
        if (textResult.nudge) {
          messages.appendUserNudge(textResult.nudge);
          const _dimC = ctx.sharedState?._dimensionMeta?.id || '';
        }
        trace?.endRound?.();
        return false; // continue
      }
    }

    // 非 tracker 模式: 文字回答即最终回答
    ctx.lastReply = cleanFinalAnswer(llmResult.text || '');
    trace?.endRound?.();
    return true;
  }

  /**
   * 循环退出后处理 — 强制摘要 + 构建返回值
   * @param {LoopContext} ctx
   * @returns {Promise<Object>}
   */
  async #finalize(ctx: any) {
    // Scan pipeline: 所有结果在 toolCalls 中 (collect_scan_recipe)，不需要文本回复
    // 直接跳过 forced summary，避免浪费一次 LLM 调用
    if (!ctx.lastReply && ctx.tracker?.submitToolName === 'collect_scan_recipe') {
      const recipeCount = ctx.toolCalls.filter(
        (tc: any) => (tc.tool || tc.name) === 'collect_scan_recipe'
      ).length;
      ctx.lastReply = `[scan complete: ${recipeCount} recipes collected]`;
    }

    // 强制摘要 (系统场景或 tracker 场景)
    if (!ctx.lastReply && (ctx.tracker || ctx.isSystem)) {
      const forcedResult = await produceForcedSummary({
        aiProvider: this.aiProvider,
        source: ctx.source,
        toolCalls: ctx.toolCalls,
        tracker: ctx.tracker,
        contextWindow: ctx.contextWindow,
        prompt: ctx.prompt,
        tokenUsage: this.tokenUsage,
      });
      ctx.lastReply = forcedResult.reply;
      if (forcedResult.tokenUsage) {
        this.tokenUsage.input += forcedResult.tokenUsage.input || 0;
        this.tokenUsage.output += forcedResult.tokenUsage.output || 0;
        ctx.addTokenUsage({
          inputTokens: forcedResult.tokenUsage.input || 0,
          outputTokens: forcedResult.tokenUsage.output || 0,
        });
      }
    }

    return ctx.buildResult();
  }

  // ─── 公共工具方法 ────────────────────────────

  /**
   * 中止执行
   */
  abort(reason = 'User aborted') {
    this.#safeTransition('abort', { reason });
    this.bus.publish(
      AgentEvents.AGENT_ABORTED,
      {
        agentId: this.id,
        reason,
      },
      { source: this.id }
    );
  }

  /**
   * 注入内存文件缓存（bootstrap 场景: allFiles 已在内存中，避免重复磁盘读取）
   * @param {Array|null} files - [{ relativePath, content, name }]
   */
  setFileCache(files: any) {
    this.#fileCache = files;
    this.#promptBuilder.setFileCache(files);
  }

  /** 项目根目录 (供 ToolExecutionPipeline 等访问) */
  get projectRoot() {
    return this.#projectRoot;
  }

  /** 文件缓存 (供 ToolExecutionPipeline 等访问) */
  get fileCache() {
    return this.#fileCache;
  }

  /**
   * 发送进度事件 (公开方法，供 ToolExecutionPipeline 中间件调用)
   */
  emitProgress(type: any, data: any = {}) {
    this.#emitProgress(type, data);
  }

  // ─── 私有方法 ────────────────────────────────

  /**
   * 安全状态转移 — 忽略不合法转移而不是抛异常。
   *
   * Pipeline/FanOut 场景下 reactLoop() 被多次调用,
   * 第 2+ 次调用时状态已不在 IDLE，直接 send('start') 会抛错。
   * 此方法在转移不合法时静默跳过，保证多阶段执行不中断。
   */
  #safeTransition(event: any, payload: any = {}) {
    try {
      this.state.send(event, payload);
    } catch {
      // 转移不合法 — 在多阶段场景中这是预期行为，静默跳过
    }
  }

  /**
   * 收集所有 Capability 的工具白名单
   * 如果任一 Capability tools 为空数组, 返回空 (使用全部工具)
   */
  #collectTools(caps: any) {
    const toolSet = new Set();
    let hasUnlimited = false;
    for (const cap of caps) {
      const tools = cap.tools;
      if (!tools || tools.length === 0) {
        hasUnlimited = true;
        break;
      }
      for (const t of tools) {
        toolSet.add(t);
      }
    }
    // 合并调用方按需注入的额外工具 (不经 Capability，避免污染共享能力)
    for (const t of this.#additionalTools) {
      toolSet.add(t);
    }
    return hasUnlimited ? [] : [...toolSet];
  }

  /**
   * 解析 capability 名称为实例 (Pipeline 阶段覆盖时调用)
   */
  #resolveCapabilities(capNames: any) {
    if (capNames == null) {
      return this.capabilities;
    }
    if (capNames.length === 0) {
      return []; // explicit empty = no tools
    }
    return capNames.map((name: any) => {
      if (typeof name === 'object' && name instanceof Capability) {
        return name;
      }
      // 先在已加载的 capabilities 中查找
      const existing = this.capabilities.find((c: any) => c.name === name);
      if (existing) {
        return existing;
      }
      // 否则从注册表创建
      return CapabilityRegistry.create(name);
    });
  }

  /**
   * 发送进度事件
   */
  #emitProgress(type: any, data: any = {}) {
    const event = {
      type,
      agentId: this.id,
      preset: this.presetName,
      ...data,
      timestamp: Date.now(),
    };
    if (this.onProgress) {
      this.onProgress(event);
    }
    this.bus.publish(AgentEvents.PROGRESS, event, { source: this.id });
  }
}

export default AgentRuntime;

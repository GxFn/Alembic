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
import type { LLMGateway } from '#external/ai/gateway/LLMGateway.js';
import Logger from '#infra/logging/Logger.js';
import type { ToolSchemaProjection } from '#tools/catalog/CapabilityManifest.js';
import { Capability, CapabilityRegistry } from '../capabilities/index.js';
import { PolicyEngine } from '../policies/index.js';
import { AgentEventBus, AgentEvents } from './AgentEventBus.js';
import type { AgentMessage } from './AgentMessage.js';
import {
  type AgentResult,
  type AiError,
  type FileCacheEntry,
  type LLMResult,
  MAX_TOOL_CALLS_PER_ITER,
  type ReactLoopOpts,
  type RuntimeConfig,
  type ToolCallEntry,
  type ToolCallHook,
  type ToolMetadata,
} from './AgentRuntimeTypes.js';
import { AgentState } from './AgentState.js';
import { DiagnosticsCollector } from './DiagnosticsCollector.js';
import { createExitController } from './ExitController.js';
import { cleanFinalAnswer } from './final-answer.js';
import { produceForcedSummary } from './forced-summary.js';
import { HookSystem, registerDefaultHooks } from './HookSystem.js';
import { continueResult, LLMResultType } from './LLMResultType.js';
import { LoopContext } from './LoopContext.js';
import { createMessageAdapter } from './MessageAdapter.js';
import { SystemPromptBuilder } from './SystemPromptBuilder.js';
import { createToolPipeline } from './ToolExecutionPipeline.js';

// ── Re-exports for backward compatibility ──
export type {
  AgentDiagnostics,
  AgentDiagnosticWarning,
  AgentResult,
  AiError,
  FileCacheEntry,
  FunctionCall,
  LLMResult,
  ProgressEvent,
  ReactLoopOpts,
  RuntimeConfig,
  ToolCallEntry,
  ToolCallHook,
  ToolMetadata,
} from './AgentRuntimeTypes.js';
export { MAX_TOOL_CALLS_PER_ITER } from './AgentRuntimeTypes.js';

export class AgentRuntime {
  onToolCall: ToolCallHook | null;
  id;
  presetName;
  state;
  bus;
  aiProvider;
  toolRegistry;
  toolRouter;
  container;
  capabilities;
  strategy;
  policies;
  persona;
  memoryConfig;
  onProgress;
  lang;
  logger;
  #projectRoot;
  #dataRoot;
  /** 文件缓存 (bootstrap 场景注入) */
  #fileCache: FileCacheEntry[] | null = null;
  /** 额外工具白名单 (调用方按需注入，不经 Capability) */
  #additionalTools: string[] = [];
  #toolPipeline;
  #promptBuilder;
  /** 可选 Gateway — 启用后走 Gateway 路径替代 aiProvider 直接调用 */
  #gateway: LLMGateway | null;
  #modelRef: string;
  /** 统一事件钩子系统 */
  #hookSystem: HookSystem;

  // ── 执行统计 ──
  iterationCount = 0;
  toolCallHistory: ToolCallEntry[] = [];
  tokenUsage = { input: 0, output: 0, reasoning: 0, cacheHit: 0 };
  startTime = 0;

  constructor(config: RuntimeConfig) {
    this.id = config.id || `runtime_${randomUUID().slice(0, 8)}`;
    this.presetName = config.presetName || 'custom';
    this.aiProvider = config.aiProvider;
    this.toolRegistry = config.toolRegistry;
    const toolRouter =
      config.toolRouter ||
      config.toolRegistry.getRouter?.() ||
      ((config.container as { get?: (name: string) => unknown } | null)?.get?.('toolRouter') as
        | RuntimeConfig['toolRouter']
        | undefined) ||
      null;
    if (!toolRouter) {
      throw new Error(
        'AgentRuntime requires ToolRouter. Runtime tool execution must use the unified router path.'
      );
    }
    this.toolRouter = toolRouter;
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
    this.#dataRoot = config.dataRoot || this.#projectRoot;
    this.#additionalTools = config.additionalTools || [];
    this.#gateway = config.gateway || null;
    this.#modelRef =
      config.modelRef ||
      `${config.aiProvider.name}:${(config.aiProvider as { model?: string }).model || 'unknown'}`;
    this.#toolPipeline = createToolPipeline();
    this.#hookSystem = (config as { hookSystem?: HookSystem }).hookSystem ?? new HookSystem();
    registerDefaultHooks(this.#hookSystem, this.id, this.bus);
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
        capabilities: this.capabilities.map((c: Capability) => c.name),
        strategy: this.strategy?.name,
      },
      { source: this.id }
    );
  }

  // ─── 公共 API ─────────────────────────────────

  /**
   * 执行 Agent — 入口
   *
   * @param message 统一消息
   * @param [opts] 策略特定选项 (如 FanOut 的 items)
   */
  async execute(message: AgentMessage, opts: Record<string, unknown> = {}): Promise<AgentResult> {
    this.startTime = Date.now();
    this.iterationCount = 0;
    this.toolCallHistory = [];
    this.tokenUsage = { input: 0, output: 0, reasoning: 0, cacheHit: 0 };
    const diagnostics = DiagnosticsCollector.from(opts.diagnostics);

    // ── Policy: 执行前校验 ──
    const beforeCheck = this.policies.validateBefore({ message, capabilities: this.capabilities });
    if (!beforeCheck.ok) {
      this.logger.warn(`[AgentRuntime] Policy rejected: ${beforeCheck.reason}`);
      diagnostics.warn({
        code: 'policy_rejected',
        message: beforeCheck.reason || 'Policy rejected the request',
      });
      return {
        reply: `⚠️ ${beforeCheck.reason}`,
        toolCalls: [],
        tokenUsage: { input: 0, output: 0 },
        iterations: 0,
        durationMs: 0,
        diagnostics: diagnostics.toJSON(),
        state: this.state.toJSON(),
      };
    }

    // ── 超时保护 ──
    const budget = this.policies.getBudget();
    const timeoutMs = budget?.timeoutMs || 300_000;
    const abortController = new AbortController();
    const parentAbortSignal =
      opts.abortSignal && typeof (opts.abortSignal as AbortSignal).aborted === 'boolean'
        ? (opts.abortSignal as AbortSignal)
        : null;
    const onParentAbort = () => abortController.abort();
    if (parentAbortSignal?.aborted) {
      abortController.abort();
    } else {
      parentAbortSignal?.addEventListener('abort', onParentAbort, { once: true });
    }
    const cleanupExecutionGuards = () => {
      clearTimeout(timeoutId);
      parentAbortSignal?.removeEventListener('abort', onParentAbort);
    };

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort();
        reject(new Error(`Agent timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      // ── 委托给 Strategy ──
      const resultPromise = this.strategy.execute(this, message, {
        ...opts,
        abortSignal: abortController.signal,
        diagnostics,
      });
      const result = (await Promise.race([resultPromise, timeoutPromise])) as AgentResult;
      cleanupExecutionGuards();
      if (diagnostics.isEmpty()) {
        diagnostics.merge(result.diagnostics);
      }

      // ── Policy: 执行后校验 ──
      const afterCheck = this.policies.validateAfter(
        result as import('../policies/index.js').PolicyResult
      );
      if (!afterCheck.ok) {
        this.logger.warn(`[AgentRuntime] Quality check: ${afterCheck.reason}`);
        result.qualityWarning = afterCheck.reason;
        diagnostics.warn({
          code: 'quality_warning',
          message: afterCheck.reason || 'Policy quality check failed',
        });
      }

      // 状态完成
      this.#safeTransition('finish', { reply: result.reply?.slice(0, 100) });

      // 回复给原始渠道
      if (message.replyFn && result.reply) {
        await message.reply(result.reply);
      }

      result.state = this.state.toJSON();
      result.durationMs = Date.now() - this.startTime;
      if (result.degraded) {
        diagnostics.markDegraded();
      }
      result.diagnostics = diagnostics.toJSON();

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
    } catch (err: unknown) {
      cleanupExecutionGuards();
      this.state.send('error', { error: (err as Error).message });
      this.bus.publish(
        AgentEvents.AGENT_FAILED,
        {
          agentId: this.id,
          error: (err as Error).message,
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
   * @param prompt 用户/系统提示
   * @param [opts.history] 对话历史
   * @param [opts.context] 额外上下文
   * @param [opts.capabilityOverride] 临时覆盖 capability (Pipeline 阶段用)
   * @param [opts.budgetOverride] 临时覆盖 budget
   * @param [opts.systemPromptOverride] 完全覆盖系统提示词 (Bootstrap 阶段专用)
   * @param [opts.onToolCall] 本轮独立的工具调用钩子，优先于 runtime 级
   * @param [opts.contextWindow] 上下文窗口管理器
   * @param [opts.tracker] ExplorationTracker 实例
   * @param [opts.trace] ActiveContext 实例
   * @param [opts.memoryCoordinator] MemoryCoordinator 实例
   * @param [opts.sharedState] 共享状态 { submittedTitles, submittedPatterns }
   * @param [opts.source] 'user' | 'system'
   * @param [opts.toolChoiceOverride] 首轮 toolChoice 覆盖 ('required'/'auto'/'none')
   *   首轮强制 LLM 生成 tool call（LLM 自行决定调哪个工具、传什么参数）。
   *   这不是替 LLM 做决定，而是告诉 LLM "你必须调用某个工具"。
   *   仅在第一轮生效，后续轮次恢复正常 toolChoice 逻辑。
   */
  async reactLoop(prompt: string, opts: ReactLoopOpts = {}) {
    const ctx = this.#initLoop(prompt, opts);

    // ─── ReAct 主循环 (编排骨架) ─────
    while (true) {
      ctx.iteration++;
      this.iterationCount++;

      // ActiveContext: 开始新轮次 (必须在 #shouldExit 前, 保证 endRound 有配对)
      ctx.trace?.startRound(ctx.iteration);

      this.#hookSystem.emitSync('agent:iteration:before', {
        iteration: ctx.iteration,
        phase: ctx.tracker?.phase,
      });

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
      if ((llmResult.functionCalls?.length ?? 0) > 0) {
        const exitAfterTools = await this.#processToolCalls(ctx, llmResult, effectiveSystemPrompt);
        this.#hookSystem.emitSync('agent:iteration:after', {
          iteration: ctx.iteration,
          hadToolCalls: true,
          hadText: !!llmResult.text,
        });
        if (exitAfterTools) {
          break;
        }
        continue;
      }

      // 分支: 纯文本回复
      this.#hookSystem.emitSync('agent:iteration:after', {
        iteration: ctx.iteration,
        hadToolCalls: false,
        hadText: true,
      });
      if (this.#processTextResponse(ctx, llmResult)) {
        break;
      }
    }

    return this.#finalize(ctx);
  }

  // ─── 提取方法: reactLoop 内部阶段 ────────────

  /** 初始化循环上下文 — 封装 reactLoop 前 ~60 行初始化逻辑 */
  #initLoop(prompt: string, opts: ReactLoopOpts) {
    const {
      history = [],
      context = {},
      capabilityOverride,
      additionalToolsOverride,
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
      abortSignal,
      diagnostics,
    } = opts;
    const diagnosticsCollector = DiagnosticsCollector.from(diagnostics);

    // 解析 capabilities
    const caps = capabilityOverride
      ? this.#resolveCapabilities(capabilityOverride)
      : this.capabilities;

    // 构建基础系统提示词 (委托 SystemPromptBuilder)
    let baseSystemPrompt = systemPromptOverride || this.#promptBuilder.build(caps, context);

    // 收集工具 (空列表是明确无工具，不再隐式展开为全量工具)
    const allowedToolIds = this.#collectTools(caps, additionalToolsOverride).map(String);
    const toolSchemas = this.#getToolSchemas(allowedToolIds, this.#modelRef);
    diagnosticsCollector.recordStageToolset({
      stage: typeof context.pipelinePhase === 'string' ? context.pipelinePhase : 'react_loop',
      capabilities: caps.map((c: Capability) => c.name),
      allowedToolIds,
      toolSchemaCount: toolSchemas.length,
      ...(source ? { source } : {}),
    });

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
        capabilities: caps.map((c: Capability) => c.name),
      },
      { source: this.id }
    );

    const ctx = new LoopContext({
      messages,
      tracker: tracker || null,
      trace: trace || null,
      memoryCoordinator: memoryCoordinator || null,
      sharedState: sharedState || null,
      source: source || 'user',
      budget,
      capabilities: caps,
      baseSystemPrompt,
      allowedToolIds,
      toolSchemas,
      prompt,
      onToolCall: onToolCall || null,
      context: context || {},
      contextWindow: contextWindow || null,
      toolChoiceOverride: toolChoiceOverride || null,
      abortSignal: (abortSignal as AbortSignal) || null,
      diagnostics: diagnosticsCollector,
    });

    ctx.exitController = createExitController(ctx, this.policies);
    return ctx;
  }

  /**
   * 退出判定 — 委托 ExitController，保留 Capability 前置钩子
   * @returns true = 应退出循环
   */
  #shouldExit(ctx: LoopContext): boolean {
    const ec = ctx.exitController;
    if (ec) {
      const signal = ec.checkBeforeIteration(ctx, this.tokenUsage);
      if (signal.action !== 'continue') {
        this.logger.info(
          `[AgentRuntime] ExitController: ${signal.reason} — ${signal.detail || ''}`
        );
        ctx.diagnostics?.warn({
          code: signal.reason || 'exit',
          message: signal.detail || signal.reason || 'ExitController stopped the run',
        });
        return true;
      }
    } else {
      // Legacy fallback (no ExitController — should not happen in normal flow)
      if (ctx.abortSignal?.aborted) {
        return true;
      }
      if (ctx.tracker) {
        ctx.tracker.tick();
        if (ctx.tracker.shouldExit()) {
          return true;
        }
      }
      if (ctx.budget?.timeoutMs && Date.now() - ctx.loopStartTime > ctx.budget.timeoutMs) {
        return true;
      }
      const duringCheck = this.policies.validateDuring({
        iteration: ctx.tracker ? 0 : ctx.iteration,
        startTime: ctx.loopStartTime,
        totalTokens: this.tokenUsage.input + this.tokenUsage.output,
        totalInputTokens: this.tokenUsage.input,
      });
      if (!duringCheck.ok) {
        return true;
      }
    }

    // Capability 前置钩子 (always executed regardless of exit controller)
    for (const cap of ctx.capabilities) {
      cap.onBeforeStep({
        iteration: ctx.iteration,
        messages: ctx.messages.toMessages(),
        prompt: ctx.prompt,
      });
    }

    return false;
  }

  /**
   * 迭代准备 — 合并 nudge/压缩/提示词增强/toolChoice
   * @returns }
   */
  #prepareIteration(ctx: LoopContext) {
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
        if (process.env.ALEMBIC_MCP_MODE !== '1') {
          process.stderr.write(
            `\n\x1b[36m━━━ Nudge [${nudge.type}] iter=${ctx.iteration}${_dim ? ` dim=${_dim}` : ''} ━━━\x1b[0m\n`
          );
          process.stderr.write(`\x1b[33m${nudge.text}\x1b[0m\n\n`);
        }
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
    let toolChoice: string | Record<string, unknown>;
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
        mode: (ctx.source || 'analyst') as 'user' | 'analyst' | 'producer',
        scopeId: (ctx.context?.dimensionScopeId as string) || undefined,
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
   * @returns llmResult 或 null (表示应退出)
   */
  async #callLLM(
    ctx: LoopContext,
    toolChoice: string,
    effectiveSystemPrompt: string,
    effectivePrompt: string
  ): Promise<LLMResult | null> {
    this.bus.publish(
      AgentEvents.LLM_CALL_START,
      {
        agentId: this.id,
        iteration: ctx.iteration,
      },
      { source: this.id }
    );

    let llmResult: LLMResult;
    try {
      // toolChoice='none' 时不发送 toolSchemas —— 部分 LLM (Gemini) 在看到
      // 工具定义但被禁止调用时会返回空内容，导致 SUMMARIZE 阶段失败
      const effectiveToolSchemas =
        toolChoice === 'none'
          ? undefined
          : ctx.toolSchemas.length > 0
            ? ctx.toolSchemas
            : undefined;

      const unifiedMessages =
        ctx.messages.toProjectedMessages() as import('#external/ai/AiProvider.js').UnifiedMessage[];
      const unifiedTools = effectiveToolSchemas as
        | import('#external/ai/AiProvider.js').ToolSchema[]
        | undefined;

      if (this.#gateway) {
        llmResult = (await this.#gateway.chatWithTools({
          modelRef: this.#modelRef,
          messages: unifiedMessages,
          tools: unifiedTools,
          toolChoice: unifiedTools ? toolChoice : undefined,
          systemPrompt: effectiveSystemPrompt,
          temperature: ctx.budget.temperature ?? (ctx.isSystem ? 0.3 : 0.7),
          maxTokens: ctx.budget.maxTokens ?? (ctx.isSystem ? 8192 : 4096),
          abortSignal: ctx.abortSignal ?? undefined,
        })) as LLMResult;
      } else {
        llmResult = (await this.aiProvider.chatWithTools(effectivePrompt, {
          messages: unifiedMessages,
          toolSchemas: unifiedTools,
          toolChoice: unifiedTools ? toolChoice : undefined,
          systemPrompt: effectiveSystemPrompt,
          temperature: ctx.budget.temperature ?? (ctx.isSystem ? 0.3 : 0.7),
          maxTokens: ctx.budget.maxTokens ?? (ctx.isSystem ? 8192 : 4096),
          abortSignal: ctx.abortSignal ?? undefined,
        })) as LLMResult;
      }
      ctx.consecutiveAiErrors = 0;
    } catch (aiErr: unknown) {
      return this.#handleAiError(ctx, aiErr as AiError);
    }

    // 累计 Token (runtime 级 + loop 级)
    if (llmResult.usage) {
      this.tokenUsage.input += llmResult.usage.inputTokens || 0;
      this.tokenUsage.output += llmResult.usage.outputTokens || 0;
      this.tokenUsage.reasoning += llmResult.usage.reasoningTokens || 0;
      this.tokenUsage.cacheHit += llmResult.usage.cacheHitTokens || 0;
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
      ctx.diagnostics?.recordEmptyResponse();
      // B4 fix: SUMMARIZE 阶段也允许重试 — force_exit nudge 刚注入时 LLM 可能
      // 需要额外一轮才能生成有效输出。与 ExplorationTracker 的 2 轮 grace 对齐，
      // 避免 grace 机制被架空。重试次数由 tracker.phaseRounds 控制而非独立计数。
      const isTerminal = ctx.tracker && ctx.tracker.phase === 'SUMMARIZE';
      if (isTerminal && ctx.tracker) {
        const phaseRounds = ctx.tracker.metrics?.phaseRounds ?? 0;
        if (phaseRounds < 2) {
          ctx.consecutiveEmptyResponses++;
          this.logger.warn(
            `[AgentRuntime] ⚠ empty response in SUMMARIZE — retrying (grace ${phaseRounds + 1}/2)`
          );
          // 不 rollbackTick: 让 tracker 计入 phaseRounds 以便到达 grace 上限退出
          await new Promise((r) => setTimeout(r, 1500));
          return continueResult() as LLMResult;
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
        return continueResult() as LLMResult;
      }
      return null; // 退出
    }
    if (llmResult.text || llmResult.functionCalls?.length) {
      ctx.consecutiveEmptyResponses = 0;
    }

    // Graceful exit 保护 — 在 SUMMARIZE 阶段或 gracefulExit 状态下，
    // toolChoice=none 但部分 LLM (DeepSeek 等) 可能仍然返回 tool calls，需要忽略
    const isTerminalPhase = ctx.tracker?.phase === 'SUMMARIZE' || ctx.tracker?.phase === 'FINALIZE';
    if (
      (ctx.tracker?.isGracefulExit || isTerminalPhase) &&
      llmResult.functionCalls?.length &&
      llmResult.functionCalls.length > 0
    ) {
      this.logger.warn(
        `[AgentRuntime] ⚠ AI returned ${llmResult.functionCalls.length} tool calls despite toolChoice=none (${isTerminalPhase ? 'terminal phase' : 'graceful exit'}) — ignoring`
      );
      ctx.diagnostics?.warn({
        code: 'tool_choice_violation',
        message: `AI returned ${llmResult.functionCalls.length} tool calls despite toolChoice=none`,
      });
      if (llmResult.text) {
        ctx.lastReply = cleanFinalAnswer(llmResult.text);
        return null; // 退出
      }
      return continueResult() as LLMResult;
    }

    return llmResult;
  }

  /**
   * AI 错误处理 — 熔断器感知 + 2-strike 策略
   * @returns continueResult() 或 null (退出)
   */
  async #handleAiError(ctx: LoopContext, aiErr: AiError): Promise<LLMResult | null> {
    // AbortError — 外部中止信号已触发，不计入错误计数，立即退出
    if (ctx.abortSignal?.aborted) {
      this.logger.info('[AgentRuntime] ⛔ abortSignal fired during LLM call — exiting');
      ctx.diagnostics?.warn({ code: 'aborted', message: 'AbortSignal fired during LLM call' });
      return null;
    }

    ctx.consecutiveAiErrors++;
    ctx.diagnostics?.recordAiError(aiErr.message);
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
    return continueResult() as LLMResult;
  }

  /**
   * 工具调用处理 — 执行 + 记录 + 去重 + 阶段转换
   *
   * @param effectiveSystemPrompt 用于 budget 耗尽时的摘要调用
   * @returns true = 应退出循环
   */
  async #processToolCalls(ctx: LoopContext, llmResult: LLMResult, effectiveSystemPrompt: string) {
    const { tracker, trace, messages } = ctx;

    // 工具调用数量限制
    let activeCalls = llmResult.functionCalls || [];
    let truncatedCalls: typeof activeCalls = [];
    if (activeCalls.length > MAX_TOOL_CALLS_PER_ITER) {
      this.logger.warn(
        `[AgentRuntime] ⚠ ${activeCalls.length} tool calls, capping to ${MAX_TOOL_CALLS_PER_ITER}`
      );
      tracker?.recordTruncatedCalls?.(activeCalls.length - MAX_TOOL_CALLS_PER_ITER);
      ctx.diagnostics?.recordTruncatedToolCalls(activeCalls.length - MAX_TOOL_CALLS_PER_ITER);
      truncatedCalls = activeCalls.slice(MAX_TOOL_CALLS_PER_ITER);
      activeCalls = activeCalls.slice(0, MAX_TOOL_CALLS_PER_ITER);
    }

    // 追加 assistant 消息（含 DeepSeek V4 reasoningContent 透传）
    messages.appendAssistantWithToolCalls(
      llmResult.text || null,
      activeCalls,
      llmResult.reasoningContent
    );

    let roundSubmitCount = 0;
    let roundHasNewInfo = false;
    const roundToolNames: string[] = [];

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

      // HookSystem: tool:execute:before
      this.#hookSystem.emitSync('tool:execute:before', {
        toolId: fc.name,
        args: fc.args,
        callId: fc.id,
      });

      // 通过 Pipeline 执行 (safety → cache → execute → observe → track → trace → dedup)
      const { result: toolResult, metadata } = await this.#toolPipeline.execute(fc, {
        runtime: this,
        loopCtx: ctx,
        iteration: ctx.iteration,
      });

      const durationMs = metadata.durationMs;
      const envelope = (metadata as ToolMetadata).envelope;
      const toolEntry: ToolCallEntry = {
        tool: fc.name,
        args: fc.args,
        result: toolResult,
        envelope,
        durationMs,
      };
      (ctx.toolCalls as ToolCallEntry[]).push(toolEntry);
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

      const toolResultObj = toolResult as Record<string, unknown> | null;
      const toolSucceeded = envelope ? envelope.ok : !toolResultObj?.error;

      this.bus.publish(
        AgentEvents.TOOL_CALL_END,
        {
          agentId: this.id,
          tool: fc.name,
          durationMs,
          success: toolSucceeded,
        },
        { source: this.id }
      );

      // HookSystem: tool:execute:after
      this.#hookSystem.emitSync('tool:execute:after', {
        toolId: fc.name,
        ok: toolSucceeded,
        durationMs,
        callId: fc.id,
      });

      // 工具结果格式化 (统一通过 MessageAdapter)
      let resultStr = messages.formatToolResult(fc.name, envelope || toolResult);

      // 提交去重: pipeline 中间件已标记 metadata
      const dedupMessage = (metadata as ToolMetadata).dedupMessage;
      if (dedupMessage) {
        resultStr = dedupMessage;
      } else if ((metadata as ToolMetadata).isSubmit) {
        roundSubmitCount++;
      }

      // 进度回调 (tool_end 需要 resultStr.length)
      this.#emitProgress('tool_end', {
        tool: fc.name,
        duration: durationMs,
        status: toolSucceeded ? 'ok' : 'error',
        error:
          envelope && !envelope.ok
            ? envelope.text
            : (toolResultObj?.error as string | undefined) || undefined,
        resultSize: resultStr.length,
      });

      // 追加 tool result
      messages.appendToolResult(fc.id, fc.name, resultStr);
    }

    if (truncatedCalls.length > 0) {
      const truncatedNames = truncatedCalls
        .map((call) => call.name)
        .slice(0, 5)
        .join(', ');
      messages.appendUserNudge(
        `工具调用数量超限：本轮只执行前 ${MAX_TOOL_CALLS_PER_ITER} 个工具调用，另有 ${truncatedCalls.length} 个未执行${truncatedNames ? `（${truncatedNames}${truncatedCalls.length > 5 ? '...' : ''}）` : ''}。请基于已返回结果继续，必要时分批重新请求未执行的工具。`
      );
    }

    // Lazy Loading: mark used tools as expanded for future rounds
    if (roundToolNames.length > 0) {
      this.#markToolsExpanded(roundToolNames);
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
        if (process.env.ALEMBIC_MCP_MODE !== '1') {
          process.stderr.write(
            `\n\x1b[35m━━━ Transition Nudge [${transitionNudge.type}] phase=${tracker.phase}${_dimT ? ` dim=${_dimT}` : ''} ━━━\x1b[0m\n`
          );
          process.stderr.write(`\x1b[33m${transitionNudge.text}\x1b[0m\n\n`);
        }
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
      const summaryMessages =
        messages.toMessages() as import('#external/ai/AiProvider.js').UnifiedMessage[];
      const summary: LLMResult = this.#gateway
        ? ((await this.#gateway.chatWithTools({
            modelRef: this.#modelRef,
            messages: summaryMessages,
            systemPrompt: effectiveSystemPrompt,
            toolChoice: 'none',
            temperature: ctx.budget.temperature ?? 0.7,
            maxTokens: ctx.budget.maxTokens ?? 4096,
          })) as LLMResult)
        : ((await this.aiProvider.chatWithTools(ctx.prompt, {
            messages: summaryMessages,
            systemPrompt: effectiveSystemPrompt,
            toolChoice: 'none',
            temperature: ctx.budget.temperature ?? 0.7,
            maxTokens: ctx.budget.maxTokens ?? 4096,
          })) as LLMResult);
      if (summary.usage) {
        this.tokenUsage.input += summary.usage.inputTokens || 0;
        this.tokenUsage.output += summary.usage.outputTokens || 0;
        this.tokenUsage.reasoning += summary.usage.reasoningTokens || 0;
        this.tokenUsage.cacheHit += summary.usage.cacheHitTokens || 0;
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
   * @returns true = 应退出循环
   */
  #processTextResponse(ctx: LoopContext, llmResult: LLMResult) {
    const { tracker, trace, messages } = ctx;

    if (tracker) {
      // 文本轮次也需要更新 tracker 指标 — 否则 roundsSinceNewInfo / consecutiveIdleRounds
      // 不递增，metrics 驱动的阶段转换永远不触发（根因: 工具路径 endRound 被调用但文本路径被跳过）
      const phaseBefore = tracker.phase;
      tracker.endRound({
        hasNewInfo: false,
        submitCount: 0,
        toolNames: [],
      });
      const metricsTransitionedToTerminal =
        phaseBefore !== tracker.phase &&
        (tracker.phase === 'SUMMARIZE' || tracker.phase === 'FINALIZE');

      const textResult = tracker.onTextResponse();

      // 如果 endRound 的 metrics 转换刚推进到终结阶段，则强制走 needsDigestNudge 路径，
      // 给 Agent 一轮机会输出完整总结，而不是把当前文本当作最终回复
      if (metricsTransitionedToTerminal && textResult.isFinalAnswer) {
        const digestNudge =
          tracker.pipelineType === 'analyst'
            ? `请**停止调用工具**，直接输出你的完整分析报告。用 Markdown 格式，包含具体文件路径、类名和代码模式。至少涵盖 3 个核心发现。\n\n**现在开始输出你的分析报告。**\n⚠️ 严禁在回复中复制本条指令文字，只输出你自己的分析。`
            : null;
        if (digestNudge) {
          messages.appendAssistantText(llmResult.text || '', llmResult.reasoningContent);
          messages.appendUserNudge(digestNudge);
          this.logger.info(
            '[AgentRuntime] 📝 metrics-transition to terminal — injecting digest nudge'
          );
          trace?.endRound?.();
          return false; // continue — let agent produce a full summary
        }
      }

      if (textResult.isFinalAnswer) {
        ctx.lastReply = cleanFinalAnswer(llmResult.text || '');
        this.logger.info(
          `[AgentRuntime] ✅ final answer — ${ctx.lastReply.length} chars, ${tracker.iteration} iters, ${ctx.toolCalls.length} tool calls`
        );
        trace?.endRound?.();
        return true;
      }

      if (textResult.needsDigestNudge) {
        messages.appendAssistantText(llmResult.text || '', llmResult.reasoningContent);
        if (textResult.nudge) {
          messages.appendUserNudge(textResult.nudge);
        }
        this.logger.info('[AgentRuntime] 📝 injected SUMMARIZE nudge (text-triggered transition)');
        const _dimD = ctx.sharedState?._dimensionMeta?.id || '';
        if (textResult.nudge && process.env.ALEMBIC_MCP_MODE !== '1') {
          process.stderr.write(
            `\n\x1b[34m━━━ Digest Nudge [SUMMARIZE]${_dimD ? ` dim=${_dimD}` : ''} ━━━\x1b[0m\n`
          );
          process.stderr.write(`\x1b[33m${textResult.nudge}\x1b[0m\n\n`);
        }
        trace?.endRound?.();
        return false; // continue
      }

      if (textResult.shouldContinue) {
        messages.appendAssistantText(llmResult.text || '', llmResult.reasoningContent);
        if (textResult.nudge) {
          messages.appendUserNudge(textResult.nudge);
          const _dimC = ctx.sharedState?._dimensionMeta?.id || '';
          if (process.env.ALEMBIC_MCP_MODE !== '1') {
            process.stderr.write(
              `\n\x1b[32m━━━ Continue Nudge${_dimC ? ` dim=${_dimC}` : ''} ━━━\x1b[0m\n`
            );
            process.stderr.write(`\x1b[33m${textResult.nudge}\x1b[0m\n\n`);
          }
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

  /** 循环退出后处理 — 强制摘要 + 构建返回值 */
  async #finalize(ctx: LoopContext) {
    // Scan 管线: 所有结果在 toolCalls 中 (collect_scan_recipe)，不需要文本回复
    // 直接跳过 forced summary，避免浪费一次 LLM 调用
    if (!ctx.lastReply && ctx.tracker?.pipelineType === 'scan') {
      const recipeCount = ctx.toolCalls.filter(
        (tc: ToolCallEntry) => (tc.tool || tc.name) === 'collect_scan_recipe'
      ).length;
      ctx.lastReply = `[scan complete: ${recipeCount} recipes collected]`;
    }

    // 强制摘要 — 循环结束后无文本回复时，生成摘要
    // 覆盖所有场景: 系统管线、tracker 管线、用户对话(有/无工具调用)
    if (!ctx.lastReply) {
      if (ctx.toolCalls.length > 0 || ctx.tracker || ctx.isSystem) {
        const forcedResult = await produceForcedSummary({
          aiProvider: this.aiProvider,
          source: ctx.source,
          toolCalls: ctx.toolCalls,
          tracker: ctx.tracker ?? undefined,
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
      } else {
        // 兜底: 既无工具调用也无文本回复
        ctx.lastReply = '抱歉，AI 未能生成有效回复。请重试或换个问题。';
        this.logger.warn(
          `[AgentRuntime] ⚠ finalize: no reply, no tool calls (iter=${ctx.iteration}) — fallback message`
        );
        ctx.diagnostics?.markFallbackUsed();
        ctx.diagnostics?.warn({
          code: 'fallback_reply',
          message: 'Finalized with fallback message because no reply or tool calls were produced',
        });
      }
    }

    this.#hookSystem.emitSync('agent:finalize', {
      reply: ctx.lastReply,
      iterations: ctx.iteration,
      toolCallCount: ctx.toolCalls.length,
    });

    return ctx.buildResult();
  }

  // ─── 公共工具方法 ────────────────────────────

  /** 中止执行 */
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
   * @param files [{ relativePath, content, name }]
   */
  setFileCache(files: FileCacheEntry[] | null) {
    this.#fileCache = files;
    this.#promptBuilder.setFileCache(files);
  }

  /** HookSystem 实例（供外部桥接 AgentEventBus / SignalBus） */
  get hookSystem(): HookSystem {
    return this.#hookSystem;
  }

  /** 项目根目录 (供 ToolExecutionPipeline 等访问) */
  get projectRoot() {
    return this.#projectRoot;
  }

  /** 数据根目录 (Ghost 模式下指向外置工作区) */
  get dataRoot() {
    return this.#dataRoot;
  }

  /** 文件缓存 (供 ToolExecutionPipeline 等访问) */
  get fileCache() {
    return this.#fileCache;
  }

  /** 发送进度事件 (公开方法，供 ToolExecutionPipeline 中间件调用) */
  emitProgress(type: string, data: Record<string, unknown> = {}) {
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
  #safeTransition(event: string, payload: Record<string, unknown> = {}) {
    try {
      this.state.send(event, payload);
    } catch {
      // 转移不合法 — 在多阶段场景中这是预期行为，静默跳过
    }
  }

  /**
   * 收集所有 Agent Skill 的工具白名单。
   * 空 tools 表示该技能不开放工具；全量工具必须通过显式 action space 表达。
   */
  #collectTools(caps: Capability[], additionalToolsOverride?: string[]) {
    const toolSet = new Set();
    for (const cap of caps) {
      const tools = cap.tools;
      if (!tools || tools.length === 0) {
        continue;
      }
      for (const t of tools) {
        toolSet.add(t);
      }
    }
    // 合并调用方按需注入的额外工具 (不经 Capability，避免污染共享能力)
    for (const t of this.#additionalTools) {
      toolSet.add(t);
    }
    for (const t of additionalToolsOverride || []) {
      toolSet.add(t);
    }
    return [...toolSet];
  }

  #getToolSchemas(allowedTools: unknown[], model?: string): ToolSchemaProjection[] {
    const ids = allowedTools.map(String);
    const catalog = (this.container as { get?: (name: string) => unknown } | null)?.get?.(
      'capabilityCatalog'
    ) as
      | {
          toToolSchemas(ids?: readonly string[] | null): ToolSchemaProjection[];
          toToolSchemasForModel?(
            ids?: readonly string[] | null,
            model?: string
          ): ToolSchemaProjection[];
          toMixedSchemas?(
            ids?: readonly string[] | null,
            model?: string,
            firstRound?: boolean
          ): ToolSchemaProjection[];
        }
      | undefined;
    // Lazy Loading: use mixed schemas (lightweight for unused tools)
    // firstRound = true when no tools have been expanded yet (first stage or fresh session)
    if (catalog?.toMixedSchemas) {
      const expandedCount = (catalog as { expandedCount?: number }).expandedCount ?? 0;
      return catalog.toMixedSchemas(ids, model, expandedCount === 0);
    }
    if (model && catalog?.toToolSchemasForModel) {
      return catalog.toToolSchemasForModel(ids, model);
    }
    if (catalog?.toToolSchemas) {
      return catalog.toToolSchemas(ids);
    }
    return [];
  }

  /** Mark tools as expanded after use (for lazy loading) */
  #markToolsExpanded(toolNames: string[]): void {
    const catalog = (this.container as { get?: (name: string) => unknown } | null)?.get?.(
      'capabilityCatalog'
    ) as { markExpanded?(id: string): void } | undefined;
    if (catalog?.markExpanded) {
      for (const name of toolNames) {
        catalog.markExpanded(name);
      }
    }
  }

  /** 解析 capability 名称为实例 (Pipeline 阶段覆盖时调用) */
  #resolveCapabilities(capNames: string[] | null) {
    if (capNames == null) {
      return this.capabilities;
    }
    if (capNames.length === 0) {
      return []; // explicit empty = no tools
    }
    return capNames.map((name: string | Capability) => {
      if (typeof name === 'object' && name instanceof Capability) {
        return name;
      }
      // 先在已加载的 capabilities 中查找
      const existing = this.capabilities.find((c: Capability) => c.name === name);
      if (existing) {
        return existing;
      }
      // 否则从注册表创建
      return CapabilityRegistry.create(name as string);
    });
  }

  /** 发送进度事件 */
  #emitProgress(type: string, data: Record<string, unknown> = {}) {
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

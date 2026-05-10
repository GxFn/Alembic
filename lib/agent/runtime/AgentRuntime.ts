import { randomUUID } from "node:crypto";
import {
  type AiTask,
  type AiTaskPlan,
  AiTaskPlanner,
  type AiTaskPlanStatus,
  type GuardedParams,
  type ModelDef,
  ParameterGuard,
} from "../../mainline/ai/index.js";
import { createDefaultToolRegistry, type ToolRegistryReader } from "../tools/index.js";
import { type AgentEventBus, AgentEvents, agentEventBus } from "./AgentEventBus.js";
import type {
  AgentDiagnostics,
  AgentMessageLike,
  AgentResult,
  FileCacheEntry,
  FunctionCall,
  LLMResult,
  ProgressEvent,
  ReactLoopOpts,
  RuntimeAiProvider,
  RuntimeChatMessage,
  RuntimeChatWithToolsOptions,
  RuntimeConfig,
  RuntimeToolSchema,
  ToolCallEntry,
  ToolCallHook,
} from "./AgentRuntimeTypes.js";
import { MAX_TOOL_CALLS_PER_ITER } from "./AgentRuntimeTypes.js";
import { AgentState } from "./AgentState.js";
import { BudgetController, type RuntimeContextWindow } from "./BudgetController.js";
import { DiagnosticsCollector } from "./DiagnosticsCollector.js";
import { createExitController, type ExitSignal } from "./ExitController.js";
import { checkFinalAnswer, cleanFinalAnswer } from "./final-answer.js";
import { produceForcedSummary } from "./forced-summary.js";
import { HookSystem, registerDefaultHooks } from "./HookSystem.js";
import { type LoopBudgetConfig, LoopContext } from "./LoopContext.js";
import { createMessageAdapter } from "./MessageAdapter.js";
import { type RuntimeCapability, SystemPromptBuilder } from "./SystemPromptBuilder.js";
import {
  createToolPipeline,
  type ToolCall,
  type ToolEventBusLike,
  type ToolExecutionPipeline,
  type ToolExecutionResult,
  type ToolObservationSink,
  type ToolProgressEmitter,
  type ToolTraceSink,
  type ToolTrackerSink,
} from "./ToolExecutionPipeline.js";

export interface AgentRuntimeOptions {
  readonly aiTaskPlanner?: AiTaskPlanner;
  readonly hooks?: HookSystem;
  readonly toolPipeline?: ToolExecutionPipeline;
  readonly toolRegistry?: ToolRegistryReader;
  readonly eventBus?: AgentEventBus;
}

export interface AgentRuntimeAiHookRequest {
  readonly plan: AiTaskPlan;
  readonly model?: ModelDef;
  readonly params?: Record<string, unknown>;
  readonly diagnostics?: DiagnosticsCollector | Partial<AgentDiagnostics>;
}

export interface AgentRuntimeAiHookResult {
  readonly status: AiTaskPlanStatus;
  readonly blocked: boolean;
  readonly degraded: boolean;
  readonly ready: boolean;
  readonly reason: string;
  readonly tasks: readonly AiTask[];
  readonly guardedParams?: GuardedParams;
  readonly diagnostics: AgentDiagnostics;
  readonly recipePublicationAttempted: false;
}

export interface AgentRuntimeToolCallOptions {
  readonly allowedToolIds?: readonly string[];
  readonly diagnostics?: DiagnosticsCollector | Partial<AgentDiagnostics>;
  readonly iteration?: number;
  readonly source?: string;
  readonly onToolCall?: ToolCallHook | null;
  readonly observationSink?: ToolObservationSink | null;
  readonly trackerSink?: ToolTrackerSink | null;
  readonly traceSink?: ToolTraceSink | null;
  readonly sharedState?: Record<string, unknown> | null;
  readonly progress?: ToolProgressEmitter | null;
  readonly eventBus?: ToolEventBusLike | null;
}

/**
 * AgentRuntime 是内部 Agent 的成熟 ReAct runtime。
 *
 * 它保留 legacy 主线已经验证过的关键能力：统一消息信封、ReAct 循环、
 * 工具白名单、预算/压缩检查、2-strike AI 错误恢复、强制总结、事件总线、
 * Hook、诊断和状态机。工具执行面只接入新的 lib/agent/tools，不再兼容旧
 * V1/V2 tool action。
 */
export class AgentRuntime {
  readonly #config: RuntimeConfig;
  readonly #aiTaskPlanner: AiTaskPlanner;
  readonly #hooks: HookSystem;
  readonly #toolPipeline: ToolExecutionPipeline;
  readonly #toolRegistry: ToolRegistryReader;
  readonly #bus: AgentEventBus;
  readonly #promptBuilder: SystemPromptBuilder;
  readonly #id: string;
  readonly #presetName: string;
  readonly #aiProvider: RuntimeAiProvider | null;
  readonly #modelRef: string | undefined;
  #state: AgentState;
  #fileCache: readonly FileCacheEntry[] | null = null;
  #toolCallHistory: ToolCallEntry[] = [];
  #aborted = false;

  constructor(config: RuntimeConfig, options: AgentRuntimeOptions = {}) {
    this.#config = config;
    this.#aiTaskPlanner = options.aiTaskPlanner ?? new AiTaskPlanner();
    this.#hooks = options.hooks ?? new HookSystem();
    this.#toolPipeline = options.toolPipeline ?? createToolPipeline();
    this.#toolRegistry = options.toolRegistry ?? createDefaultToolRegistry();
    this.#bus = options.eventBus ?? agentEventBus;
    this.#id = config.id ?? randomUUID();
    this.#presetName = config.presetName ?? "default";
    this.#aiProvider = config.gateway ?? config.aiProvider ?? null;
    this.#modelRef = config.modelRef;
    this.#state = new AgentState({
      initialData: { id: this.#id, presetName: this.#presetName },
    });
    this.#promptBuilder = new SystemPromptBuilder({
      persona: normalizePersona(config.persona),
      fileCache: this.#fileCache,
      lang: config.lang ?? null,
      memoryConfig: normalizeMemory(config.memory),
    });
    registerDefaultHooks(this.#hooks, this.#id, this.#bus);
  }

  get id(): string {
    return this.#id;
  }

  get presetName(): string {
    return this.#presetName;
  }

  get state(): AgentState {
    return this.#state;
  }

  get hooks(): HookSystem {
    return this.#hooks;
  }

  get projectRoot(): string | undefined {
    return this.#config.projectRoot;
  }

  get dataRoot(): string | undefined {
    return this.#config.dataRoot;
  }

  get fileCache(): readonly FileCacheEntry[] | null {
    return this.#fileCache;
  }

  setFileCache(files: readonly FileCacheEntry[] | null): void {
    this.#fileCache = files ? files.map((file) => ({ ...file })) : null;
    this.#promptBuilder.setFileCache(this.#fileCache);
  }

  abort(reason = "manual abort"): void {
    this.#aborted = true;
    this.#safeTransition("abort", { reason });
    this.#emitProgress("agent:aborted", { reason });
  }

  async planAiTasks(
    planWith: (planner: AiTaskPlanner) => AiTaskPlan | Promise<AiTaskPlan>,
    request: Omit<AgentRuntimeAiHookRequest, "plan"> = {},
  ): Promise<AgentRuntimeAiHookResult> {
    const plan = await planWith(this.#aiTaskPlanner);
    return this.acceptAiTaskPlan({ ...request, plan });
  }

  acceptAiTaskPlan(request: AgentRuntimeAiHookRequest): AgentRuntimeAiHookResult {
    const diagnostics = DiagnosticsCollector.from(request.diagnostics);
    const status = normalizePlanStatus(request.plan);
    if (status !== "ready") {
      diagnostics.recordGateFailure("ai.task", "degrade", request.plan.decision.reason);
      diagnostics.warn({
        code: "ai_task_plan_blocked",
        stage: "ai.task",
        message: request.plan.decision.reason,
      });
      return {
        status,
        blocked: true,
        degraded: true,
        ready: false,
        reason: request.plan.decision.reason,
        tasks: [],
        diagnostics: diagnostics.toJSON(),
        recipePublicationAttempted: false,
      };
    }

    const guardedParams = request.model
      ? ParameterGuard.guard(request.model, request.params ?? {})
      : undefined;
    if (guardedParams?.filtered.length) {
      diagnostics.warn({
        code: "ai_params_filtered",
        stage: "ai.task",
        message: `${guardedParams.filtered.length} AI parameter(s) filtered by ParameterGuard.`,
      });
    }

    return {
      status: "ready",
      blocked: false,
      degraded: false,
      ready: true,
      reason: request.plan.decision.reason,
      tasks: [...request.plan.tasks],
      ...(guardedParams ? { guardedParams } : {}),
      diagnostics: diagnostics.toJSON(),
      recipePublicationAttempted: false,
    };
  }

  allowedToolIds(requested?: readonly string[]): readonly string[] {
    const registeredNames: ReadonlySet<string> = new Set(
      this.#toolRegistry.list().map((definition) => definition.name),
    );
    const candidates = requested ?? this.#config.additionalTools ?? [...registeredNames];
    return [...new Set(candidates.filter((toolId) => registeredNames.has(toolId)))];
  }

  async execute(
    message: string | AgentMessageLike,
    opts: ReactLoopOpts = {},
  ): Promise<AgentResult> {
    const startedAt = Date.now();
    this.#aborted = false;
    this.#toolCallHistory = [];
    this.#state = new AgentState({
      initialData: { id: this.#id, presetName: this.#presetName },
    });
    const normalized = normalizeMessage(message);
    this.#safeTransition("start", {
      channel: normalized.channel,
      sender: normalized.sender,
      sessionId: normalized.session?.id,
    });
    this.#bus.publish(
      AgentEvents.STARTED,
      { agentId: this.#id, preset: this.#presetName },
      { source: this.#id },
    );
    this.#emitProgress("agent:started", {
      channel: normalized.channel,
      sessionId: normalized.session?.id,
    });

    try {
      this.#safeTransition("plan_ready");
      const history = opts.history ?? normalized.session?.history ?? [];
      const context = {
        ...(isRecord(opts.context) ? opts.context : {}),
        channel: normalized.channel,
        sender: normalized.sender,
        metadata: normalized.metadata,
        sessionId: normalized.session?.id,
      };
      const result = await this.reactLoop(normalized.content, {
        ...opts,
        history,
        context,
      });
      await replyToMessage(normalized, result.reply);
      this.#safeTransition("finish", { durationMs: Date.now() - startedAt });
      this.#emitProgress("agent:completed", {
        durationMs: Date.now() - startedAt,
        iterations: result.iterations,
        toolCallCount: result.toolCalls.length,
      });
      this.#bus.publish(AgentEvents.COMPLETED, result, { source: this.#id });
      return {
        ...result,
        durationMs: Date.now() - startedAt,
        state: this.#state.toJSON() as unknown as Record<string, unknown>,
      };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.#safeTransition("error", { error: messageText });
      this.#emitProgress("agent:failed", { error: messageText });
      this.#bus.publish(AgentEvents.FAILED, { error: messageText }, { source: this.#id });
      throw error;
    }
  }

  async reactLoop(prompt: string, opts: ReactLoopOpts = {}): Promise<AgentResult> {
    const startedAt = Date.now();
    const diagnostics = DiagnosticsCollector.from(opts.diagnostics);
    const context = isRecord(opts.context) ? opts.context : {};
    const budget = normalizeBudget({
      ...strategyBudget(this.#config.strategy),
      ...(this.#config.defaultBudget ?? {}),
      ...(opts.budgetOverride ?? {}),
    });
    const allowedToolIds = this.allowedToolIds(opts.additionalToolsOverride);
    const toolSchemas = this.#buildToolSchemas(allowedToolIds);
    const capabilities = this.#buildRuntimeCapabilities(allowedToolIds, opts.capabilityOverride);
    const messages = createMessageAdapter(opts.contextWindow);
    appendHistory(messages, opts.history);
    messages.appendUserMessage(prompt);

    let baseSystemPrompt =
      opts.systemPromptOverride ?? this.#promptBuilder.build(capabilities, context);
    baseSystemPrompt = SystemPromptBuilder.injectBudget(baseSystemPrompt, {
      source: opts.source ?? "user",
      tracker: opts.tracker,
      budget,
    });
    diagnostics.recordStageToolset({
      stage: opts.source ?? "agent-runtime",
      capabilities: capabilities.map((_, index) => `capability-${index + 1}`),
      allowedToolIds,
      toolSchemaCount: toolSchemas.length,
      ...(opts.source ? { source: opts.source } : {}),
    });

    const ctx = new LoopContext({
      messages,
      tracker: opts.tracker,
      trace: opts.trace,
      memoryCoordinator: opts.memoryCoordinator,
      sharedState: opts.sharedState ?? null,
      source: opts.source ?? "user",
      budget,
      capabilities,
      baseSystemPrompt,
      allowedToolIds,
      toolSchemas,
      prompt,
      onToolCall: opts.onToolCall ?? this.#config.onToolCall ?? null,
      context,
      contextWindow: opts.contextWindow,
      toolChoiceOverride: opts.toolChoiceOverride ?? null,
      abortSignal: opts.abortSignal ?? null,
      diagnostics,
    });
    ctx.budgetController = new BudgetController({
      maxSessionInputTokens: numberFrom(budget.maxSessionInputTokens, 0),
      cumulativeUsage: ctx.tokenUsage,
      contextWindow: asRuntimeContextWindow(opts.contextWindow),
      baseSystemPromptLength: baseSystemPrompt.length,
      toolSchemaCount: toolSchemas.length,
      ...(typeof budget.maxSessionTokens === "number"
        ? { maxSessionTokens: budget.maxSessionTokens }
        : {}),
    });
    ctx.exitController = createExitController(ctx, {
      validateDuring: (stepState) => {
        if (stepState.iteration > ctx.maxIterations) {
          return { ok: false, action: "stop", reason: "iteration budget exhausted" };
        }
        const maxSessionTokens = numberFrom(budget.maxSessionTokens, 0);
        if (maxSessionTokens > 0 && stepState.totalTokens > maxSessionTokens) {
          return { ok: false, action: "stop", reason: "session token budget exhausted" };
        }
        return this.#config.policies?.validateDuring(stepState) ?? { ok: true, action: "continue" };
      },
    });

    if (!this.#aiProvider) {
      diagnostics.recordGateFailure("llm", "degrade", "AI provider missing.");
      ctx.lastReply = await produceForcedSummary(ctx, {
        reason: "AI provider missing",
        systemPrompt: baseSystemPrompt,
      });
      return this.#buildAgentResult(ctx, startedAt);
    }

    let summaryReason: string | undefined;
    while (ctx.iteration < ctx.maxIterations) {
      if (this.#aborted || opts.abortSignal?.aborted) {
        summaryReason = "aborted";
        this.#safeTransition("abort", { reason: summaryReason });
        break;
      }
      ctx.iteration += 1;
      this.#state.update({ iteration: ctx.iteration });

      const beforeExit = ctx.exitController.checkBeforeIteration(ctx, ctx.tokenUsage);
      if (beforeExit.action === "exit") {
        summaryReason = beforeExit.detail ?? beforeExit.reason;
        await this.#emitExit(beforeExit, ctx);
        break;
      }

      await this.#hooks.emit("agent:iteration:before", {
        iteration: ctx.iteration,
        phase: this.#state.phase,
      });

      const compaction = ctx.budgetController.checkBeforeLLMCall(ctx.iteration);
      if (compaction.action === "compress") {
        await this.#hooks.emit("context:compact:after", {
          level: compaction.compaction.level,
          removed: compaction.compaction.removed,
          usage: compaction.sessionUsageRatio,
        });
      }
      if (ctx.budgetController.pendingL4 && this.#aiProvider) {
        const l4Compaction = await ctx.budgetController.executeL4IfPending(
          asL4CompactionProvider(this.#aiProvider),
        );
        if (l4Compaction.removed > 0) {
          await this.#hooks.emit("context:compact:after", {
            level: l4Compaction.level,
            removed: l4Compaction.removed,
            usage: ctx.budgetController.sessionUsageRatio,
          });
        }
      }

      const toolChoice = this.#resolveToolChoice(ctx);
      const llmResult = await this.#callLLM(ctx, toolChoice);
      const afterLLM = ctx.exitController.checkAfterLLM(llmResult, ctx);
      if (afterLLM.action === "retry") {
        diagnostics.recordEmptyResponse();
        ctx.consecutiveEmptyResponses += 1;
        ctx.messages.appendUserNudge("上一次响应为空，请继续并给出可执行的下一步或最终结论。");
        continue;
      }
      if (afterLLM.action === "exit") {
        summaryReason = afterLLM.detail ?? afterLLM.reason;
        await this.#emitExit(afterLLM, ctx);
        break;
      }
      if (!llmResult) {
        summaryReason = "empty_response";
        break;
      }

      ctx.budgetController.recordLLMUsage(llmResult.usage ?? {});
      ctx.consecutiveAiErrors = 0;
      ctx.consecutiveEmptyResponses = 0;

      const calls = normalizeFunctionCalls(llmResult.functionCalls);
      if (calls.length > 0) {
        const violation = ctx.exitController.checkToolChoiceViolation(llmResult);
        if (violation.action === "retry") {
          ctx.messages.appendUserNudge("当前阶段禁止工具调用，请直接输出最终总结。");
          continue;
        }
        if (violation.action === "exit" && llmResult.text) {
          ctx.lastReply = cleanFinalAnswer(llmResult.text);
          ctx.messages.appendAssistantText(ctx.lastReply, llmResult.reasoningContent);
          await this.#emitExit(violation, ctx);
          break;
        }
        await this.#processToolCalls(ctx, calls, llmResult);
        const afterTools = ctx.exitController.checkAfterToolCalls(ctx);
        await this.#hooks.emit("agent:iteration:after", {
          iteration: ctx.iteration,
          hadToolCalls: true,
          hadText: !!llmResult.text,
        });
        if (afterTools.action === "exit") {
          summaryReason = afterTools.detail ?? afterTools.reason;
          await this.#emitExit(afterTools, ctx);
          break;
        }
        continue;
      }

      if (llmResult.text?.trim()) {
        const answer = checkFinalAnswer(llmResult.text);
        ctx.lastReply = answer.cleanedText || llmResult.text.trim();
        ctx.messages.appendAssistantText(ctx.lastReply, llmResult.reasoningContent);
        await this.#hooks.emit("agent:iteration:after", {
          iteration: ctx.iteration,
          hadToolCalls: false,
          hadText: true,
        });
        await this.#emitExit({ action: "exit", reason: "task_complete" }, ctx);
        break;
      }

      diagnostics.recordEmptyResponse();
      ctx.consecutiveEmptyResponses += 1;
    }

    if (!ctx.lastReply) {
      ctx.lastReply = await produceForcedSummary(ctx, {
        aiProvider: this.#aiProvider,
        systemPrompt: baseSystemPrompt,
        reason: summaryReason ?? "loop stopped without final answer",
      });
    }

    await this.#hooks.emit("agent:finalize", {
      reply: ctx.lastReply,
      iterations: ctx.iteration,
      toolCallCount: ctx.toolCalls.length,
    });
    return this.#buildAgentResult(ctx, startedAt);
  }

  async executeToolCall(
    call: ToolCall,
    options: AgentRuntimeToolCallOptions = {},
  ): Promise<ToolExecutionResult> {
    const diagnostics = DiagnosticsCollector.from(options.diagnostics);
    return this.#toolPipeline.execute(call, {
      toolRouter: this.#config.toolRouter,
      allowedToolIds: this.allowedToolIds(options.allowedToolIds),
      iteration: options.iteration ?? 1,
      diagnostics,
      hooks: this.#hooks,
      source: options.source ?? "agent-runtime",
      onToolCall: options.onToolCall ?? this.#config.onToolCall ?? null,
      observationSink: options.observationSink ?? null,
      trackerSink: options.trackerSink ?? null,
      traceSink: options.traceSink ?? null,
      sharedState: options.sharedState ?? null,
      progress: options.progress ?? null,
      eventBus: options.eventBus ?? null,
      agentId: this.#id,
    });
  }

  async #callLLM(ctx: LoopContext, toolChoice: string): Promise<LLMResult | null> {
    if (!this.#aiProvider) {
      return null;
    }
    const options: RuntimeChatWithToolsOptions = {
      messages: ctx.messages.toProjectedMessages() as RuntimeChatMessage[],
      toolSchemas: ctx.toolSchemas,
      tools: ctx.toolSchemas,
      toolChoice,
      systemPrompt: ctx.baseSystemPrompt,
      temperature: numberFrom(ctx.budget.temperature, 0.7),
      maxTokens: numberFrom(ctx.budget.maxTokens, 4096),
      abortSignal: ctx.abortSignal,
      ...(this.#modelRef ? { modelRef: this.#modelRef } : {}),
    };
    await this.#hooks.emit("llm:call:before", { iteration: ctx.iteration, toolChoice });
    try {
      const result = await this.#aiProvider.chatWithTools(ctx.prompt, options);
      await this.#hooks.emit("llm:call:after", {
        iteration: ctx.iteration,
        hasToolCalls: (result?.functionCalls?.length ?? 0) > 0,
        hasText: !!result?.text,
        ...(result?.usage?.inputTokens !== undefined
          ? { inputTokens: result.usage.inputTokens }
          : {}),
        ...(result?.usage?.outputTokens !== undefined
          ? { outputTokens: result.usage.outputTokens }
          : {}),
      });
      return result;
    } catch (error) {
      const aiError = error as { readonly code?: string; readonly message?: string };
      ctx.consecutiveAiErrors += 1;
      ctx.diagnostics?.recordAiError(aiError.message ?? String(error));
      const signal = ctx.exitController?.checkAfterAiError(aiError, ctx);
      if (signal?.action === "retry") {
        ctx.messages.appendUserNudge("AI 调用失败，请恢复上下文后继续。");
        return { text: null, functionCalls: [] };
      }
      throw error;
    }
  }

  async #processToolCalls(
    ctx: LoopContext,
    calls: readonly FunctionCall[],
    llmResult: LLMResult,
  ): Promise<void> {
    const accepted = calls.slice(0, MAX_TOOL_CALLS_PER_ITER);
    const truncated = calls.length - accepted.length;
    ctx.diagnostics?.recordTruncatedToolCalls(truncated);
    ctx.messages.appendAssistantWithToolCalls(
      llmResult.text ?? null,
      accepted,
      llmResult.reasoningContent,
    );

    for (const call of accepted) {
      if (this.#aborted || ctx.abortSignal?.aborted) {
        break;
      }
      this.#bus.publish(
        AgentEvents.TOOL_CALL_STARTED,
        { name: call.name, args: call.args, iteration: ctx.iteration, callId: call.id },
        { source: this.#id },
      );
      const result = await this.executeToolCall(
        { id: call.id, name: call.name, args: call.args },
        {
          allowedToolIds: ctx.allowedToolIds,
          iteration: ctx.iteration,
          source: ctx.source,
          onToolCall: ctx.onToolCall,
          observationSink: asObservationSink(ctx.trace),
          trackerSink: asTrackerSink(ctx.tracker),
          traceSink: asTraceSink(ctx.trace),
          sharedState: ctx.sharedState,
          progress: (type, payload) => this.#emitProgress(type, payload),
          eventBus: this.#bus,
          ...(ctx.diagnostics ? { diagnostics: ctx.diagnostics } : {}),
        },
      );
      const content = ctx.messages.formatToolResult(call.name, result.result);
      ctx.messages.appendToolResult(call.id, call.name, content);
      ctx.budgetController?.recordToolCharsUsed(content.length);
      const entry: ToolCallEntry = {
        tool: call.name,
        name: call.name,
        args: call.args,
        result: result.result,
        ...(result.metadata.envelope ? { envelope: result.metadata.envelope } : {}),
        durationMs: result.metadata.durationMs,
      };
      ctx.toolCalls.push(entry);
      this.#toolCallHistory.push(entry);
      this.#bus.publish(
        AgentEvents.TOOL_CALL_COMPLETED,
        {
          name: call.name,
          ok: !result.metadata.blocked,
          durationMs: result.metadata.durationMs,
          iteration: ctx.iteration,
          callId: call.id,
        },
        { source: this.#id },
      );
      this.#emitProgress("tool:completed", {
        name: call.name,
        ok: !result.metadata.blocked,
        durationMs: result.metadata.durationMs,
        iteration: ctx.iteration,
      });
    }

    this.#safeTransition("step_done", { iteration: ctx.iteration });
    this.#safeTransition("continue");
  }

  #buildToolSchemas(allowedToolIds: readonly string[]): RuntimeToolSchema[] {
    return allowedToolIds.flatMap((toolId) => {
      const definition = this.#toolRegistry.get(toolId);
      if (!definition) {
        return [];
      }
      const parameters = definition.inputSchema as unknown as Record<string, unknown>;
      return [
        {
          name: definition.name,
          description: definition.description,
          parameters,
          type: "function",
          function: {
            name: definition.name,
            description: definition.description,
            parameters,
          },
        },
      ];
    });
  }

  #buildRuntimeCapabilities(
    allowedToolIds: readonly string[],
    capabilityOverride?: readonly string[],
  ): RuntimeCapability[] {
    const toolLines = allowedToolIds.map((toolId) => {
      const definition = this.#toolRegistry.get(toolId);
      return definition ? `- ${definition.name}: ${definition.description}` : `- ${toolId}`;
    });
    const capabilityLines = capabilityOverride?.length
      ? [`## 能力覆盖`, ...capabilityOverride.map((capability) => `- ${capability}`), ""]
      : [];
    return [
      ...((this.#config.capabilities as readonly RuntimeCapability[] | undefined) ?? []),
      {
        promptFragment: [
          "## 运行规则",
          "- 你是 Alembic 内部 Agent，使用 tool schemas 中给出的 resource.action 工具完成任务。",
          "- 只调用当前阶段允许的工具；不要请求 legacy V1/V2 tool 名称。",
          "- 工具结果不足时继续调查；信息足够时输出最终答案。",
          "",
          ...capabilityLines,
          "## 可用工具",
          toolLines.length ? toolLines.join("\n") : "当前阶段没有开放工具。",
        ].join("\n"),
      },
    ];
  }

  #resolveToolChoice(ctx: LoopContext): string {
    if (ctx.toolChoiceOverride && ctx.iteration === 1) {
      return ctx.toolChoiceOverride;
    }
    if (isTerminalTrackerPhase(ctx.tracker) || ctx.iteration >= ctx.maxIterations) {
      return "none";
    }
    return ctx.toolSchemas.length > 0 ? "auto" : "none";
  }

  #buildAgentResult(ctx: LoopContext, startedAt: number): AgentResult {
    return {
      ...ctx.buildResult(),
      durationMs: Date.now() - startedAt,
      ...(ctx.diagnostics ? { diagnostics: ctx.diagnostics.toJSON() } : {}),
      state: this.#state.toJSON() as unknown as Record<string, unknown>,
    };
  }

  async #emitExit(signal: ExitSignal, ctx: LoopContext): Promise<void> {
    await this.#hooks.emit("agent:exit", {
      reason: signal.reason ?? "unknown",
      iteration: ctx.iteration,
      ...(signal.detail ? { detail: signal.detail } : {}),
    });
  }

  #emitProgress(type: string, payload: Record<string, unknown> = {}): void {
    const event: ProgressEvent = {
      type,
      agentId: this.#id,
      preset: this.#presetName,
      timestamp: Date.now(),
      ...payload,
    };
    this.#config.onProgress?.(event);
    this.#bus.publish(AgentEvents.PROGRESS, event, { source: this.#id });
  }

  #safeTransition(event: string, payload: Record<string, unknown> = {}): void {
    const changed = this.#state.send(event, payload);
    if (changed) {
      this.#bus.publish(
        AgentEvents.STATE_CHANGED,
        { agentId: this.#id, state: this.#state.toJSON() },
        { source: this.#id },
      );
    }
  }
}

function normalizePlanStatus(plan: AiTaskPlan): AiTaskPlanStatus {
  if (plan.status === "ready" && plan.allowed) {
    return "ready";
  }
  return plan.status === "degraded" ? "degraded" : "blocked";
}

function normalizeBudget(input: unknown): LoopBudgetConfig {
  const record = isRecord(input) ? input : {};
  return {
    ...record,
    maxIterations: numberFrom(record.maxIterations, 20),
    maxTokens: numberFrom(record.maxTokens, 4096),
    temperature: numberFrom(record.temperature, 0.7),
    timeoutMs: numberFrom(record.timeoutMs, 0),
    maxSessionInputTokens: numberFrom(record.maxSessionInputTokens, 0),
    maxSessionTokens: numberFrom(record.maxSessionTokens, 0),
  };
}

function strategyBudget(strategy: unknown): Record<string, unknown> {
  if (!isRecord(strategy)) {
    return {};
  }
  const budget = isRecord(strategy.budget) ? strategy.budget : {};
  const defaultBudget = isRecord(strategy.defaultBudget) ? strategy.defaultBudget : {};
  return { ...defaultBudget, ...budget };
}

function normalizePersona(
  value: unknown,
): { readonly description?: string; readonly [key: string]: unknown } | null {
  return isRecord(value) ? value : null;
}

function normalizeMemory(
  value: unknown,
): { readonly mode?: string; readonly [key: string]: unknown } | null {
  return isRecord(value) ? value : null;
}

function normalizeMessage(message: string | AgentMessageLike): AgentMessageLike {
  if (typeof message === "string") {
    return { content: message };
  }
  return message;
}

async function replyToMessage(message: AgentMessageLike, text: string): Promise<void> {
  if (message.reply) {
    await message.reply(text);
    return;
  }
  await message.replyFn?.(text);
}

function appendHistory(
  messages: { appendUserMessage(text: string): void; appendAssistantText(text: string): void },
  history: ReactLoopOpts["history"],
): void {
  for (const item of history ?? []) {
    if (item.role === "assistant") {
      messages.appendAssistantText(item.content);
    } else if (item.role === "user") {
      messages.appendUserMessage(item.content);
    }
  }
}

function normalizeFunctionCalls(calls: LLMResult["functionCalls"]): FunctionCall[] {
  return (calls ?? []).map((call, index) => ({
    id: call.id || `call_${index + 1}`,
    name: call.name,
    args: normalizeArgs(call.args),
    ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
  }));
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(args) ? args : {};
}

function asRuntimeContextWindow(value: unknown): RuntimeContextWindow | null {
  if (!isRecord(value)) {
    return null;
  }
  return value as unknown as RuntimeContextWindow;
}

function asL4CompactionProvider(provider: RuntimeAiProvider): {
  chatWithTools(
    prompt: string,
    opts: Record<string, unknown>,
  ): Promise<{ readonly text?: string; readonly usage?: NonNullable<LLMResult["usage"]> } | null>;
} {
  return {
    async chatWithTools(prompt: string, opts: Record<string, unknown>) {
      const result = await provider.chatWithTools(prompt, opts);
      if (!result) {
        return null;
      }
      return {
        ...(result.text !== undefined ? { text: result.text ?? "" } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
  };
}

function asObservationSink(value: unknown): ToolObservationSink | null {
  if (isRecord(value) && typeof value.recordToolCall === "function") {
    return value as unknown as ToolObservationSink;
  }
  return null;
}

function asTrackerSink(value: unknown): ToolTrackerSink | null {
  if (isRecord(value) && typeof value.signalToolCall === "function") {
    return value as unknown as ToolTrackerSink;
  }
  return null;
}

function asTraceSink(value: unknown): ToolTraceSink | null {
  if (isRecord(value) && typeof value.recordToolCall === "function") {
    return value as unknown as ToolTraceSink;
  }
  return null;
}

function isTerminalTrackerPhase(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return value.phase === "SUMMARIZE" || value.phase === "FINALIZE" || value.isGracefulExit === true;
}

function numberFrom<TFallback extends number | undefined>(
  value: unknown,
  fallback: TFallback,
): number | TFallback {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export default AgentRuntime;

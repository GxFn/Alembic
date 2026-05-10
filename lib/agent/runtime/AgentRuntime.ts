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
import type { AgentDiagnostics, RuntimeConfig } from "./AgentRuntimeTypes.js";
import { DiagnosticsCollector } from "./DiagnosticsCollector.js";
import { HookSystem } from "./HookSystem.js";
import {
  createToolPipeline,
  type ToolCall,
  type ToolExecutionPipeline,
  type ToolExecutionResult,
} from "./ToolExecutionPipeline.js";

export interface AgentRuntimeOptions {
  readonly aiTaskPlanner?: AiTaskPlanner;
  readonly hooks?: HookSystem;
  readonly toolPipeline?: ToolExecutionPipeline;
  readonly toolRegistry?: ToolRegistryReader;
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
}

/**
 * AgentRuntime 当前只是 AI/Agent 接线骨架。
 *
 * 它接收 Mainline AiTaskPlanner 的 ready/blocked/degraded 计划结果，
 * 只做 runtime 诊断、参数守卫和工具白名单边界维护；这里不调用真实
 * provider，也不执行 Recipe 发布或知识写入。
 */
export class AgentRuntime {
  readonly #config: RuntimeConfig;
  readonly #aiTaskPlanner: AiTaskPlanner;
  readonly #hooks: HookSystem;
  readonly #toolPipeline: ToolExecutionPipeline;
  readonly #toolRegistry: ToolRegistryReader;

  constructor(config: RuntimeConfig, options: AgentRuntimeOptions = {}) {
    this.#config = config;
    this.#aiTaskPlanner = options.aiTaskPlanner ?? new AiTaskPlanner();
    this.#hooks = options.hooks ?? new HookSystem();
    this.#toolPipeline = options.toolPipeline ?? createToolPipeline();
    this.#toolRegistry = options.toolRegistry ?? createDefaultToolRegistry();
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
    });
  }
}

function normalizePlanStatus(plan: AiTaskPlan): AiTaskPlanStatus {
  if (plan.status === "ready" && plan.allowed) {
    return "ready";
  }
  return plan.status === "degraded" ? "degraded" : "blocked";
}

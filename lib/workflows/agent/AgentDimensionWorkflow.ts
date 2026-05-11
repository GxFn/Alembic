import {
  type AgentResult,
  AgentRuntime,
  type RuntimeAiProvider,
  type ToolRouterContract,
} from "../../agent/runtime/index.js";
import { ToolRouter, type ToolRuntimeDependencies } from "../../agent/tools/index.js";
import { mainlineRecipeImpactCandidates } from "../../mainline/compile/index.js";
import type { DimensionLensActivation } from "../../mainline/knowledge/index.js";
import type { ScanLifecycleResult } from "../scan/ScanLifecycleRunner.js";
import {
  type AgentWorkflowOutputType,
  type AgentWorkflowTaskTier,
  compareWorkflowTaskTier,
  WorkflowBriefingBuilder,
  type WorkflowTaskBriefing,
  workflowGapActivations,
} from "./WorkflowBriefingBuilder.js";

export type AgentWorkflowTaskKind = "dimension" | "evolution";
export type AgentWorkflowTaskStatus = "completed" | "degraded" | "failed";

export interface AgentWorkflowTask {
  readonly id: string;
  readonly kind: AgentWorkflowTaskKind;
  readonly tier: AgentWorkflowTaskTier;
  readonly label: string;
  readonly reason: string;
  readonly confidence: number;
  readonly outputType: AgentWorkflowOutputType;
  readonly admission: string;
  readonly briefing: WorkflowTaskBriefing;
  readonly gapSignals: readonly string[];
  readonly impactSignals: readonly string[];
  readonly prompt: string;
  readonly allowedToolIds: readonly string[];
  readonly sharedState?: Record<string, unknown>;
}

export interface AgentWorkflowTaskResult {
  readonly task: AgentWorkflowTask;
  readonly status: AgentWorkflowTaskStatus;
  readonly reply: string;
  readonly digest?: AgentDimensionDigest;
  readonly toolCallCount: number;
  readonly candidateCount: number;
  readonly durationMs: number;
  readonly warnings: readonly string[];
}

export interface AgentDimensionDigest {
  readonly summary?: string;
  readonly candidateCount?: number;
  readonly keyFindings?: readonly unknown[];
  readonly crossRefs?: Record<string, unknown>;
  readonly gaps?: readonly unknown[];
  readonly remainingTasks?: readonly unknown[];
  readonly skillWorthy?: boolean;
}

export interface AgentDimensionWorkflowInput {
  readonly scan: ScanLifecycleResult;
  readonly aiProvider?: RuntimeAiProvider | null;
  readonly toolRouter?: ToolRouterContract;
  readonly toolDependencies?: ToolRuntimeDependencies;
  readonly maxTasks?: number;
  readonly includeEvolution?: boolean;
  readonly source?: string;
  readonly abortSignal?: AbortSignal | null;
}

export interface AgentDimensionWorkflowResult {
  readonly status: "completed" | "degraded" | "failed";
  readonly mode: ScanLifecycleResult["mode"];
  readonly projectRoot: string;
  readonly tasks: readonly AgentWorkflowTask[];
  readonly results: readonly AgentWorkflowTaskResult[];
  readonly summary: {
    readonly totalTasks: number;
    readonly completedTasks: number;
    readonly degradedTasks: number;
    readonly failedTasks: number;
    readonly candidateCount: number;
    readonly toolCallCount: number;
  };
  readonly warnings: readonly string[];
}

const DIMENSION_TOOL_IDS = [
  "code.search",
  "code.read",
  "code.outline",
  "code.structure",
  "graph.overview",
  "graph.query",
  "knowledge.search",
  "knowledge.detail",
  "knowledge.submit",
  "memory.note_finding",
  "memory.get_previous_evidence",
  "meta.plan",
] as const;

const EVOLUTION_TOOL_IDS = ["knowledge.manage"] as const;

/**
 * AgentDimensionWorkflow 把扫描事实转成内部 Agent 可执行任务。
 * 中文注释：它只依赖新的 AgentRuntime 和 lib/agent/tools，不回连旧 DB、前端 taskManager 或 handler 兼容层。
 */
export class AgentDimensionWorkflow {
  async run(input: AgentDimensionWorkflowInput): Promise<AgentDimensionWorkflowResult> {
    const tasks = planAgentWorkflowTasks(input.scan, {
      ...(input.maxTasks === undefined ? {} : { maxTasks: input.maxTasks }),
      ...(input.includeEvolution === undefined ? {} : { includeEvolution: input.includeEvolution }),
    });
    const router =
      input.toolRouter ??
      new ToolRouter({
        dependencies: {
          projectRoot: input.scan.projectRoot,
          ...input.toolDependencies,
        },
      });
    const results: AgentWorkflowTaskResult[] = [];
    const warnings: string[] = [];

    for (const task of tasks) {
      const taskResult = await runTask({
        task,
        scan: input.scan,
        router,
        aiProvider: input.aiProvider ?? null,
        source: input.source ?? "system",
        abortSignal: input.abortSignal ?? null,
      });
      results.push(taskResult);
      warnings.push(...taskResult.warnings);
    }

    const summary = summarizeTaskResults(results);
    return {
      status:
        summary.failedTasks > 0 ? "failed" : summary.degradedTasks > 0 ? "degraded" : "completed",
      mode: input.scan.mode,
      projectRoot: input.scan.projectRoot,
      tasks,
      results,
      summary,
      warnings,
    };
  }
}

export function planAgentWorkflowTasks(
  scan: ScanLifecycleResult,
  options: { readonly maxTasks?: number; readonly includeEvolution?: boolean } = {},
): AgentWorkflowTask[] {
  const briefingBuilder = new WorkflowBriefingBuilder();
  const gapTasks = workflowGapActivations(scan).map((activation) =>
    dimensionTask(scan, activation, briefingBuilder),
  );
  const dimensionTasks = dimensionActivations(scan).map((activation) =>
    dimensionTask(scan, activation, briefingBuilder),
  );
  const evolutionTasks =
    options.includeEvolution === false ? [] : recipeEvolutionTasks(scan, briefingBuilder);
  const maxTasks = options.maxTasks ?? 8;
  return [...gapTasks, ...dimensionTasks, ...evolutionTasks]
    .sort(compareAgentWorkflowTasks)
    .slice(0, maxTasks);
}

async function runTask(input: {
  readonly task: AgentWorkflowTask;
  readonly scan: ScanLifecycleResult;
  readonly router: ToolRouterContract;
  readonly aiProvider: RuntimeAiProvider | null;
  readonly source: string;
  readonly abortSignal: AbortSignal | null;
}): Promise<AgentWorkflowTaskResult> {
  const startedAt = Date.now();
  const runtime = new AgentRuntime({
    id: `agent-workflow:${input.task.id}`,
    presetName: input.task.kind,
    projectRoot: input.scan.projectRoot,
    ...(input.scan.compile?.workspace.dataRoot === undefined
      ? {}
      : { dataRoot: input.scan.compile.workspace.dataRoot }),
    aiProvider: input.aiProvider,
    toolRouter: input.router,
    additionalTools: input.task.allowedToolIds,
    strategy: {
      budget: {
        maxIterations: input.task.briefing.budget.maxIterations,
        maxTokens: input.task.briefing.budget.maxTokens,
      },
    },
  });

  try {
    const result = await runtime.reactLoop(input.task.prompt, {
      source: input.source,
      additionalToolsOverride: input.task.allowedToolIds,
      context: {
        pipelineType: input.task.kind === "evolution" ? "evolution" : "bootstrap",
        dimensionId: input.task.id,
        projectRoot: input.scan.projectRoot,
        scanMode: input.scan.mode,
      },
      tracker: {
        pipelineType: input.task.kind === "evolution" ? "evolution" : "bootstrap",
        dimensionId: input.task.id,
      },
      sharedState: input.task.sharedState ?? {
        _dimensionScopeId: input.task.id,
        _dimensionMeta: {
          id: input.task.id,
          outputType: input.task.outputType,
        },
      },
      ...(input.abortSignal === null ? {} : { abortSignal: input.abortSignal }),
    });
    return presentTaskResult(input.task, result, {
      status: input.aiProvider ? "completed" : "degraded",
      startedAt,
      warnings: input.aiProvider ? [] : ["ai_provider_missing_for_agent_dimension"],
    });
  } catch (error) {
    return {
      task: input.task,
      status: "failed",
      reply: "",
      toolCallCount: 0,
      candidateCount: 0,
      durationMs: Date.now() - startedAt,
      warnings: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function dimensionActivations(scan: ScanLifecycleResult): readonly DimensionLensActivation[] {
  return scan.compile?.contentMining.lensActivations ?? [];
}

function dimensionTask(
  scan: ScanLifecycleResult,
  activation: DimensionLensActivation,
  briefingBuilder: WorkflowBriefingBuilder,
): AgentWorkflowTask {
  const lensId = String(activation.lensId);
  const briefing = briefingBuilder.buildDimension({ scan, activation });
  return {
    id: lensId,
    kind: "dimension",
    tier: briefing.tier,
    label: lensId,
    reason: activation.reason,
    confidence: activation.confidence,
    outputType: briefing.outputType,
    admission: briefing.admission,
    briefing,
    gapSignals: briefing.gapSignals,
    impactSignals: briefing.impactSignals,
    allowedToolIds: DIMENSION_TOOL_IDS,
    prompt: briefing.prompt,
  };
}

function recipeEvolutionTasks(
  scan: ScanLifecycleResult,
  briefingBuilder: WorkflowBriefingBuilder,
): AgentWorkflowTask[] {
  const impactPlan = scan.compile?.recipeImpact;
  if (!impactPlan || impactPlan.impacts.length === 0) {
    return [];
  }

  return mainlineRecipeImpactCandidates(impactPlan).map((impact) => {
    const briefing = briefingBuilder.buildEvolution({ scan, impact });
    return {
      id: `evolution:${impact.recipeId}`,
      kind: "evolution" as const,
      tier: briefing.tier,
      label: `Review ${impact.recipeTitle}`,
      reason: impact.reason,
      confidence: impact.impactScore,
      outputType: "decision" as const,
      admission: briefing.admission,
      briefing,
      gapSignals: briefing.gapSignals,
      impactSignals: briefing.impactSignals,
      allowedToolIds: EVOLUTION_TOOL_IDS,
      sharedState: { _evolutionDecisionOnly: true },
      prompt: briefing.prompt,
    };
  });
}

function presentTaskResult(
  task: AgentWorkflowTask,
  result: AgentResult,
  input: {
    readonly status: AgentWorkflowTaskStatus;
    readonly startedAt: number;
    readonly warnings: readonly string[];
  },
): AgentWorkflowTaskResult {
  const digest = parseDimensionDigest(result.reply);
  const submittedCandidates = result.toolCalls.filter((call) => call.tool === "knowledge.submit");
  return {
    task,
    status: input.status,
    reply: result.reply,
    ...(digest === undefined ? {} : { digest }),
    toolCallCount: result.toolCalls.length,
    candidateCount: digest?.candidateCount ?? submittedCandidates.length,
    durationMs: Date.now() - input.startedAt,
    warnings: input.warnings,
  };
}

function parseDimensionDigest(reply: string): AgentDimensionDigest | undefined {
  const jsonText = extractJson(reply);
  if (!jsonText) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (isRecord(parsed) && isRecord(parsed.dimensionDigest)) {
      return parsed.dimensionDigest as AgentDimensionDigest;
    }
    return isRecord(parsed) ? (parsed as AgentDimensionDigest) : undefined;
  } catch {
    return undefined;
  }
}

function extractJson(reply: string): string | null {
  const fenced = /```json\s*([\s\S]*?)```/i.exec(reply);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  return start >= 0 && end > start ? reply.slice(start, end + 1) : null;
}

function summarizeTaskResults(results: readonly AgentWorkflowTaskResult[]) {
  return {
    totalTasks: results.length,
    completedTasks: results.filter((result) => result.status === "completed").length,
    degradedTasks: results.filter((result) => result.status === "degraded").length,
    failedTasks: results.filter((result) => result.status === "failed").length,
    candidateCount: results.reduce((sum, result) => sum + result.candidateCount, 0),
    toolCallCount: results.reduce((sum, result) => sum + result.toolCallCount, 0),
  };
}

function compareAgentWorkflowTasks(left: AgentWorkflowTask, right: AgentWorkflowTask): number {
  return (
    compareWorkflowTaskTier(left.tier, right.tier) ||
    taskKindPriority(right.kind) - taskKindPriority(left.kind) ||
    right.confidence - left.confidence ||
    left.id.localeCompare(right.id)
  );
}

function taskKindPriority(kind: AgentWorkflowTaskKind): number {
  return kind === "evolution" ? 2 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

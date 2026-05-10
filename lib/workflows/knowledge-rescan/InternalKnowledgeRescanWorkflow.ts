import type { RuntimeAiProvider, ToolRouterContract } from "../../agent/runtime/index.js";
import type { ToolRuntimeDependencies } from "../../agent/tools/index.js";
import {
  AgentDimensionWorkflow,
  type AgentDimensionWorkflowResult,
} from "../agent/AgentDimensionWorkflow.js";
import {
  KnowledgeRescanWorkflow,
  type KnowledgeRescanWorkflowInput,
} from "./KnowledgeRescanWorkflow.js";

export interface InternalKnowledgeRescanWorkflowInput extends KnowledgeRescanWorkflowInput {
  readonly aiProvider?: RuntimeAiProvider | null;
  readonly toolRouter?: ToolRouterContract;
  readonly toolDependencies?: ToolRuntimeDependencies;
  readonly maxAgentTasks?: number;
  readonly skipAgentFill?: boolean;
  readonly includeEvolution?: boolean;
}

export interface InternalKnowledgeRescanWorkflowResult {
  readonly scan: Awaited<ReturnType<KnowledgeRescanWorkflow["run"]>>;
  readonly agent?: AgentDimensionWorkflowResult;
}

/**
 * InternalKnowledgeRescanWorkflow 组合增量扫描、gap 维度补齐和 Recipe evolution 决策任务。
 * 中文注释：Recipe impact 先来自 MainlineCompileSession，再投影为 AgentRuntime 的 decision-only 任务。
 */
export class InternalKnowledgeRescanWorkflow {
  readonly #rescan: KnowledgeRescanWorkflow;
  readonly #agentWorkflow: AgentDimensionWorkflow;
  readonly #toolDependencies: ToolRuntimeDependencies | undefined;

  constructor(
    options: {
      readonly rescan?: KnowledgeRescanWorkflow;
      readonly agentWorkflow?: AgentDimensionWorkflow;
      readonly toolDependencies?: ToolRuntimeDependencies;
    } = {},
  ) {
    this.#rescan = options.rescan ?? new KnowledgeRescanWorkflow();
    this.#agentWorkflow = options.agentWorkflow ?? new AgentDimensionWorkflow();
    this.#toolDependencies = options.toolDependencies;
  }

  async run(
    input: InternalKnowledgeRescanWorkflowInput,
  ): Promise<InternalKnowledgeRescanWorkflowResult> {
    const scan = await this.#rescan.run(input);
    if (input.skipAgentFill === true || scan.status !== "completed") {
      return { scan };
    }
    const agent = await this.#agentWorkflow.run({
      scan,
      aiProvider: input.aiProvider ?? null,
      ...(input.toolRouter === undefined ? {} : { toolRouter: input.toolRouter }),
      ...agentToolDependencies(this.#toolDependencies, input.toolDependencies),
      ...(input.maxAgentTasks === undefined ? {} : { maxTasks: input.maxAgentTasks }),
      includeEvolution: input.includeEvolution ?? true,
      source: "system",
    });
    return { scan, agent };
  }
}

export function runInternalKnowledgeRescanWorkflow(
  input: InternalKnowledgeRescanWorkflowInput,
): Promise<InternalKnowledgeRescanWorkflowResult> {
  return new InternalKnowledgeRescanWorkflow().run(input);
}

function agentToolDependencies(
  defaults: ToolRuntimeDependencies | undefined,
  override: ToolRuntimeDependencies | undefined,
): { readonly toolDependencies?: ToolRuntimeDependencies } {
  const merged =
    defaults === undefined && override === undefined ? undefined : { ...defaults, ...override };
  return merged === undefined ? {} : { toolDependencies: merged };
}

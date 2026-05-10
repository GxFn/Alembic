import type { RuntimeAiProvider, ToolRouterContract } from "../../agent/runtime/index.js";
import type { ToolRuntimeDependencies } from "../../agent/tools/index.js";
import {
  AgentDimensionWorkflow,
  type AgentDimensionWorkflowResult,
} from "../agent/AgentDimensionWorkflow.js";
import { ColdStartWorkflow, type ColdStartWorkflowInput } from "./ColdStartWorkflow.js";

export interface InternalColdStartWorkflowInput extends ColdStartWorkflowInput {
  readonly aiProvider?: RuntimeAiProvider | null;
  readonly toolRouter?: ToolRouterContract;
  readonly toolDependencies?: ToolRuntimeDependencies;
  readonly maxAgentTasks?: number;
  readonly skipAgentFill?: boolean;
}

export interface InternalColdStartWorkflowResult {
  readonly scan: Awaited<ReturnType<ColdStartWorkflow["run"]>>;
  readonly agent?: AgentDimensionWorkflowResult;
}

/**
 * InternalColdStartWorkflow 组合冷启动扫描与内部 Agent 维度补齐。
 * 中文注释：这是新仓库的纯主线入口，不依赖 legacy taskManager、Socket.io 或旧数据库容器。
 */
export class InternalColdStartWorkflow {
  readonly #coldStart: ColdStartWorkflow;
  readonly #agentWorkflow: AgentDimensionWorkflow;

  constructor(
    options: {
      readonly coldStart?: ColdStartWorkflow;
      readonly agentWorkflow?: AgentDimensionWorkflow;
    } = {},
  ) {
    this.#coldStart = options.coldStart ?? new ColdStartWorkflow();
    this.#agentWorkflow = options.agentWorkflow ?? new AgentDimensionWorkflow();
  }

  async run(input: InternalColdStartWorkflowInput): Promise<InternalColdStartWorkflowResult> {
    const scan = await this.#coldStart.run(input);
    if (input.skipAgentFill === true || scan.status !== "completed") {
      return { scan };
    }
    const agent = await this.#agentWorkflow.run({
      scan,
      aiProvider: input.aiProvider ?? null,
      ...(input.toolRouter === undefined ? {} : { toolRouter: input.toolRouter }),
      ...(input.toolDependencies === undefined ? {} : { toolDependencies: input.toolDependencies }),
      ...(input.maxAgentTasks === undefined ? {} : { maxTasks: input.maxAgentTasks }),
      includeEvolution: false,
      source: "system",
    });
    return { scan, agent };
  }
}

export function runInternalColdStartWorkflow(
  input: InternalColdStartWorkflowInput,
): Promise<InternalColdStartWorkflowResult> {
  return new InternalColdStartWorkflow().run(input);
}

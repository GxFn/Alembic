import type { RuntimeAiProvider, ToolRouterContract } from "../../agent/runtime/index.js";
import type { ToolRuntimeDependencies } from "../../agent/tools/index.js";
import {
  AgentDimensionWorkflow,
  type AgentDimensionWorkflowResult,
} from "../agent/AgentDimensionWorkflow.js";
import {
  DisabledWorkflowFinalizer,
  type WorkflowFinalizer,
  type WorkflowFinalizerResult,
} from "../finalizer/index.js";
import type { WorkflowReportReference, WorkflowReportStorePort } from "../report/index.js";
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
  readonly finalizer?: WorkflowFinalizerResult;
  readonly report?: WorkflowReportReference;
}

/**
 * InternalColdStartWorkflow 组合冷启动扫描与内部 Agent 维度补齐。
 * 中文注释：这是新仓库的纯主线入口，不依赖 legacy taskManager、Socket.io 或旧数据库容器。
 */
export class InternalColdStartWorkflow {
  readonly #coldStart: ColdStartWorkflow;
  readonly #agentWorkflow: AgentDimensionWorkflow;
  readonly #toolDependencies: ToolRuntimeDependencies | undefined;
  readonly #finalizer: WorkflowFinalizer;
  readonly #reportStore: WorkflowReportStorePort | undefined;

  constructor(
    options: {
      readonly coldStart?: ColdStartWorkflow;
      readonly agentWorkflow?: AgentDimensionWorkflow;
      readonly toolDependencies?: ToolRuntimeDependencies;
      readonly finalizer?: WorkflowFinalizer;
      readonly reportStore?: WorkflowReportStorePort;
    } = {},
  ) {
    this.#coldStart = options.coldStart ?? new ColdStartWorkflow();
    this.#agentWorkflow = options.agentWorkflow ?? new AgentDimensionWorkflow();
    this.#toolDependencies = options.toolDependencies;
    this.#finalizer = options.finalizer ?? new DisabledWorkflowFinalizer();
    this.#reportStore = options.reportStore;
  }

  async run(input: InternalColdStartWorkflowInput): Promise<InternalColdStartWorkflowResult> {
    const scan = await this.#coldStart.run(input);
    if (input.skipAgentFill === true || scan.status !== "completed") {
      return this.#finalize({ scan, source: "internal-cold-start" });
    }
    const agent = await this.#agentWorkflow.run({
      scan,
      aiProvider: input.aiProvider ?? null,
      ...(input.toolRouter === undefined ? {} : { toolRouter: input.toolRouter }),
      ...agentToolDependencies(this.#toolDependencies, input.toolDependencies),
      ...(input.maxAgentTasks === undefined ? {} : { maxTasks: input.maxAgentTasks }),
      includeEvolution: false,
      source: "system",
    });
    return this.#finalize({ scan, agent, source: "internal-cold-start" });
  }

  async #finalize(input: {
    readonly scan: Awaited<ReturnType<ColdStartWorkflow["run"]>>;
    readonly agent?: AgentDimensionWorkflowResult;
    readonly source: string;
  }): Promise<InternalColdStartWorkflowResult> {
    const finalizer = await this.#finalizer.run({
      kind: "bootstrap",
      projectRoot: input.scan.projectRoot,
      scan: input.scan,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
    });
    const report = await this.#reportStore?.save({
      kind: "bootstrap",
      scan: input.scan,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      finalizer,
      source: input.source,
    });
    return {
      scan: input.scan,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      finalizer,
      ...(report === undefined ? {} : { report }),
    };
  }
}

export function runInternalColdStartWorkflow(
  input: InternalColdStartWorkflowInput,
): Promise<InternalColdStartWorkflowResult> {
  return new InternalColdStartWorkflow().run(input);
}

function agentToolDependencies(
  defaults: ToolRuntimeDependencies | undefined,
  override: ToolRuntimeDependencies | undefined,
): { readonly toolDependencies?: ToolRuntimeDependencies } {
  const merged =
    defaults === undefined && override === undefined ? undefined : { ...defaults, ...override };
  return merged === undefined ? {} : { toolDependencies: merged };
}

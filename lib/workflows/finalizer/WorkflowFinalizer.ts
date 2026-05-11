import type { AgentDimensionWorkflowResult } from "../agent/AgentDimensionWorkflow.js";
import type { ScanLifecycleResult } from "../scan/ScanLifecycleRunner.js";

export type WorkflowFinalizerStepId = "delivery" | "wiki" | "panorama" | "semantic-memory";
export type WorkflowFinalizerStepStatus = "completed" | "skipped" | "failed";

export interface WorkflowFinalizerStep {
  readonly id: WorkflowFinalizerStepId;
  readonly status: WorkflowFinalizerStepStatus;
  readonly reason: string;
  readonly artifacts?: readonly string[];
}

export interface WorkflowFinalizerInput {
  readonly kind: ScanLifecycleResult["kind"];
  readonly projectRoot: string;
  readonly scan: ScanLifecycleResult;
  readonly agent?: AgentDimensionWorkflowResult;
}

export interface WorkflowFinalizerResult {
  readonly status: "completed" | "skipped" | "failed";
  readonly steps: readonly WorkflowFinalizerStep[];
  readonly summary: {
    readonly completedSteps: number;
    readonly skippedSteps: number;
    readonly failedSteps: number;
  };
  readonly warnings: readonly string[];
}

export interface WorkflowFinalizer {
  run(input: WorkflowFinalizerInput): Promise<WorkflowFinalizerResult>;
}

const DEFAULT_DISABLED_STEPS: readonly WorkflowFinalizerStepId[] = [
  "delivery",
  "wiki",
  "panorama",
  "semantic-memory",
];

/**
 * Codex 插件首阶段的 finalizer 只记录边界，不执行外部交付。
 * 中文注释：delivery/wiki/semantic-memory 都留成 port，避免把 legacy IDE 同步交付
 * 或 Wiki 生成副作用塞回冷启动/增量主事务。
 */
export class DisabledWorkflowFinalizer implements WorkflowFinalizer {
  async run(_input: WorkflowFinalizerInput): Promise<WorkflowFinalizerResult> {
    const steps = DEFAULT_DISABLED_STEPS.map((id) => ({
      id,
      status: "skipped" as const,
      reason: "disabled_for_codex_plugin_stage",
    }));
    return finalizerResult(steps, []);
  }
}

export function finalizerResult(
  steps: readonly WorkflowFinalizerStep[],
  warnings: readonly string[],
): WorkflowFinalizerResult {
  const failedSteps = steps.filter((step) => step.status === "failed").length;
  const skippedSteps = steps.filter((step) => step.status === "skipped").length;
  const completedSteps = steps.filter((step) => step.status === "completed").length;
  return {
    status: failedSteps > 0 ? "failed" : completedSteps > 0 ? "completed" : "skipped",
    steps,
    summary: {
      completedSteps,
      skippedSteps,
      failedSteps,
    },
    warnings,
  };
}

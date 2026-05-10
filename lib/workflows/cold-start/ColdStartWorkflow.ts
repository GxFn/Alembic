import type { MainlineSourceFileScanOptions } from "../../mainline/code/index.js";
import type { MainlineWorkspacePathInput } from "../../mainline/core/index.js";
import type { Recipe } from "../../mainline/knowledge/index.js";
import {
  type ScanLifecycleCleanupPolicy,
  type ScanLifecycleResult,
  ScanLifecycleRunner,
} from "../scan/ScanLifecycleRunner.js";
import type { MainlineWorkflowCancellationToken } from "../scan/ScanWorkflowKernel.js";

export interface ColdStartWorkflowInput {
  readonly projectRoot: string;
  readonly workspace?: Pick<
    MainlineWorkspacePathInput,
    "mode" | "dataRoot" | "projectId" | "homeDir"
  >;
  readonly scan?: Omit<MainlineSourceFileScanOptions, "root">;
  readonly recipes?: readonly Recipe[];
  readonly generatedAt?: number;
  readonly maxFileBytes?: number;
  readonly notes?: readonly string[];
  readonly cleanup?: Extract<ScanLifecycleCleanupPolicy, "full-reset" | "none">;
  readonly cancellation?: MainlineWorkflowCancellationToken;
}

/**
 * ColdStartWorkflow 是冷启动业务入口。
 * 中文注释：这里保留 full-reset + snapshot 编译语义，具体事实编译走 ScanLifecycleRunner。
 */
export class ColdStartWorkflow {
  readonly #runner: ScanLifecycleRunner;

  constructor(runner = new ScanLifecycleRunner()) {
    this.#runner = runner;
  }

  run(input: ColdStartWorkflowInput): Promise<ScanLifecycleResult> {
    return this.#runner.run({
      kind: "bootstrap",
      projectRoot: input.projectRoot,
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
      ...(input.scan === undefined ? {} : { scan: input.scan }),
      ...(input.recipes === undefined ? {} : { recipes: input.recipes }),
      ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
      ...(input.maxFileBytes === undefined ? {} : { maxFileBytes: input.maxFileBytes }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      cleanup: input.cleanup ?? "full-reset",
      source: "workflow",
      ...(input.cancellation === undefined ? {} : { cancellation: input.cancellation }),
    });
  }
}

export function runColdStartWorkflow(input: ColdStartWorkflowInput): Promise<ScanLifecycleResult> {
  return new ColdStartWorkflow().run(input);
}

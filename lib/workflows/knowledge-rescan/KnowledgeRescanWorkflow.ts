import type { MainlineSourceFileScanOptions } from "../../mainline/code/index.js";
import type { MainlineWorkspacePathInput } from "../../mainline/core/index.js";
import type { Recipe } from "../../mainline/knowledge/index.js";
import {
  type ScanLifecycleCleanupPolicy,
  type ScanLifecycleResult,
  ScanLifecycleRunner,
} from "../scan/ScanLifecycleRunner.js";
import type { MainlineWorkflowCancellationToken } from "../scan/ScanWorkflowKernel.js";

export interface KnowledgeRescanWorkflowInput {
  readonly projectRoot: string;
  readonly workspace?: Pick<
    MainlineWorkspacePathInput,
    "mode" | "dataRoot" | "projectId" | "homeDir"
  >;
  readonly scan?: Omit<MainlineSourceFileScanOptions, "root">;
  readonly changedFiles?: readonly string[];
  readonly removedFiles?: readonly string[];
  readonly diffTextByPath?: Record<string, string>;
  readonly recipes?: readonly Recipe[];
  readonly generatedAt?: number;
  readonly maxFileBytes?: number;
  readonly notes?: readonly string[];
  readonly dependentDepth?: number;
  readonly fullRebuildChangeRatio?: number;
  readonly cleanup?: Extract<ScanLifecycleCleanupPolicy, "rescan-clean" | "none">;
  readonly cancellation?: MainlineWorkflowCancellationToken;
}

/**
 * KnowledgeRescanWorkflow 是增量扫描业务入口。
 * 中文注释：它保留 rescan-clean、baseline、Recipe impact 和 SourceRef repair 的链路边界；
 * AI 进化审查和维度补齐后续接 agentRuntime，不塞回扫描底层。
 */
export class KnowledgeRescanWorkflow {
  readonly #runner: ScanLifecycleRunner;

  constructor(runner = new ScanLifecycleRunner()) {
    this.#runner = runner;
  }

  run(input: KnowledgeRescanWorkflowInput): Promise<ScanLifecycleResult> {
    return this.#runner.run({
      kind: "rescan",
      projectRoot: input.projectRoot,
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
      ...(input.scan === undefined ? {} : { scan: input.scan }),
      ...(input.changedFiles === undefined ? {} : { changedFiles: input.changedFiles }),
      ...(input.removedFiles === undefined ? {} : { removedFiles: input.removedFiles }),
      ...(input.diffTextByPath === undefined ? {} : { diffTextByPath: input.diffTextByPath }),
      ...(input.recipes === undefined ? {} : { recipes: input.recipes }),
      ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
      ...(input.maxFileBytes === undefined ? {} : { maxFileBytes: input.maxFileBytes }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      ...(input.dependentDepth === undefined ? {} : { dependentDepth: input.dependentDepth }),
      ...(input.fullRebuildChangeRatio === undefined
        ? {}
        : { fullRebuildChangeRatio: input.fullRebuildChangeRatio }),
      cleanup: input.cleanup ?? "rescan-clean",
      source: "workflow",
      ...(input.cancellation === undefined ? {} : { cancellation: input.cancellation }),
    });
  }
}

export function runKnowledgeRescanWorkflow(
  input: KnowledgeRescanWorkflowInput,
): Promise<ScanLifecycleResult> {
  return new KnowledgeRescanWorkflow().run(input);
}

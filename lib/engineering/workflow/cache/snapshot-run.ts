import type { EngineeringFile } from "../../foundation/types.js";
import { workflowDiagnostic } from "../core/core.js";
import { workflowStatus } from "../core/status.js";
import type { EngineeringWorkflowIncrementalPlan } from "../incremental/types.js";
import type {
  EngineeringWorkflowDiagnostic,
  EngineeringWorkflowFactBundle,
  EngineeringWorkflowInput,
  EngineeringWorkflowPhaseReport,
  EngineeringWorkflowResult,
  EngineeringWorkflowSnapshotRunSummary,
} from "../types.js";
import type { CacheEvaluationState } from "./evaluation.js";
import { snapshotDiagnosticsToWorkflow } from "./evaluation.js";
import type { EngineeringWorkflowFileInput } from "./types.js";

export interface WorkflowSnapshotSaveState {
  readonly summary: EngineeringWorkflowSnapshotRunSummary;
  readonly diagnostics: readonly EngineeringWorkflowDiagnostic[];
  readonly partial: boolean;
}

export function saveWorkflowSnapshot(
  input: EngineeringWorkflowInput,
  cacheState: CacheEvaluationState,
  facts: EngineeringWorkflowFactBundle,
  phaseReports: readonly EngineeringWorkflowPhaseReport[],
): WorkflowSnapshotSaveState {
  const baselineSnapshotId = cacheState.plan?.baselineSnapshotId ?? null;
  if (!input.snapshotStore || !cacheState.saveSnapshot) {
    return {
      summary: {
        baselineSnapshotId,
        snapshotId: null,
        saved: false,
        prunedIds: [],
      },
      diagnostics: [],
      partial: false,
    };
  }

  try {
    const write = input.snapshotStore.writeSnapshot({
      projectRoot: input.projectRoot,
      allFiles:
        cacheState.currentFiles.length > 0
          ? cacheState.currentFiles
          : snapshotFilesFromFacts(facts),
      dimensionStats:
        input.snapshotDimensionStats ??
        dimensionStatsFromIncrementalPlan(cacheState.plan, facts.files),
      meta: {
        durationMs: totalPhaseDuration(phaseReports),
        candidateCount: input.snapshotMeta?.candidateCount ?? facts.importFacts.length,
        primaryLang: input.snapshotMeta?.primaryLang ?? null,
      },
      sessionId: input.snapshotMeta?.sessionId ?? null,
      isIncremental:
        cacheState.plan !== null &&
        cacheState.plan.mode !== "full-rescan" &&
        cacheState.plan.baselineSnapshotId !== null,
      parentId: baselineSnapshotId,
      changedFiles: cacheState.plan?.affectedFiles ?? [],
      affectedDimensions: cacheState.plan?.affectedDimensions ?? [],
      status: snapshotStatusFromWorkflowStatus(workflowStatus(phaseReports)),
    });
    return {
      summary: {
        baselineSnapshotId,
        snapshotId: write.snapshotId,
        saved: write.snapshotId !== null,
        prunedIds: write.prunedIds,
      },
      diagnostics: snapshotDiagnosticsToWorkflow(write.diagnostics),
      partial: write.snapshotId === null || write.diagnostics.length > 0,
    };
  } catch (error: unknown) {
    return {
      summary: {
        baselineSnapshotId,
        snapshotId: null,
        saved: false,
        prunedIds: [],
      },
      diagnostics: [
        workflowDiagnostic("cache", "warning", "Engineering workflow snapshot write failed", error),
      ],
      partial: true,
    };
  }
}

function snapshotStatusFromWorkflowStatus(
  status: EngineeringWorkflowResult["status"],
): "complete" | "failed" | "partial" {
  switch (status) {
    case "success":
      return "complete";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
  }
}

function snapshotFilesFromFacts(
  facts: EngineeringWorkflowFactBundle,
): readonly EngineeringWorkflowFileInput[] {
  return facts.files.map((file) => ({
    path: file.path,
    relativePath: file.relativePath,
    content: facts.fileContents[file.relativePath] ?? facts.fileContents[file.path] ?? "",
    ...(file.targetName === undefined ? {} : { targetName: file.targetName }),
  }));
}

function dimensionStatsFromIncrementalPlan(
  plan: EngineeringWorkflowIncrementalPlan | null,
  files: readonly EngineeringFile[],
) {
  if (!plan || plan.affectedDimensions.length === 0) {
    return {};
  }
  const filePaths = files.map((file) => file.relativePath || file.path);
  return Object.fromEntries(
    plan.affectedDimensions.map((dimensionId) => [
      dimensionId,
      {
        referencedFiles: filePaths.length,
        referencedFilesList: filePaths,
      },
    ]),
  );
}

function totalPhaseDuration(phaseReports: readonly EngineeringWorkflowPhaseReport[]): number {
  return phaseReports.reduce((total, phase) => total + phase.timing.durationMs, 0);
}

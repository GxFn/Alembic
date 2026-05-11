import { isEngineeringGeneratedArtifact, workflowDiagnostic } from "../core/core.js";
import { EngineeringProjectIntelligenceIncrementalPlanner } from "../incremental/intelligence-planner.js";
import type {
  EngineeringWorkflowIncrementalMode,
  EngineeringWorkflowIncrementalPlan,
} from "../incremental/types.js";
import type {
  EngineeringWorkflowBaselineSelector,
  EngineeringWorkflowDiagnostic,
  EngineeringWorkflowDiscoveryResult,
  EngineeringWorkflowInput,
} from "../types.js";
import {
  computeEngineeringWorkflowFileDiff,
  EngineeringWorkflowFileDiffPlanner,
} from "./diff-planner.js";
import type {
  EngineeringWorkflowFileDiff,
  EngineeringWorkflowFileInput,
  EngineeringWorkflowSnapshot,
  EngineeringWorkflowSnapshotDiagnostic,
} from "./types.js";

type CacheEvaluationStatus = "disabled" | "planned";

export interface CacheEvaluationState {
  readonly status: CacheEvaluationStatus;
  readonly plan: EngineeringWorkflowIncrementalPlan | null;
  readonly baseline: EngineeringWorkflowSnapshot | null;
  readonly currentFiles: readonly EngineeringWorkflowFileInput[];
  readonly diagnostics: readonly EngineeringWorkflowDiagnostic[];
  readonly partial: boolean;
  readonly saveSnapshot: boolean;
}

export function disabledCacheState(): CacheEvaluationState {
  return {
    status: "disabled",
    plan: null,
    baseline: null,
    currentFiles: [],
    diagnostics: [],
    partial: false,
    saveSnapshot: false,
  };
}

export function evaluateCacheAndIncremental(
  input: EngineeringWorkflowInput,
  discovery: EngineeringWorkflowDiscoveryResult,
): CacheEvaluationState {
  const options = normalizeIncrementalOptions(input);
  if (!options.enabled) {
    return disabledCacheState();
  }

  const currentFiles = currentFingerprintFiles(input, discovery);
  if (!input.snapshotStore) {
    return {
      status: "planned",
      plan: forcedFullRescanPlan(
        "Incremental requested without snapshotStore; full rescan required",
        options.allDimensions,
      ),
      baseline: null,
      currentFiles,
      diagnostics: [
        workflowDiagnostic(
          "cache",
          "warning",
          "Incremental requested without snapshotStore; falling back to full rescan",
        ),
      ],
      partial: true,
      saveSnapshot: false,
    };
  }

  const baselineEvaluation = evaluateBaselineDiff(input, currentFiles, options);
  const plan = new EngineeringProjectIntelligenceIncrementalPlanner().plan({
    projectRoot: input.projectRoot,
    snapshot: baselineEvaluation.snapshot,
    diff: baselineEvaluation.diff,
    allDimensions: options.allDimensions,
    ...(options.fullRescanThreshold === undefined
      ? {}
      : { fullRescanThreshold: options.fullRescanThreshold }),
  });
  const effectivePlan = applyModeOverride(plan, options.mode);
  const diagnostics = [
    ...snapshotDiagnosticsToWorkflow(baselineEvaluation.diagnostics),
    ...snapshotDiagnosticsToWorkflow(effectivePlan.diagnostics),
  ];

  return {
    status: "planned",
    plan: effectivePlan,
    baseline: baselineEvaluation.snapshot,
    currentFiles,
    diagnostics,
    partial: diagnostics.some((diagnostic) => diagnostic.severity !== "info"),
    saveSnapshot: options.saveSnapshot,
  };
}

export function cachePhaseSummary(state: CacheEvaluationState): Readonly<Record<string, unknown>> {
  return {
    enabled: state.status !== "disabled",
    mode: state.plan?.mode ?? null,
    reason: state.plan?.reason ?? null,
    baselineSnapshotId: state.plan?.baselineSnapshotId ?? null,
    affectedFiles: state.plan?.affectedFiles.length ?? 0,
    affectedModules: state.plan?.affectedModules.length ?? 0,
    affectedDimensions: state.plan?.affectedDimensions.length ?? 0,
    skippedDimensions: state.plan?.skippedDimensions.length ?? 0,
    generatedSkipped: state.plan?.diff?.generatedSkipped.length ?? 0,
    saveSnapshot: state.saveSnapshot,
  };
}

export function filterDiscoveryByAffectedFiles(
  discovery: EngineeringWorkflowDiscoveryResult,
  affectedFiles: readonly string[],
): EngineeringWorkflowDiscoveryResult {
  const affected = new Set(affectedFiles);
  return {
    ...discovery,
    files: discovery.files.filter(
      (file) => affected.has(file.relativePath) || affected.has(file.path),
    ),
    diagnostics: [
      ...(discovery.diagnostics ?? []),
      workflowDiagnostic(
        "cache",
        "warning",
        // 中文说明：纯 runner 只能缩小本次重扫范围，不能自行拼回历史事实。
        "Targeted rescan filters discovery files to affected paths; unaffected fact reuse requires an external adapter.",
      ),
    ],
  };
}

export function snapshotDiagnosticsToWorkflow(
  diagnostics: readonly EngineeringWorkflowSnapshotDiagnostic[],
): readonly EngineeringWorkflowDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    phase: "cache",
    severity: snapshotDiagnosticSeverity(diagnostic.severity),
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.paths === undefined ? {} : { cause: diagnostic.paths.join(", ") }),
  }));
}

function normalizeIncrementalOptions(input: EngineeringWorkflowInput): {
  readonly enabled: boolean;
  readonly mode: "auto" | EngineeringWorkflowIncrementalMode;
  readonly baselineSelector: EngineeringWorkflowBaselineSelector;
  readonly allDimensions: readonly string[];
  readonly fullRescanThreshold?: number;
  readonly saveSnapshot: boolean;
} {
  const raw = input.incremental;
  const objectOptions = typeof raw === "object" && raw !== null ? raw : {};
  const baselineSelector =
    objectOptions.baselineSelector ??
    input.baselineSelector ??
    ((objectOptions.baselineSnapshotId ?? input.baselineSnapshotId)
      ? { id: objectOptions.baselineSnapshotId ?? input.baselineSnapshotId ?? "" }
      : "latest");
  const enabled =
    typeof raw === "boolean"
      ? raw
      : (objectOptions.enabled ??
        (input.snapshotStore !== undefined || input.baselineSnapshotId !== undefined));

  return {
    enabled,
    mode: objectOptions.mode ?? "auto",
    baselineSelector,
    allDimensions: objectOptions.allDimensions ?? input.dimensionIds ?? [],
    ...(objectOptions.fullRescanThreshold === undefined
      ? {}
      : { fullRescanThreshold: objectOptions.fullRescanThreshold }),
    saveSnapshot: objectOptions.saveSnapshot ?? input.snapshotStore !== undefined,
  };
}

function evaluateBaselineDiff(
  input: EngineeringWorkflowInput,
  currentFiles: readonly EngineeringWorkflowFileInput[],
  options: ReturnType<typeof normalizeIncrementalOptions>,
): {
  readonly snapshot: EngineeringWorkflowSnapshot | null;
  readonly diff: EngineeringWorkflowFileDiff | null;
  readonly diagnostics: readonly EngineeringWorkflowSnapshotDiagnostic[];
} {
  const store = input.snapshotStore;
  if (!store) {
    return { snapshot: null, diff: null, diagnostics: [] };
  }
  if (options.baselineSelector !== "latest") {
    const baseline = store.readSnapshot(options.baselineSelector.id);
    return {
      snapshot: baseline.snapshot,
      diff: baseline.snapshot
        ? computeEngineeringWorkflowFileDiff({
            projectRoot: input.projectRoot,
            snapshot: baseline.snapshot,
            currentFiles,
          })
        : null,
      diagnostics: baseline.diagnostics,
    };
  }

  const evaluation = new EngineeringWorkflowFileDiffPlanner(store).evaluate({
    projectRoot: input.projectRoot,
    currentFiles,
  });
  return {
    snapshot: evaluation.snapshot,
    diff: evaluation.diff,
    diagnostics: evaluation.diagnostics,
  };
}

function forcedFullRescanPlan(
  reason: string,
  allDimensions: readonly string[],
): EngineeringWorkflowIncrementalPlan {
  return {
    mode: "full-rescan",
    reason,
    baselineSnapshotId: null,
    affectedFiles: [],
    affectedModules: [],
    affectedDimensions: allDimensions,
    skippedDimensions: [],
    diagnostics: [],
    diff: null,
  };
}

function applyModeOverride(
  plan: EngineeringWorkflowIncrementalPlan,
  mode: "auto" | EngineeringWorkflowIncrementalMode,
): EngineeringWorkflowIncrementalPlan {
  if (mode === "auto" || mode === plan.mode) {
    return plan;
  }
  return {
    ...plan,
    mode,
    reason: `Incremental mode forced to ${mode}; planner recommendation was ${plan.mode}: ${plan.reason}`,
  };
}

function currentFingerprintFiles(
  input: EngineeringWorkflowInput,
  discovery: EngineeringWorkflowDiscoveryResult,
): readonly EngineeringWorkflowFileInput[] {
  if (input.currentFingerprints) {
    return input.currentFingerprints;
  }
  return discovery.files.map((file) => {
    const content =
      input.fileContents?.[file.relativePath] ?? input.fileContents?.[file.path] ?? "";
    const fileInput: EngineeringWorkflowFileInput = {
      path: file.path,
      relativePath: file.relativePath,
      content,
      isGenerated:
        isEngineeringGeneratedArtifact(file.relativePath) ||
        isEngineeringGeneratedArtifact(file.path),
    };
    return {
      ...fileInput,
      ...(file.targetName === undefined ? {} : { targetName: file.targetName }),
    };
  });
}

function snapshotDiagnosticSeverity(
  severity: EngineeringWorkflowSnapshotDiagnostic["severity"],
): EngineeringWorkflowDiagnostic["severity"] {
  switch (severity) {
    case "error":
      return "error";
    case "warn":
      return "warning";
    case "info":
      return "info";
  }
}

import { CallGraphAnalyzer } from "../code/analysis/index.js";
import { EngineeringCodeGraph } from "../code/EngineeringCodeGraph.js";
import type {
  EngineeringCodeAstFileSummaryInput,
  EngineeringCodeAstSummaryInput,
  EngineeringCodeCallGraphEdge,
  EngineeringCodeDataFlowEdge,
} from "../code/EngineeringCodeGraphModel.js";
import { createDefaultDiscovererRegistry } from "../discovery/index.js";
import { EngineeringEntityGraph } from "../entity/EngineeringEntityGraph.js";
import type {
  EngineeringDependencyGraph,
  EngineeringDiscoverer,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/EngineeringCoreTypes.js";
import type { EngineeringImportFact } from "../panorama/EngineeringModuleDiscoverer.js";
import { EngineeringPanoramaService } from "../panorama/EngineeringPanoramaService.js";
import type {
  EngineeringWorkflowFileDiff,
  EngineeringWorkflowFileInput,
  EngineeringWorkflowSnapshot,
  EngineeringWorkflowSnapshotDiagnostic,
} from "./cache/EngineeringWorkflowCacheTypes.js";
import {
  computeEngineeringWorkflowFileDiff,
  EngineeringWorkflowFileDiffPlanner,
} from "./cache/FileDiffPlanner.js";
import {
  isEngineeringGeneratedArtifact,
  phaseReport,
  runWorkflowPhase,
  withPhaseReport,
  workflowDiagnostic,
} from "./core/EngineeringWorkflowCore.js";
import type {
  EngineeringEntityGraphSnapshot,
  EngineeringWorkflowArtifact,
  EngineeringWorkflowBaselineSelector,
  EngineeringWorkflowCapabilities,
  EngineeringWorkflowDiagnostic,
  EngineeringWorkflowDiscoveryResult,
  EngineeringWorkflowFactBundle,
  EngineeringWorkflowInput,
  EngineeringWorkflowPhaseReport,
  EngineeringWorkflowResult,
  EngineeringWorkflowSnapshotRunSummary,
} from "./EngineeringWorkflowTypes.js";
import type {
  EngineeringWorkflowIncrementalMode,
  EngineeringWorkflowIncrementalPlan,
} from "./incremental/EngineeringWorkflowIncrementalTypes.js";
import { EngineeringProjectIntelligenceIncrementalPlanner } from "./incremental/ProjectIntelligenceIncrementalPlanner.js";
import type {
  EngineeringWorkflowOptionalDiagnostic,
  EngineeringWorkflowOptionalDimension,
  EngineeringWorkflowOptionalStageInput,
} from "./optional/EngineeringWorkflowOptionalTypes.js";
import { runEngineeringWorkflowOptionalStage } from "./optional/OptionalStage.js";

const EMPTY_DEPENDENCY_GRAPH: EngineeringDependencyGraph = { nodes: [], edges: [] };

export class EngineeringWorkflowRunner {
  async run(input: EngineeringWorkflowInput): Promise<EngineeringWorkflowResult> {
    const phaseReports: EngineeringWorkflowPhaseReport[] = [];
    const diagnostics: EngineeringWorkflowDiagnostic[] = [];
    let truncated = false;

    const discoveryPhase = await runWorkflowPhase("discover", () => discoverProject(input));
    const discovery = discoveryPhase.ok ? discoveryPhase.value : emptyDiscovery();
    if (!discoveryPhase.ok) {
      diagnostics.push(
        workflowDiagnostic(
          "discover",
          "error",
          "Discovery failed; continuing with empty facts",
          discoveryPhase.error,
        ),
      );
    }
    truncated = truncated || Boolean(discovery.truncated);
    diagnostics.push(...(discovery.diagnostics ?? []));
    phaseReports.push(
      withPhaseReport(discoveryPhase.report, {
        status: discoveryPhase.ok
          ? phaseStatus(discovery.diagnostics ?? [], Boolean(discovery.truncated))
          : "failed",
        diagnostics: [...discoveryPhase.report.diagnostics, ...(discovery.diagnostics ?? [])],
        summary: {
          targets: discovery.targets.length,
          files: discovery.files.length,
          dependencyNodes: discovery.dependencyGraph.nodes.length,
          dependencyEdges: discovery.dependencyGraph.edges.length,
          discovererId: discovery.discovererId ?? null,
          truncated: Boolean(discovery.truncated),
        },
      }),
    );

    const cachePhase = await runWorkflowPhase("cache", () =>
      evaluateCacheAndIncremental(input, discovery),
    );
    const cacheState = cachePhase.ok ? cachePhase.value : disabledCacheState();
    if (!cachePhase.ok) {
      diagnostics.push(
        workflowDiagnostic(
          "cache",
          "warning",
          "Cache/incremental evaluation failed; falling back to full rescan",
          cachePhase.error,
        ),
      );
    }
    diagnostics.push(...cacheState.diagnostics);
    let cacheReport = withPhaseReport(cachePhase.report, {
      status:
        cacheState.status === "disabled"
          ? "skipped"
          : phaseStatus(cacheState.diagnostics, cacheState.partial),
      diagnostics: [...cachePhase.report.diagnostics, ...cacheState.diagnostics],
      summary: cachePhaseSummary(cacheState),
    });
    phaseReports.push(cacheReport);

    const incrementalPlan = cacheState.plan;
    const executionMode = incrementalPlan?.mode ?? "full-rescan";
    const effectiveDiscovery =
      executionMode === "targeted-rescan" && incrementalPlan
        ? filterDiscoveryByAffectedFiles(discovery, incrementalPlan.affectedFiles)
        : discovery;
    const targetedReuseDiagnostics =
      executionMode === "targeted-rescan"
        ? [
            workflowDiagnostic(
              "cache",
              "warning",
              "Targeted rescan selected, but this pure workflow runner cannot reuse unaffected historical facts without an external artifact adapter; the returned artifact contains only rescanned facts.",
            ),
          ]
        : [];
    diagnostics.push(...targetedReuseDiagnostics);
    if (targetedReuseDiagnostics.length > 0) {
      cacheReport = withPhaseReport(cacheReport, {
        status: phaseStatus([...cacheReport.diagnostics, ...targetedReuseDiagnostics], true),
        diagnostics: [...cacheReport.diagnostics, ...targetedReuseDiagnostics],
      });
      phaseReports[phaseReports.length - 1] = cacheReport;
    }

    let facts: EngineeringWorkflowFactBundle;
    if (executionMode === "skip") {
      facts = discoveryShellFacts(input, discovery);
      phaseReports.push(
        skippedWorkflowPhase("collectFacts", {
          mode: executionMode,
          files: facts.files.length,
          reason: incrementalPlan?.reason ?? "Incremental plan skipped fact collection",
        }),
      );
    } else {
      const factsPhase = await runWorkflowPhase("collectFacts", () =>
        collectFacts(input, effectiveDiscovery),
      );
      facts = factsPhase.ok ? factsPhase.value : emptyFacts();
      if (!factsPhase.ok) {
        diagnostics.push(
          workflowDiagnostic(
            "collectFacts",
            "error",
            "Fact collection failed; continuing with discovery files only",
            factsPhase.error,
          ),
        );
        facts = {
          ...facts,
          files: effectiveDiscovery.files,
          ...(input.astSummaries === undefined ? {} : { astSummaries: input.astSummaries }),
        };
      }
      truncated = truncated || facts.files.length < effectiveDiscovery.files.length;
      phaseReports.push(
        withPhaseReport(factsPhase.report, {
          status: factsPhase.ok
            ? facts.generatedArtifactPaths.length > 0 ||
              facts.files.length < effectiveDiscovery.files.length
              ? "partial"
              : "success"
            : "failed",
          diagnostics: facts.generatedArtifactPaths.map((filePath) =>
            workflowDiagnostic("collectFacts", "info", `Skipped generated artifact ${filePath}`),
          ),
          summary: {
            mode: executionMode,
            files: facts.files.length,
            importFacts: facts.importFacts.length,
            fileContents: Object.keys(facts.fileContents).length,
            generatedArtifacts: facts.generatedArtifactPaths.length,
            astSummaries: countAstSummaries(facts.astSummaries),
          },
        }),
      );
    }

    let graphs: ReturnType<typeof buildEmptyGraphs> | ReturnType<typeof buildGraphs>;
    if (executionMode === "skip" || executionMode === "panorama-only") {
      graphs = buildEmptyGraphs(
        effectiveDiscovery.targets,
        facts.files,
        effectiveDiscovery.dependencyGraph,
      );
      phaseReports.push(
        skippedWorkflowPhase("buildGraphs", {
          mode: executionMode,
          reason:
            executionMode === "panorama-only"
              ? "Incremental plan requested panorama-only refresh"
              : (incrementalPlan?.reason ?? "Incremental plan skipped graph build"),
          codeFiles: graphs.codeGraph.toJSON().files.length,
        }),
      );
    } else {
      const graphPhase = await runWorkflowPhase("buildGraphs", () =>
        buildGraphs(input, effectiveDiscovery, facts),
      );
      graphs = graphPhase.ok
        ? graphPhase.value
        : buildEmptyGraphs(
            effectiveDiscovery.targets,
            facts.files,
            effectiveDiscovery.dependencyGraph,
          );
      if (!graphPhase.ok) {
        diagnostics.push(
          workflowDiagnostic(
            "buildGraphs",
            "error",
            "Graph build failed; continuing with empty graphs",
            graphPhase.error,
          ),
        );
      }
      diagnostics.push(...graphs.diagnostics);
      phaseReports.push(
        withPhaseReport(graphPhase.report, {
          status: graphPhase.ok ? phaseStatus(graphs.diagnostics, graphs.partial) : "failed",
          diagnostics: [...graphPhase.report.diagnostics, ...graphs.diagnostics],
          summary: {
            mode: executionMode,
            codeFiles: graphs.codeGraph.toJSON().files.length,
            callEdges: graphs.callGraph.length,
            dataFlowEdges: graphs.dataFlow.length,
            entities: graphs.entityGraphSnapshot.entities.length,
            entityEdges: graphs.entityGraphSnapshot.edges.length,
          },
        }),
      );
    }

    let panoramaSnapshot: EngineeringWorkflowArtifact["panoramaSnapshot"];
    if (executionMode === "skip") {
      panoramaSnapshot = null;
      phaseReports.push(
        skippedWorkflowPhase("panorama", {
          mode: executionMode,
          reason: incrementalPlan?.reason ?? "Incremental plan skipped panorama refresh",
        }),
      );
    } else {
      const panoramaPhase = await runWorkflowPhase("panorama", () =>
        buildPanorama(input, facts, effectiveDiscovery.dependencyGraph, graphs.codeGraph),
      );
      panoramaSnapshot = panoramaPhase.ok ? panoramaPhase.value : null;
      if (!panoramaPhase.ok) {
        diagnostics.push(
          workflowDiagnostic(
            "panorama",
            "error",
            "Panorama failed; artifact remains usable without snapshot",
            panoramaPhase.error,
          ),
        );
      }
      phaseReports.push(
        withPhaseReport(panoramaPhase.report, {
          status: panoramaPhase.ok ? "success" : "failed",
          summary: {
            mode: executionMode,
            modules: panoramaSnapshot?.modules.length ?? 0,
            relationships: panoramaSnapshot?.relationships.moduleEdges.length ?? 0,
            stale: panoramaSnapshot?.stale ?? false,
          },
        }),
      );
    }

    const optionalStage =
      executionMode === "skip"
        ? skippedOptionalStageArtifact(
            incrementalPlan?.reason ?? "Incremental plan skipped optional stage",
          )
        : await runOptionalStagePhase({
            input,
            facts,
            panoramaSnapshot,
            generatedArtifactPaths: facts.generatedArtifactPaths,
          });
    if (optionalStage.workflowDiagnostics.length > 0) {
      diagnostics.push(...optionalStage.workflowDiagnostics);
    }
    phaseReports.push(optionalStage.phaseReport);

    const snapshotSummary = saveWorkflowSnapshot(input, cacheState, facts, phaseReports);
    if (snapshotSummary.diagnostics.length > 0) {
      diagnostics.push(...snapshotSummary.diagnostics);
      const cacheIndex = phaseReports.findIndex((report) => report.name === "cache");
      if (cacheIndex >= 0) {
        const existingCacheReport = phaseReports[cacheIndex];
        if (existingCacheReport) {
          cacheReport = withPhaseReport(existingCacheReport, {
            status: phaseStatus(
              [...existingCacheReport.diagnostics, ...snapshotSummary.diagnostics],
              cacheState.partial || snapshotSummary.partial,
            ),
            diagnostics: [...existingCacheReport.diagnostics, ...snapshotSummary.diagnostics],
            summary: {
              ...existingCacheReport.summary,
              snapshotId: snapshotSummary.summary.snapshotId,
              snapshotSaved: snapshotSummary.summary.saved,
              prunedIds: snapshotSummary.summary.prunedIds,
            },
          });
        }
        phaseReports[cacheIndex] = cacheReport;
      }
    } else {
      const cacheIndex = phaseReports.findIndex((report) => report.name === "cache");
      if (cacheIndex >= 0) {
        const existingCacheReport = phaseReports[cacheIndex];
        if (existingCacheReport) {
          cacheReport = withPhaseReport(existingCacheReport, {
            summary: {
              ...existingCacheReport.summary,
              snapshotId: snapshotSummary.summary.snapshotId,
              snapshotSaved: snapshotSummary.summary.saved,
              prunedIds: snapshotSummary.summary.prunedIds,
            },
          });
        }
        phaseReports[cacheIndex] = cacheReport;
      }
    }

    const allDiagnostics = [
      ...diagnostics,
      ...phaseReports.flatMap((report) => report.diagnostics),
    ];
    const artifact: EngineeringWorkflowArtifact = {
      projectRoot: input.projectRoot,
      targets: effectiveDiscovery.targets,
      files: facts.files,
      dependencyGraph: effectiveDiscovery.dependencyGraph,
      codeGraph: graphs.codeGraph.toJSON(),
      callGraph: graphs.callGraph,
      dataFlow: graphs.dataFlow,
      entityGraph: graphs.entityGraphSnapshot,
      panoramaSnapshot,
      optionalStage: optionalStage.artifact,
      dimensionFileRefs: optionalStage.artifact.dimensionFileRefs,
      generatedArtifactBlacklist: facts.generatedArtifactPaths,
      truncated,
      incrementalPlan,
      snapshotId: snapshotSummary.summary.snapshotId,
    };

    const result: EngineeringWorkflowResult = {
      status: workflowStatus(phaseReports),
      artifact,
      phases: phaseReports,
      diagnostics: dedupeDiagnostics(allDiagnostics),
      capabilities: workflowCapabilities(
        input,
        discovery,
        graphs,
        panoramaSnapshot !== null,
        optionalStage.artifact,
      ),
      truncated,
      incrementalPlan,
      snapshot: snapshotSummary.summary,
    };
    return result;
  }
}

export async function runEngineeringWorkflow(
  input: EngineeringWorkflowInput,
): Promise<EngineeringWorkflowResult> {
  return new EngineeringWorkflowRunner().run(input);
}

type CacheEvaluationStatus = "disabled" | "planned";

interface CacheEvaluationState {
  readonly status: CacheEvaluationStatus;
  readonly plan: EngineeringWorkflowIncrementalPlan | null;
  readonly baseline: EngineeringWorkflowSnapshot | null;
  readonly currentFiles: readonly EngineeringWorkflowFileInput[];
  readonly diagnostics: readonly EngineeringWorkflowDiagnostic[];
  readonly partial: boolean;
  readonly saveSnapshot: boolean;
}

interface WorkflowSnapshotSaveState {
  readonly summary: EngineeringWorkflowSnapshotRunSummary;
  readonly diagnostics: readonly EngineeringWorkflowDiagnostic[];
  readonly partial: boolean;
}

function disabledCacheState(): CacheEvaluationState {
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

function evaluateCacheAndIncremental(
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

function snapshotDiagnosticsToWorkflow(
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

function cachePhaseSummary(state: CacheEvaluationState): Readonly<Record<string, unknown>> {
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

function filterDiscoveryByAffectedFiles(
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
        "Targeted rescan filters discovery files to affected paths; unaffected fact reuse requires an external adapter.",
      ),
    ],
  };
}

function discoveryShellFacts(
  input: EngineeringWorkflowInput,
  discovery: EngineeringWorkflowDiscoveryResult,
): EngineeringWorkflowFactBundle {
  const { astSummaries: _astSummaries, ...withoutAstSummaries } = input;
  void _astSummaries;
  return collectFacts({ ...withoutAstSummaries, importFacts: [], fileContents: {} }, discovery);
}

function skippedWorkflowPhase(
  name: "collectFacts" | "buildGraphs" | "panorama",
  summary: Readonly<Record<string, unknown>>,
): EngineeringWorkflowPhaseReport {
  const now = Date.now();
  return phaseReport(name, "skipped", now, now, [], summary);
}

interface OptionalStagePhaseRun {
  readonly artifact: EngineeringWorkflowArtifact["optionalStage"];
  readonly phaseReport: EngineeringWorkflowPhaseReport;
  readonly workflowDiagnostics: readonly EngineeringWorkflowDiagnostic[];
}

async function runOptionalStagePhase({
  input,
  facts,
  panoramaSnapshot,
  generatedArtifactPaths,
}: {
  readonly input: EngineeringWorkflowInput;
  readonly facts: EngineeringWorkflowFactBundle;
  readonly panoramaSnapshot: EngineeringWorkflowArtifact["panoramaSnapshot"];
  readonly generatedArtifactPaths: readonly string[];
}): Promise<OptionalStagePhaseRun> {
  const options = normalizeOptionalStageOptions(input);
  if (!options.enabled) {
    const diagnostic: EngineeringWorkflowOptionalDiagnostic = {
      code: "optional.stage.disabled",
      severity: "info",
      message: "Optional workflow stage disabled by input configuration.",
      source: "optional-stage",
    };
    const workflowDiagnostics = optionalDiagnosticsToWorkflow([diagnostic]);
    const now = Date.now();
    return {
      artifact: {
        status: "disabled",
        result: null,
        enhancementSignals: [],
        guardFindings: [],
        dimensionGates: [],
        dimensionFileRefs: [],
        diagnostics: [diagnostic],
      },
      phaseReport: phaseReport("optional", "skipped", now, now, workflowDiagnostics, {
        enabled: false,
        reason: "disabled",
      }),
      workflowDiagnostics,
    };
  }

  const stageInput: EngineeringWorkflowOptionalStageInput = {
    files: facts.files,
    fileContents: facts.fileContents,
    importFacts: facts.importFacts,
    ...(facts.astSummaries === undefined ? {} : { astSummaries: facts.astSummaries }),
    ...(panoramaSnapshot === null ? {} : { panoramaSnapshot }),
    ...(panoramaSnapshot === null ? {} : { gaps: panoramaSnapshot.gaps }),
    ...(options.guardFiles === undefined ? {} : { guardFiles: options.guardFiles }),
    ...(options.guardRuleFacts === undefined ? {} : { guardRuleFacts: options.guardRuleFacts }),
    ...(options.guardCallbacks === undefined ? {} : { guardCallbacks: options.guardCallbacks }),
    dimensions: optionalDimensionsFromInput(input, options),
    generatedArtifactBlacklist: [
      ...generatedArtifactPaths,
      ...(options.generatedArtifactBlacklist ?? []),
    ],
    ...(options.enhancement?.techStackItems === undefined
      ? {}
      : { techStackItems: options.enhancement.techStackItems }),
    ...(options.enhancement?.minConfidence === undefined
      ? {}
      : { minConfidence: options.enhancement.minConfidence }),
  };

  const optionalPhase = await runWorkflowPhase("optional", () =>
    runEngineeringWorkflowOptionalStage(stageInput),
  );

  if (!optionalPhase.ok) {
    const diagnostic: EngineeringWorkflowOptionalDiagnostic = {
      code: "optional.stage.failed",
      severity: "error",
      message: `Optional workflow stage failed: ${errorMessage(optionalPhase.error)}`,
      source: "optional-stage",
    };
    const workflowDiagnostics = optionalDiagnosticsToWorkflow([diagnostic]);
    return {
      artifact: {
        status: "failed",
        result: null,
        enhancementSignals: [],
        guardFindings: [],
        dimensionGates: [],
        dimensionFileRefs: [],
        diagnostics: [diagnostic],
      },
      phaseReport: withPhaseReport(optionalPhase.report, {
        status: "failed",
        diagnostics: [...optionalPhase.report.diagnostics, ...workflowDiagnostics],
        summary: {
          enabled: true,
          enhancementSignals: 0,
          guardFindings: 0,
          dimensionGates: 0,
          dimensionFileRefs: 0,
        },
      }),
      workflowDiagnostics,
    };
  }

  const result = optionalPhase.value;
  const workflowDiagnostics = optionalDiagnosticsToWorkflow(result.diagnostics);
  const status = optionalArtifactStatus(result.diagnostics);
  return {
    artifact: {
      status,
      result,
      enhancementSignals: result.enhancement.signals,
      guardFindings: [...result.guard.findings, ...(result.enhancementReaudit?.findings ?? [])],
      dimensionGates: result.dimensions.gates,
      dimensionFileRefs: result.dimensions.fileRefs,
      diagnostics: result.diagnostics,
    },
    phaseReport: withPhaseReport(optionalPhase.report, {
      status: status === "partial" ? "partial" : "success",
      diagnostics: [...optionalPhase.report.diagnostics, ...workflowDiagnostics],
      summary: {
        enabled: true,
        enhancementPacks: result.enhancement.packs.length,
        enhancementSignals: result.enhancement.signals.length,
        enhancementPatterns: result.enhancement.patterns.length,
        enhancementGuardRules: result.enhancement.guardRules.length,
        guardFindings: result.guard.findings.length,
        enhancementReauditFindings: result.enhancementReaudit?.findings.length ?? 0,
        reAuditDiagnostics: result.enhancementReaudit?.diagnostics.length ?? 0,
        dimensionGates: result.dimensions.gates.length,
        activeDimensions: result.dimensions.activeDimensions.length,
        dimensionFileRefs: result.dimensions.fileRefs.length,
      },
    }),
    workflowDiagnostics,
  };
}

function skippedOptionalStageArtifact(reason: string): OptionalStagePhaseRun {
  const diagnostic: EngineeringWorkflowOptionalDiagnostic = {
    code: "optional.stage.skipped",
    severity: "info",
    message:
      "Optional workflow stage skipped by incremental plan; cached optional artifacts require an external adapter.",
    source: "optional-stage",
  };
  const workflowDiagnostics = optionalDiagnosticsToWorkflow([diagnostic]);
  const now = Date.now();
  return {
    artifact: {
      status: "skipped",
      result: null,
      enhancementSignals: [],
      guardFindings: [],
      dimensionGates: [],
      dimensionFileRefs: [],
      diagnostics: [diagnostic],
    },
    phaseReport: phaseReport("optional", "skipped", now, now, workflowDiagnostics, {
      enabled: true,
      mode: "skip",
      reason,
    }),
    workflowDiagnostics,
  };
}

function normalizeOptionalStageOptions(input: EngineeringWorkflowInput): Exclude<
  EngineeringWorkflowInput["optionalStage"],
  boolean | undefined
> & {
  readonly enabled: boolean;
} {
  if (input.optionalStage === false) {
    return { enabled: false };
  }
  if (input.optionalStage === true || input.optionalStage === undefined) {
    return { enabled: true };
  }
  return {
    ...input.optionalStage,
    enabled: input.optionalStage.enabled ?? true,
  };
}

function optionalDimensionsFromInput(
  input: EngineeringWorkflowInput,
  options: ReturnType<typeof normalizeOptionalStageOptions>,
): readonly EngineeringWorkflowOptionalDimension[] {
  const configured = options.dimensions ?? [];
  const configuredIds = new Set(configured.map((dimension) => dimension.id));
  const dimensionIds = [...(input.dimensionIds ?? []), ...(options.dimensionIds ?? [])];
  const fromIds = dimensionIds
    .filter((dimensionId) => !configuredIds.has(dimensionId))
    .map((dimensionId) => ({
      id: dimensionId,
      label: humanizeDimensionId(dimensionId),
      knowledgeTypes: [],
      source: "input",
    }));
  return [...configured, ...fromIds];
}

function humanizeDimensionId(dimensionId: string): string {
  return dimensionId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function optionalArtifactStatus(
  diagnostics: readonly EngineeringWorkflowOptionalDiagnostic[],
): "success" | "partial" {
  return diagnostics.some((diagnostic) => diagnostic.severity !== "info") ? "partial" : "success";
}

function optionalDiagnosticsToWorkflow(
  diagnostics: readonly EngineeringWorkflowOptionalDiagnostic[],
): readonly EngineeringWorkflowDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    phase: "optional",
    severity: optionalSeverityToWorkflow(diagnostic.severity),
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.source === undefined ? {} : { cause: diagnostic.source }),
  }));
}

function optionalSeverityToWorkflow(
  severity: EngineeringWorkflowOptionalDiagnostic["severity"],
): EngineeringWorkflowDiagnostic["severity"] {
  switch (severity) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "info";
  }
}

function saveWorkflowSnapshot(
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

async function discoverProject(
  input: EngineeringWorkflowInput,
): Promise<EngineeringWorkflowDiscoveryResult> {
  if (input.discoveryResult) {
    return input.discoveryResult;
  }

  const discoverer =
    input.discoverer ?? (await createDefaultDiscovererRegistry().detect(input.projectRoot));
  await discoverer.load(input.projectRoot);
  const targets = await discoverer.listTargets();
  const diagnostics: EngineeringWorkflowDiagnostic[] = [];
  const files: EngineeringFile[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    try {
      const targetFiles = await discoverer.getTargetFiles(target);
      for (const file of targetFiles) {
        const key = file.relativePath || file.path;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        files.push(file);
      }
    } catch (error: unknown) {
      diagnostics.push(
        workflowDiagnostic(
          "discover",
          "warning",
          `Target file discovery failed for ${targetName(target)}`,
          error,
        ),
      );
    }
  }

  const dependencyGraph = await dependencyGraphFor(discoverer, diagnostics);
  return {
    targets,
    files,
    dependencyGraph,
    discovererId: discoverer.id,
    discovererName: discoverer.displayName,
    diagnostics,
  };
}

function collectFacts(
  input: EngineeringWorkflowInput,
  discovery: EngineeringWorkflowDiscoveryResult,
): EngineeringWorkflowFactBundle {
  const maxFiles = input.maxFiles ?? Number.POSITIVE_INFINITY;
  const generatedArtifactPaths: string[] = [];
  const files: EngineeringFile[] = [];

  for (const file of discovery.files) {
    const key = file.relativePath || file.path;
    if (isEngineeringGeneratedArtifact(key) || isEngineeringGeneratedArtifact(file.path)) {
      generatedArtifactPaths.push(key);
      continue;
    }
    if (files.length >= maxFiles) {
      continue;
    }
    files.push(file);
  }

  const filePathSet = new Set(files.flatMap((file) => [file.relativePath, file.path]));
  const fileContents = Object.fromEntries(
    Object.entries(input.fileContents ?? {}).filter(([filePath]) => filePathSet.has(filePath)),
  );
  const importFacts = dedupeImportFacts([
    ...(input.importFacts ?? []),
    ...extractImportFacts(input.astSummaries, filePathSet),
  ]);

  return {
    files,
    fileContents,
    importFacts,
    ...(input.astSummaries === undefined ? {} : { astSummaries: input.astSummaries }),
    generatedArtifactPaths,
  };
}

function buildGraphs(
  input: EngineeringWorkflowInput,
  discovery: EngineeringWorkflowDiscoveryResult,
  facts: EngineeringWorkflowFactBundle,
): {
  readonly codeGraph: EngineeringCodeGraph;
  readonly callGraph: readonly EngineeringCodeCallGraphEdge[];
  readonly dataFlow: readonly EngineeringCodeDataFlowEdge[];
  readonly entityGraphSnapshot: EngineeringEntityGraphSnapshot;
  readonly diagnostics: readonly EngineeringWorkflowDiagnostic[];
  readonly partial: boolean;
} {
  const diagnostics: EngineeringWorkflowDiagnostic[] = [];
  let partial = false;
  const analysisInput = facts.astSummaries;
  let codeGraph = analysisInput
    ? EngineeringCodeGraph.fromAstSummary(analysisInput)
    : EngineeringCodeGraph.fromAstSummary([]);
  let callGraph: readonly EngineeringCodeCallGraphEdge[] = codeGraph.getCallGraphEdges();
  let dataFlow: readonly EngineeringCodeDataFlowEdge[] = codeGraph.getDataFlowEdges();

  if (analysisInput) {
    try {
      const explicitCallGraph = callGraph;
      const explicitDataFlow = dataFlow;
      const analysis = new CallGraphAnalyzer().analyze(analysisInput, {
        ...(input.pathHints === undefined ? {} : { pathHints: input.pathHints }),
      });
      codeGraph = EngineeringCodeGraph.fromAstSummary({
        astProjectSummary: { fileSummaries: astSummariesFrom(analysisInput) },
        // 中文说明：外部 adapter 可能已经注入成熟调用图；这里与增量推断结果合并，避免迁移期丢边。
        callGraphEdges: [...explicitCallGraph, ...analysis.callEdges],
        dataFlowEdges: [...explicitDataFlow, ...analysis.dataFlowEdges],
      });
      callGraph = codeGraph.getCallGraphEdges();
      dataFlow = codeGraph.getDataFlowEdges();
    } catch (error: unknown) {
      partial = true;
      diagnostics.push(
        workflowDiagnostic(
          "buildGraphs",
          "warning",
          "Call graph analysis failed; using structural code graph",
          error,
        ),
      );
    }
  }

  const entityGraph = EngineeringEntityGraph.fromInput({
    targets: discovery.targets,
    files: facts.files,
    dependencyGraph: discovery.dependencyGraph,
    codeGraph,
    callGraph,
    dataFlow,
  });

  return {
    codeGraph,
    callGraph,
    dataFlow,
    entityGraphSnapshot: {
      entities: entityGraph.entities,
      edges: entityGraph.edges,
      topology: entityGraph.getTopology(),
    },
    diagnostics,
    partial,
  };
}

function buildPanorama(
  input: EngineeringWorkflowInput,
  facts: EngineeringWorkflowFactBundle,
  dependencyGraph: EngineeringDependencyGraph,
  codeGraph: EngineeringCodeGraph,
) {
  const service = input.panoramaService ?? new EngineeringPanoramaService();
  const recipeFacts = optionalRecipeFacts(input);
  return service.buildSnapshot({
    projectRoot: input.projectRoot,
    files: facts.files,
    dependencyGraph,
    codeGraph,
    importFacts: facts.importFacts,
    ...(recipeFacts === undefined ? {} : { recipeFacts }),
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
    ...(input.computedAt === undefined ? {} : { computedAt: input.computedAt }),
    ...(input.staleAfterMs === undefined ? {} : { staleAfterMs: input.staleAfterMs }),
    ...(input.stale === undefined ? {} : { stale: input.stale }),
  });
}

function optionalRecipeFacts(input: EngineeringWorkflowInput) {
  const optionalStage = input.optionalStage;
  if (!optionalStage || typeof optionalStage === "boolean") {
    return undefined;
  }
  return optionalStage.recipeFacts;
}

function buildEmptyGraphs(
  targets: readonly EngineeringTarget[],
  files: readonly EngineeringFile[],
  dependencyGraph: EngineeringDependencyGraph,
) {
  const codeGraph = EngineeringCodeGraph.fromAstSummary([]);
  const entityGraph = EngineeringEntityGraph.fromInput({
    targets,
    files,
    dependencyGraph,
    codeGraph,
    callGraph: [],
    dataFlow: [],
  });
  return {
    codeGraph,
    callGraph: [],
    dataFlow: [],
    entityGraphSnapshot: {
      entities: entityGraph.entities,
      edges: entityGraph.edges,
      topology: entityGraph.getTopology(),
    },
    diagnostics: [],
    partial: true,
  };
}

function emptyDiscovery(): EngineeringWorkflowDiscoveryResult {
  return {
    targets: [],
    files: [],
    dependencyGraph: EMPTY_DEPENDENCY_GRAPH,
  };
}

function emptyFacts(): EngineeringWorkflowFactBundle {
  return {
    files: [],
    fileContents: {},
    importFacts: [],
    generatedArtifactPaths: [],
  };
}

async function dependencyGraphFor(
  discoverer: EngineeringDiscoverer,
  diagnostics: EngineeringWorkflowDiagnostic[],
): Promise<EngineeringDependencyGraph> {
  try {
    return await discoverer.getDependencyGraph();
  } catch (error: unknown) {
    diagnostics.push(
      workflowDiagnostic("discover", "warning", "Dependency graph discovery failed", error),
    );
    return EMPTY_DEPENDENCY_GRAPH;
  }
}

function targetName(target: EngineeringTarget | string): string {
  return typeof target === "string" ? target : target.name;
}

function phaseStatus(diagnostics: readonly EngineeringWorkflowDiagnostic[], partial = false) {
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return "failed";
  }
  if (partial || diagnostics.length > 0) {
    return "partial";
  }
  return "success";
}

function workflowStatus(
  reports: readonly EngineeringWorkflowPhaseReport[],
): EngineeringWorkflowResult["status"] {
  if (reports.every((report) => report.status === "failed")) {
    return "failed";
  }
  if (reports.some((report) => report.status === "failed" || report.status === "partial")) {
    return "partial";
  }
  return "success";
}

function workflowCapabilities(
  input: EngineeringWorkflowInput,
  discovery: EngineeringWorkflowDiscoveryResult,
  graphs: ReturnType<typeof buildEmptyGraphs> | ReturnType<typeof buildGraphs>,
  hasPanorama: boolean,
  optionalStage: EngineeringWorkflowArtifact["optionalStage"],
): EngineeringWorkflowCapabilities {
  return {
    injectedDiscovery: input.discoveryResult !== undefined,
    injectedAstSummaries: input.astSummaries !== undefined,
    injectedFileContents: input.fileContents !== undefined,
    injectedImportFacts: input.importFacts !== undefined,
    discovery: discovery.targets.length > 0 || discovery.files.length > 0,
    factCollection: true,
    codeGraph: graphs.codeGraph.toJSON().files.length > 0,
    callGraph: graphs.callGraph.length > 0,
    dataFlow: graphs.dataFlow.length > 0,
    entityGraph: graphs.entityGraphSnapshot.entities.length > 0,
    panorama: hasPanorama,
    optionalStage: optionalStage.status !== "disabled" && optionalStage.status !== "skipped",
    dimensionFileRefs: optionalStage.dimensionFileRefs.length > 0,
    cache: input.snapshotStore !== undefined,
    incrementalStore: input.snapshotStore !== undefined,
  };
}

function astSummariesFrom(
  input: EngineeringCodeAstSummaryInput,
): readonly EngineeringCodeAstFileSummaryInput[] {
  if (Array.isArray(input)) {
    return input;
  }
  const container = input as Exclude<
    EngineeringCodeAstSummaryInput,
    readonly EngineeringCodeAstFileSummaryInput[]
  >;
  return (
    container.fileSummaries ?? container.files ?? container.astProjectSummary?.fileSummaries ?? []
  );
}

function countAstSummaries(input: EngineeringCodeAstSummaryInput | undefined): number {
  return input === undefined ? 0 : astSummariesFrom(input).length;
}

function extractImportFacts(
  input: EngineeringCodeAstSummaryInput | undefined,
  filePathSet: ReadonlySet<string>,
): readonly EngineeringImportFact[] {
  if (!input) {
    return [];
  }
  const facts: EngineeringImportFact[] = [];
  for (const summary of astSummariesFrom(input)) {
    const filePath = stringValue(summary.file ?? summary.path ?? summary.filePath);
    if (!filePath || !filePathSet.has(filePath)) {
      continue;
    }
    for (const rawImport of Array.isArray(summary.imports) ? summary.imports : []) {
      const record: Record<string, unknown> = isRecord(rawImport) ? rawImport : { path: rawImport };
      const specifier = stringValue(
        record.specifier ?? record.path ?? record.module ?? record.source,
      );
      if (!specifier) {
        continue;
      }
      facts.push({
        filePath,
        specifier,
        ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
      });
    }
  }
  return facts;
}

function dedupeImportFacts(
  facts: readonly EngineeringImportFact[],
): readonly EngineeringImportFact[] {
  const byKey = new Map<string, EngineeringImportFact>();
  for (const fact of facts) {
    byKey.set(`${fact.filePath}\0${fact.specifier}\0${fact.kind ?? ""}`, fact);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.filePath.localeCompare(right.filePath) ||
      left.specifier.localeCompare(right.specifier) ||
      (left.kind ?? "").localeCompare(right.kind ?? ""),
  );
}

function dedupeDiagnostics(
  diagnostics: readonly EngineeringWorkflowDiagnostic[],
): readonly EngineeringWorkflowDiagnostic[] {
  const byKey = new Map<string, EngineeringWorkflowDiagnostic>();
  for (const diagnostic of diagnostics) {
    byKey.set(
      `${diagnostic.phase}\0${diagnostic.severity}\0${diagnostic.message}\0${diagnostic.cause ?? ""}`,
      diagnostic,
    );
  }
  return [...byKey.values()];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { CallGraphAnalyzer } from "../code/analysis/index.js";
import { EngineeringCodeGraph } from "../code/graph.js";
import type {
  EngineeringCodeAstFileSummaryInput,
  EngineeringCodeAstSummaryInput,
  EngineeringCodeCallGraphEdge,
  EngineeringCodeDataFlowEdge,
} from "../code/types.js";
import { createDefaultDiscovererRegistry } from "../discovery/index.js";
import { EngineeringEntityGraph } from "../entity/graph.js";
import type {
  EngineeringDependencyGraph,
  EngineeringDiscoverer,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/types.js";
import type { EngineeringImportFact } from "../panorama/module-discoverer.js";
import { EngineeringPanoramaService } from "../panorama/service.js";
import {
  cachePhaseSummary,
  disabledCacheState,
  evaluateCacheAndIncremental,
  filterDiscoveryByAffectedFiles,
} from "./cache/evaluation.js";
import { saveWorkflowSnapshot } from "./cache/snapshot-run.js";
import {
  isEngineeringGeneratedArtifact,
  runWorkflowPhase,
  withPhaseReport,
  workflowDiagnostic,
} from "./core/core.js";
import {
  dedupeDiagnostics,
  phaseStatus,
  skippedWorkflowPhase,
  workflowStatus,
} from "./core/status.js";
import { runOptionalStagePhase, skippedOptionalStageArtifact } from "./optional/phase.js";
import type {
  EngineeringEntityGraphSnapshot,
  EngineeringWorkflowArtifact,
  EngineeringWorkflowCapabilities,
  EngineeringWorkflowDiagnostic,
  EngineeringWorkflowDiscoveryResult,
  EngineeringWorkflowFactBundle,
  EngineeringWorkflowInput,
  EngineeringWorkflowPhaseReport,
  EngineeringWorkflowResult,
} from "./types.js";

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

function discoveryShellFacts(
  input: EngineeringWorkflowInput,
  discovery: EngineeringWorkflowDiscoveryResult,
): EngineeringWorkflowFactBundle {
  const { astSummaries: _astSummaries, ...withoutAstSummaries } = input;
  void _astSummaries;
  return collectFacts({ ...withoutAstSummaries, importFacts: [], fileContents: {} }, discovery);
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

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

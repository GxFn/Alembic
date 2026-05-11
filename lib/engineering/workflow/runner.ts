import {
  cachePhaseSummary,
  disabledCacheState,
  evaluateCacheAndIncremental,
  filterDiscoveryByAffectedFiles,
} from "./cache/evaluation.js";
import { saveWorkflowSnapshot } from "./cache/snapshot-run.js";
import { workflowCapabilities } from "./capabilities.js";
import { runWorkflowPhase, withPhaseReport, workflowDiagnostic } from "./core/core.js";
import {
  dedupeDiagnostics,
  phaseStatus,
  skippedWorkflowPhase,
  workflowStatus,
} from "./core/status.js";
import { discoverProject, emptyDiscovery } from "./discovery.js";
import { collectFacts, countAstSummaries, discoveryShellFacts, emptyFacts } from "./facts.js";
import { buildEmptyGraphs, buildGraphs, type EngineeringWorkflowGraphBundle } from "./graphs.js";
import { runOptionalStagePhase, skippedOptionalStageArtifact } from "./optional/phase.js";
import { buildPanorama } from "./panorama.js";
import type {
  EngineeringWorkflowArtifact,
  EngineeringWorkflowDiagnostic,
  EngineeringWorkflowFactBundle,
  EngineeringWorkflowInput,
  EngineeringWorkflowPhaseReport,
  EngineeringWorkflowResult,
} from "./types.js";

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

    let graphs: EngineeringWorkflowGraphBundle;
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

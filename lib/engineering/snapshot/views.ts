import type { EngineeringCodeGraphSnapshot, EngineeringCodeMethod } from "../code/types.js";
import type { EngineeringDependencyGraph } from "../foundation/types.js";
import type { EngineeringWorkflowGuardAuditResult } from "../workflow/optional/types.js";
import type {
  ProjectSnapshot,
  ProjectSnapshotFile,
  ProjectSnapshotLocalPackageModule,
  ProjectSnapshotTarget,
} from "./types.js";

export interface ProjectSnapshotSessionCache {
  readonly allFiles: readonly ProjectSnapshotFile[];
  readonly allTargets: readonly ProjectSnapshotTarget[];
  readonly fileContents: Readonly<Record<string, string>>;
  readonly codeGraph: EngineeringCodeGraphSnapshot | null;
  readonly callGraph: ProjectSnapshot["callGraph"];
  readonly dataFlow: ProjectSnapshot["dataFlow"];
  readonly entityGraph: ProjectSnapshot["entityGraph"];
  readonly panoramaSnapshot: ProjectSnapshot["panorama"];
  readonly depGraphData: EngineeringDependencyGraph | null;
  readonly guardAudit: EngineeringWorkflowGuardAuditResult | null;
  readonly langStats: Readonly<Record<string, number>>;
  readonly primaryLang: string;
  readonly targetsSummary: readonly ProjectSnapshotTarget[];
  readonly localPackageModules: readonly ProjectSnapshotLocalPackageModule[];
  readonly activeDimensions: ProjectSnapshot["activeDimensions"];
  readonly enhancementPackInfo: ProjectSnapshot["enhancementPackInfo"];
  readonly dimensionFileRefs: ProjectSnapshot["dimensionFileRefs"];
  readonly generatedArtifactBlacklist: readonly string[];
  readonly incrementalPlan: ProjectSnapshot["incrementalPlan"];
  readonly snapshotId: string | null;
}

export function toResponseData(snapshot: ProjectSnapshot): Record<string, unknown> {
  const warnings = snapshot.diagnostics
    .filter((diagnostic) => diagnostic.severity !== "info")
    .map((diagnostic) => diagnostic.message);
  const response: Record<string, unknown> = {
    version: snapshot.version,
    createdAt: snapshot.createdAt,
    projectRoot: snapshot.projectRoot,
    sourceTag: snapshot.sourceTag ?? null,
    workflowStatus: snapshot.workflowStatus ?? null,
    filesScanned: snapshot.allFiles.length,
    targets: snapshot.targetsSummary,
    primaryLanguage: snapshot.language.primaryLang,
    languageStats: snapshot.language.stats,
    secondaryLanguages: snapshot.language.secondary,
    isMultiLang: snapshot.language.isMultiLang,
    codeGraph: codeGraphSummary(snapshot.codeGraph),
    callGraph: {
      edges: snapshot.callGraph.length,
      awaitedCalls: snapshot.callGraph.filter((edge) => edge.isAwait).length,
    },
    dataFlow: {
      edges: snapshot.dataFlow.length,
    },
    entityGraph: snapshot.entityGraph
      ? {
          entities: snapshot.entityGraph.entities.length,
          edges: snapshot.entityGraph.edges.length,
          components: snapshot.entityGraph.topology.components.length,
          cycles: snapshot.entityGraph.topology.cycles.length,
        }
      : null,
    panorama: snapshot.panorama
      ? {
          modules: snapshot.panorama.modules.length,
          relationships: snapshot.panorama.relationships.moduleEdges.length,
          externalDeps: snapshot.panorama.externalDeps.length,
          health: snapshot.panorama.health,
          gaps: snapshot.panorama.gaps.length,
          stale: snapshot.panorama.stale,
        }
      : null,
    guardSummary: guardSummary(snapshot.guardAudit),
    dependencyGraph: dependencyGraphSummary(snapshot.dependencyGraph),
    dimensionCount: snapshot.activeDimensions.length,
    enhancementPacks:
      snapshot.enhancementPackInfo.length > 0
        ? {
            matched: snapshot.enhancementPackInfo,
            patterns: snapshot.enhancementPatterns.length,
            guardRules: snapshot.enhancementGuardRules.length,
          }
        : null,
    detectedFrameworks: snapshot.detectedFrameworks,
    localPackageModules:
      snapshot.localPackageModules.length > 0 ? snapshot.localPackageModules : null,
    generatedArtifactBlacklist: snapshot.generatedArtifactBlacklist,
    incrementalPlan: snapshot.incrementalPlan
      ? {
          mode: snapshot.incrementalPlan.mode,
          reason: snapshot.incrementalPlan.reason,
          baselineSnapshotId: snapshot.incrementalPlan.baselineSnapshotId,
          affectedFiles: snapshot.incrementalPlan.affectedFiles,
          affectedModules: snapshot.incrementalPlan.affectedModules,
          affectedDimensions: snapshot.incrementalPlan.affectedDimensions,
        }
      : null,
    snapshot: {
      id: snapshot.snapshotId,
      baselineSnapshotId: snapshot.snapshotRun?.baselineSnapshotId ?? null,
      saved: snapshot.snapshotRun?.saved ?? false,
    },
    truncated: snapshot.truncated,
    isEmpty: snapshot.isEmpty,
  };

  if (warnings.length > 0) {
    response.warnings = warnings;
  }
  return response;
}

export function toSessionCache(snapshot: ProjectSnapshot): ProjectSnapshotSessionCache {
  return Object.freeze({
    allFiles: snapshot.allFiles,
    allTargets: snapshot.allTargets,
    fileContents: Object.freeze(fileContentsFromSnapshot(snapshot.allFiles)),
    codeGraph: snapshot.codeGraph,
    callGraph: snapshot.callGraph,
    dataFlow: snapshot.dataFlow,
    entityGraph: snapshot.entityGraph,
    panoramaSnapshot: snapshot.panorama,
    depGraphData: snapshot.dependencyGraph,
    guardAudit: snapshot.guardAudit,
    langStats: snapshot.language.stats,
    primaryLang: snapshot.language.primaryLang,
    targetsSummary: snapshot.targetsSummary,
    localPackageModules: snapshot.localPackageModules,
    activeDimensions: snapshot.activeDimensions,
    enhancementPackInfo: snapshot.enhancementPackInfo,
    dimensionFileRefs: snapshot.dimensionFileRefs,
    generatedArtifactBlacklist: snapshot.generatedArtifactBlacklist,
    incrementalPlan: snapshot.incrementalPlan,
    snapshotId: snapshot.snapshotId,
  });
}

function codeGraphSummary(
  codeGraph: EngineeringCodeGraphSnapshot | null,
): Record<string, unknown> | null {
  if (!codeGraph) {
    return null;
  }
  return {
    files: codeGraph.files.length,
    classes: codeGraph.classes.length,
    protocols: codeGraph.protocols.length,
    categories: codeGraph.categories.length,
    methods: codeGraph.overview?.totalMethods ?? countMethods(codeGraph),
    callEdges: codeGraph.callGraphEdges?.length ?? 0,
    dataFlowEdges: codeGraph.dataFlowEdges?.length ?? 0,
    topLevelModules: codeGraph.overview?.topLevelModules ?? [],
    entryPoints: codeGraph.overview?.entryPoints ?? [],
  };
}

function countMethods(codeGraph: EngineeringCodeGraphSnapshot): number {
  const classMethods = codeGraph.classes.flatMap((classInfo) => classInfo.methods);
  const categoryMethods = codeGraph.categories.flatMap((category) => category.methods);
  const protocolMethods = codeGraph.protocols.flatMap((protocol) => [
    ...protocol.requiredMethods,
    ...protocol.optionalMethods,
  ]);
  return new Set([...classMethods, ...categoryMethods, ...protocolMethods].map(methodKey)).size;
}

function methodKey(method: EngineeringCodeMethod): string {
  return `${method.filePath}:${method.line ?? "unknown"}:${method.selector}`;
}

function guardSummary(
  guardAudit: EngineeringWorkflowGuardAuditResult | null,
): Record<string, unknown> | null {
  if (!guardAudit) {
    return null;
  }
  return {
    files: guardAudit.summary.fileCount,
    rules: guardAudit.summary.ruleCount,
    totalFindings: guardAudit.summary.totalFindings,
    errors: guardAudit.summary.errors,
    warnings: guardAudit.summary.warnings,
    infos: guardAudit.summary.infos,
  };
}

function dependencyGraphSummary(
  dependencyGraph: EngineeringDependencyGraph | null,
): Record<string, unknown> | null {
  if (!dependencyGraph) {
    return null;
  }
  return {
    nodes: dependencyGraph.nodes.map((node) =>
      typeof node === "string"
        ? { id: node, label: node }
        : {
            id: node.id,
            label: node.label ?? node.id,
            type: node.type ?? null,
            layer: node.layer ?? null,
          },
    ),
    edges: dependencyGraph.edges,
    layers: dependencyGraph.layers ?? [],
  };
}

function fileContentsFromSnapshot(files: readonly ProjectSnapshotFile[]): Record<string, string> {
  const fileContents: Record<string, string> = {};
  for (const file of files) {
    if (file.content !== undefined) {
      fileContents[file.relativePath] = file.content;
    }
  }
  return fileContents;
}

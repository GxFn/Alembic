import type { EngineeringCodeGraphReader } from "../code/types.js";
import type { EngineeringDependencyGraph, EngineeringFile } from "../foundation/types.js";
import { EngineeringDimensionAnalyzer } from "./dimension-analyzer.js";
import type {
  EngineeringDiscoveredModuleFact,
  EngineeringImportFact,
  EngineeringModuleDiscoveryResult,
  EngineeringModuleDiscoverySignal,
} from "./module-discoverer.js";
import { EngineeringTechStackProfiler } from "./tech-stack.js";
import type {
  EngineeringCallFlowSummary,
  EngineeringCouplingEdge,
  EngineeringDimensionAnalysis,
  EngineeringPanoramaCacheMarkers,
  EngineeringPanoramaConfidence,
  EngineeringPanoramaDirectoryFileGroup,
  EngineeringPanoramaExternalDependencyProfile,
  EngineeringPanoramaFileGroups,
  EngineeringPanoramaGap,
  EngineeringPanoramaHealthSummary,
  EngineeringPanoramaHotspot,
  EngineeringPanoramaModuleDetail,
  EngineeringPanoramaNeighborEdge,
  EngineeringPanoramaOverview,
  EngineeringPanoramaRefinement,
  EngineeringPanoramaRoleProfile,
  EngineeringPanoramaSnapshot,
  EngineeringRecipeCoverageFact,
  EngineeringRefinedRole,
  EngineeringTechStackProfile,
} from "./types.js";

export interface EngineeringPanoramaSnapshotBuilderInput {
  readonly projectRoot: string;
  readonly files: readonly EngineeringFile[];
  readonly dependencyGraph: EngineeringDependencyGraph;
  readonly discovery: EngineeringModuleDiscoveryResult;
  readonly refinement: EngineeringPanoramaRefinement;
  readonly codeGraph: EngineeringCodeGraphReader;
  readonly importFacts?: readonly EngineeringImportFact[];
  readonly recipeFacts?: readonly EngineeringRecipeCoverageFact[];
  readonly generatedAt?: number | null;
  readonly computedAt?: number;
  readonly staleAfterMs?: number | null;
  readonly stale?: boolean;
}

const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export class EngineeringPanoramaSnapshotBuilder {
  build(input: EngineeringPanoramaSnapshotBuilderInput): EngineeringPanoramaSnapshot {
    const computedAt = input.computedAt ?? Date.now();
    const generatedAt = input.generatedAt ?? null;
    const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const stale = input.stale ?? isStale(generatedAt, computedAt, staleAfterMs);
    const roles = buildRoleProfiles(input.refinement.roles);
    const modules = input.discovery.modules.map((module) =>
      buildModuleDetail(module, input.discovery, input.refinement),
    );
    const dimensionResult = new EngineeringDimensionAnalyzer().analyze({
      modules,
      relationships: input.discovery.relationships,
      refinement: input.refinement,
      codeGraph: input.codeGraph,
      ...(input.recipeFacts !== undefined ? { recipeFacts: input.recipeFacts } : {}),
    });
    const techStack = new EngineeringTechStackProfiler().profile({
      files: input.files,
      dependencyGraph: input.dependencyGraph,
      externalDeps: input.refinement.externalDeps,
      modules,
      ...(input.importFacts !== undefined ? { importFacts: input.importFacts } : {}),
    });
    const overview = buildOverview(input.projectRoot, modules, input.refinement, {
      dimensions: dimensionResult.dimensions,
      gaps: dimensionResult.gaps,
      health: dimensionResult.health,
      callFlow: dimensionResult.callFlow,
      techStack,
    });
    const confidence = buildConfidence(input.discovery.signals, roles, input.refinement.edges);
    const cache = buildCacheMarkers(generatedAt, computedAt, staleAfterMs, stale);

    return {
      projectRoot: input.projectRoot,
      generatedAt,
      computedAt,
      overview,
      modules,
      relationships: {
        moduleEdges: input.discovery.relationships.moduleEdges,
        couplingEdges: input.refinement.edges,
        layerViolations: input.refinement.layerViolations,
      },
      layers: input.refinement.layers,
      cycles: input.refinement.cycles,
      externalDeps: input.refinement.externalDeps,
      techStack,
      dimensions: dimensionResult.dimensions,
      health: dimensionResult.health,
      gaps: dimensionResult.gaps,
      callFlow: dimensionResult.callFlow,
      roles,
      confidence,
      stale,
      cache,
    };
  }
}

export function buildEngineeringPanoramaSnapshot(
  input: EngineeringPanoramaSnapshotBuilderInput,
): EngineeringPanoramaSnapshot {
  return new EngineeringPanoramaSnapshotBuilder().build(input);
}

function buildModuleDetail(
  module: EngineeringDiscoveredModuleFact,
  discovery: EngineeringModuleDiscoveryResult,
  refinement: EngineeringPanoramaRefinement,
): EngineeringPanoramaModuleDetail {
  const summary = discovery.panorama.modules.find((candidate) => candidate.name === module.name);
  const role = refinement.roles.get(module.name);
  const metrics = refinement.metrics.get(module.name);
  const layer =
    refinement.layers.find((candidate) => candidate.modules.includes(module.name)) ?? null;
  const incoming = neighborEdges(module.name, refinement.edges, "incoming");
  const outgoing = neighborEdges(module.name, refinement.edges, "outgoing");
  const externalDeps = refinement.externalDeps.filter((dependency) =>
    dependency.dependedBy.includes(module.name),
  );
  const roleResolution = role?.resolution ?? "fallback";
  const roleSignals = role?.signals ?? [];
  const roleName = role?.refinedRole ?? module.role;
  const fileGroups = {
    ...module.fileGroups,
    byDirectory: groupFilesByDirectory(module.files),
  };

  return {
    name: module.name,
    kind: module.kind,
    role: roleName,
    inferredRole: module.role,
    roleConfidence: role?.confidence ?? 0,
    roleResolution,
    roleSignals,
    uncertainSignals: uncertainSignals(role, module.discoverySignals),
    fallbackSignals: fallbackSignals(role, module.discoverySignals),
    discoverySignals: module.discoverySignals,
    configLayer: module.configLayer,
    layer,
    files: module.files,
    fileCount: summary?.fileCount ?? module.files.length,
    sourceFileCount: summary?.sourceFileCount ?? module.fileGroups.source.length,
    testFileCount: summary?.testFileCount ?? module.fileGroups.test.length,
    docFileCount: summary?.docFileCount ?? module.fileGroups.doc.length,
    symbolCount: summary?.symbolCount ?? 0,
    languages: summary?.languages ?? [],
    fileGroups,
    neighbors: module.neighbors,
    incoming,
    outgoing,
    externalDeps,
    fanIn: metrics?.fanIn ?? module.neighbors.dependents.length,
    fanOut:
      metrics?.fanOut ??
      module.neighbors.dependencies.length + module.neighbors.externalDependencies.length,
    weightedFanIn: metrics?.weightedFanIn ?? module.neighbors.dependents.length,
    weightedFanOut:
      metrics?.weightedFanOut ??
      module.neighbors.dependencies.length + module.neighbors.externalDependencies.length,
    summary: moduleSummaryText({
      module,
      roleName,
      role,
      layerName: layer?.name ?? roleToLayerName(roleName),
      fileGroups,
      incoming,
      outgoing,
      externalDeps,
    }),
  };
}

function buildOverview(
  projectRoot: string,
  modules: readonly EngineeringPanoramaModuleDetail[],
  refinement: EngineeringPanoramaRefinement,
  analysis: {
    readonly dimensions: EngineeringDimensionAnalysis;
    readonly gaps: readonly EngineeringPanoramaGap[];
    readonly health: EngineeringPanoramaHealthSummary;
    readonly callFlow: EngineeringCallFlowSummary;
    readonly techStack: EngineeringTechStackProfile;
  },
): EngineeringPanoramaOverview {
  const localModuleNames = new Set(
    modules
      .filter((module) => module.kind !== "external" && module.kind !== "fallback")
      .map((module) => module.name),
  );
  const localDependencyCount = refinement.edges.filter(
    (edge) => localModuleNames.has(edge.from) && localModuleNames.has(edge.to),
  ).length;
  const coveredModuleCount = modules.filter((module) => module.files.length > 0).length;

  return {
    projectRoot,
    moduleCount: modules.length,
    localModuleCount: modules.filter((module) => module.kind === "local").length,
    hostModuleCount: modules.filter((module) => module.kind === "host").length,
    fallbackModuleCount: modules.filter((module) => module.kind === "fallback").length,
    localDependencyCount,
    externalDependencyCount: refinement.externalDeps.length,
    cycleCount: refinement.cycles.length,
    layerCount: refinement.layers.length,
    totalFileCount: sum(modules, (module) => module.fileCount),
    sourceFileCount: sum(modules, (module) => module.sourceFileCount),
    testFileCount: sum(modules, (module) => module.testFileCount),
    docFileCount: sum(modules, (module) => module.docFileCount),
    coverage: {
      source: "pure-analysis",
      coveredModuleCount,
      totalModuleCount: modules.length,
      ratio: modules.length === 0 ? 0 : round(coveredModuleCount / modules.length),
      weakModuleCount: analysis.dimensions.moduleCoverage.weakModules.length,
      recipeCoverageRatio: analysis.dimensions.recipeCoverage.ratio,
    },
    health: analysis.health,
    hotspots: buildHotspots(modules, refinement),
  };
}

function buildRoleProfiles(
  roles: ReadonlyMap<string, EngineeringRefinedRole>,
): EngineeringPanoramaRoleProfile[] {
  return [...roles.entries()]
    .map(([module, role]) => ({
      module,
      role: role.refinedRole,
      confidence: role.confidence,
      resolution: role.resolution,
      alternatives: role.alternatives,
      signals: role.signals,
    }))
    .sort((left, right) => left.module.localeCompare(right.module));
}

function buildConfidence(
  signals: readonly EngineeringModuleDiscoverySignal[],
  roles: readonly EngineeringPanoramaRoleProfile[],
  edges: readonly EngineeringCouplingEdge[],
): EngineeringPanoramaConfidence {
  const moduleDiscovery = average(signals.map((signal) => signal.confidence));
  const roleRefinement = average(roles.map((role) => role.confidence));
  const relationshipInference = average(
    edges.map((edge) => (edge.sources.includes("import") ? 0.55 : 0.85)),
  );
  return {
    overall: round(average([moduleDiscovery, roleRefinement, relationshipInference])),
    moduleDiscovery: round(moduleDiscovery),
    roleRefinement: round(roleRefinement),
    relationshipInference: round(relationshipInference),
  };
}

function buildCacheMarkers(
  generatedAt: number | null,
  computedAt: number,
  staleAfterMs: number | null,
  stale: boolean,
): EngineeringPanoramaCacheMarkers {
  return {
    enabled: false,
    stale,
    reason: stale
      ? "Snapshot timestamp is older than the stale threshold."
      : "Pure snapshot; no cache backend is connected.",
    generatedAt,
    computedAt,
    staleAfterMs,
  };
}

function neighborEdges(
  moduleName: string,
  edges: readonly EngineeringCouplingEdge[],
  direction: "incoming" | "outgoing",
): EngineeringPanoramaNeighborEdge[] {
  return edges
    .filter((edge) =>
      direction === "incoming" ? edge.to === moduleName : edge.from === moduleName,
    )
    .map((edge) => ({
      name: direction === "incoming" ? edge.from : edge.to,
      direction,
      relation: edge.relation,
      weight: edge.weight,
      sources: edge.sources,
    }))
    .sort((left, right) => right.weight - left.weight || left.name.localeCompare(right.name));
}

function groupFilesByDirectory(files: readonly string[]): EngineeringPanoramaDirectoryFileGroup[] {
  if (files.length === 0) {
    return [];
  }
  const prefix = commonPathPrefix(files);
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const relative = file.slice(prefix.length);
    const slashIndex = relative.indexOf("/");
    const group = slashIndex > 0 ? relative.slice(0, slashIndex) : "(root)";
    groups.set(group, [...(groups.get(group) ?? []), file]);
  }
  return [...groups.entries()]
    .map(([group, groupFiles]) => ({ group, files: groupFiles.sort(), count: groupFiles.length }))
    .sort((left, right) => right.count - left.count || left.group.localeCompare(right.group));
}

function commonPathPrefix(paths: readonly string[]): string {
  let prefix = paths[0] ?? "";
  for (const filePath of paths) {
    while (prefix && !filePath.startsWith(prefix)) {
      const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
      const slashIndex = trimmed.lastIndexOf("/");
      if (slashIndex < 0) {
        return "";
      }
      prefix = trimmed.slice(0, slashIndex + 1);
    }
  }
  return prefix;
}

function uncertainSignals(
  role: EngineeringRefinedRole | undefined,
  discoverySignals: readonly string[],
): readonly string[] {
  if (role?.resolution !== "uncertain") {
    return [];
  }
  return [
    ...role.signals.filter((signal) => signal.confidence < 0.6).map((signal) => signal.source),
    ...discoverySignals.filter((signal) => signal.includes("fallback")),
  ].sort();
}

function fallbackSignals(
  role: EngineeringRefinedRole | undefined,
  discoverySignals: readonly string[],
): readonly string[] {
  const signals = discoverySignals.filter((signal) => signal.includes("fallback"));
  if (role?.resolution === "fallback") {
    signals.push(...role.signals.map((signal) => signal.source));
  }
  return [...new Set(signals)].sort();
}

function moduleSummaryText(input: {
  readonly module: EngineeringDiscoveredModuleFact;
  readonly roleName: string;
  readonly role?: EngineeringRefinedRole | undefined;
  readonly layerName: string;
  readonly fileGroups: EngineeringPanoramaFileGroups;
  readonly incoming: readonly EngineeringPanoramaNeighborEdge[];
  readonly outgoing: readonly EngineeringPanoramaNeighborEdge[];
  readonly externalDeps: readonly EngineeringPanoramaExternalDependencyProfile[];
}): string {
  const confidence = Math.round((input.role?.confidence ?? 0) * 100);
  const groupText = input.fileGroups.byDirectory
    .map((group) => `${group.group}(${group.count})`)
    .join(", ");
  const outText = input.outgoing.map((edge) => edge.name).join(", ");
  const inText = input.incoming.map((edge) => edge.name).join(", ");
  const externalText = input.externalDeps.map((dependency) => dependency.name).join(", ");
  const lines = [
    `${input.module.name} is a ${input.layerName} module with role ${input.roleName} (${confidence}% confidence).`,
    `It contains ${input.module.files.length} files across ${input.fileGroups.byDirectory.length} groups${groupText ? `: ${groupText}` : ""}.`,
  ];
  if (outText) {
    lines.push(`Outgoing dependencies: ${outText}.`);
  }
  if (inText) {
    lines.push(`Incoming dependents: ${inText}.`);
  }
  if (externalText) {
    lines.push(`External dependencies: ${externalText}.`);
  }
  if (!outText && !inText && !externalText) {
    lines.push("No dependency edges are present in this pure snapshot.");
  }
  if (input.role?.resolution === "uncertain" || input.role?.resolution === "fallback") {
    lines.push(
      `Role resolution is ${input.role.resolution}; keep fallback signals visible to callers.`,
    );
  }
  return lines.join(" ");
}

function buildHotspots(
  modules: readonly EngineeringPanoramaModuleDetail[],
  refinement: EngineeringPanoramaRefinement,
): readonly EngineeringPanoramaHotspot[] {
  return modules
    .map((module) => {
      const cycleCount = refinement.cycles.filter((cycle) =>
        cycle.cycle.includes(module.name),
      ).length;
      return {
        module: module.name,
        fanIn: module.fanIn,
        fanOut: module.fanOut,
        weightedFanIn: module.weightedFanIn,
        weightedFanOut: module.weightedFanOut,
        cycleCount,
        reason: hotspotReason(module, cycleCount),
      };
    })
    .filter((hotspot) => hotspot.fanIn + hotspot.fanOut + hotspot.cycleCount > 0)
    .sort(
      (left, right) =>
        right.cycleCount - left.cycleCount ||
        right.weightedFanIn + right.weightedFanOut - (left.weightedFanIn + left.weightedFanOut) ||
        left.module.localeCompare(right.module),
    )
    .slice(0, 5);
}

function hotspotReason(module: EngineeringPanoramaModuleDetail, cycleCount: number): string {
  if (cycleCount > 0) {
    return "participates in module cycles";
  }
  if (module.fanIn >= module.fanOut) {
    return "high incoming coupling";
  }
  return "high outgoing coupling";
}

function roleToLayerName(role: string): string {
  const map: Readonly<Record<string, string>> = {
    app: "Application",
    config: "Configuration",
    core: "Foundation",
    feature: "Feature",
    model: "Model",
    networking: "Infrastructure",
    routing: "Routing",
    service: "Service",
    storage: "Infrastructure",
    test: "Test",
    ui: "UI",
  };
  return map[role] ?? "Feature";
}

function isStale(
  generatedAt: number | null,
  computedAt: number,
  staleAfterMs: number | null,
): boolean {
  if (staleAfterMs === null || generatedAt === null) {
    return false;
  }
  return computedAt - generatedAt > staleAfterMs;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function average(values: readonly number[]): number {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length === 0) {
    return 0;
  }
  return finiteValues.reduce((total, value) => total + value, 0) / finiteValues.length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

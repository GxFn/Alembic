import {
  type EngineeringDependencyGraph,
  type EngineeringModuleRelationEdge,
  isExternalEngineeringDependencyNode,
  normalizeEngineeringDependencyNode,
} from "../foundation/types.js";
import {
  computeEngineeringFanMetrics,
  type EngineeringWeightedEdge,
  findEngineeringCycles,
  mergeEngineeringWeightedEdges,
} from "../graph/primitives.js";
import { engineeringModuleNameForPath } from "../workspace/paths.js";
import { inferLayers } from "./refiner-layers.js";
import { refineRoles } from "./refiner-roles.js";
import type {
  EngineeringCouplingEdge,
  EngineeringExternalDependencyRefinement,
  EngineeringPanoramaModuleSummary,
  EngineeringPanoramaRefinement,
  EngineeringPanoramaRefinerInput,
} from "./types.js";

const EDGE_WEIGHTS: Readonly<Record<string, number>> = {
  calls: 1,
  constructs: 1,
  data_flow: 0.8,
  dependency: 0.5,
  depends_on: 0.5,
  internal: 0.5,
  package: 0.5,
  targetDependency: 0.5,
};

/**
 * EngineeringPanoramaRefiner 是独立工程模块的全景精化层。
 * 中文说明：它只依赖 lib/engineering 底层，不依赖旧主线、旧 DB、旧 repository 或插件入口。
 */
export class EngineeringPanoramaRefiner {
  refine(input: EngineeringPanoramaRefinerInput): EngineeringPanoramaRefinement {
    const moduleFiles = buildModuleFiles(input.files, input.panorama.modules);
    const localModules = collectLocalModules(
      input.dependencyGraph,
      input.panorama.modules,
      moduleFiles,
    );
    const moduleLayerMap = buildModuleLayerMap(input.dependencyGraph);
    const edges = buildCouplingEdges(input.relationships.moduleEdges);
    const cycles = findEngineeringCycles(edges, [...localModules, ...edgeNodes(edges)]);
    const metrics = computeEngineeringFanMetrics(edges, [...localModules]);
    const externalDeps = computeExternalDeps(edges, localModules);
    const layerResult = inferLayers(edges, [...localModules].sort(), cycles, {
      configLayers: input.dependencyGraph.layers ?? [],
      moduleLayerMap,
    });
    const roles = refineRoles({
      projectRoot: input.projectRoot,
      modules: input.panorama.modules,
      moduleFiles,
      moduleLayerMap,
      edges,
      metrics,
      layers: layerResult.levels,
      codeGraph: input.codeGraph,
    });

    return {
      edges,
      cycles,
      metrics,
      externalDeps,
      roles,
      layers: layerResult.levels,
      layerViolations: layerResult.violations,
      configBasedLayers: layerResult.configBased,
    };
  }
}

function buildCouplingEdges(
  relationEdges: readonly EngineeringModuleRelationEdge[],
): EngineeringCouplingEdge[] {
  const sourceSets = new Map<string, Set<EngineeringModuleRelationEdge["source"]>>();
  const weightedEdges = relationEdges.flatMap((edge): EngineeringWeightedEdge[] => {
    if (!edge.from || !edge.to || edge.from === edge.to) {
      return [];
    }
    const relation = normalizeRelation(edge.relation);
    const key = edgeKey(edge.from, edge.to, relation);
    const sources = sourceSets.get(key) ?? new Set<EngineeringModuleRelationEdge["source"]>();
    sources.add(edge.source);
    sourceSets.set(key, sources);
    return [
      {
        from: edge.from,
        to: edge.to,
        relation,
        weight: edgeWeight(edge, relation),
      },
    ];
  });

  return mergeEngineeringWeightedEdges(weightedEdges).map((edge) => ({
    ...edge,
    sources: [...(sourceSets.get(edgeKey(edge.from, edge.to, edge.relation)) ?? [])].sort(),
  }));
}

function normalizeRelation(relation: string): string {
  if (relation === "call" || relation === "calls") {
    return "calls";
  }
  if (relation === "dataFlow" || relation === "data_flow") {
    return "data_flow";
  }
  if (relation === "dependency") {
    return "depends_on";
  }
  return relation;
}

function edgeWeight(edge: EngineeringModuleRelationEdge, relation: string): number {
  return (EDGE_WEIGHTS[relation] ?? 0.5) * Math.max(1, edge.weight);
}

function computeExternalDeps(
  edges: readonly EngineeringCouplingEdge[],
  localModules: ReadonlySet<string>,
): EngineeringExternalDependencyRefinement[] {
  const external = new Map<string, { readonly dependedBy: Set<string>; weight: number }>();
  for (const edge of edges) {
    if (!localModules.has(edge.from) || localModules.has(edge.to)) {
      continue;
    }
    const current = external.get(edge.to) ?? { dependedBy: new Set<string>(), weight: 0 };
    current.dependedBy.add(edge.from);
    current.weight += edge.weight;
    external.set(edge.to, current);
  }
  return [...external.entries()]
    .map(([name, value]) => ({
      name,
      fanIn: value.dependedBy.size,
      dependedBy: [...value.dependedBy].sort(),
      weight: roundWeight(value.weight),
    }))
    .sort(
      (left, right) =>
        right.fanIn - left.fanIn ||
        right.weight - left.weight ||
        left.name.localeCompare(right.name),
    );
}

function buildModuleFiles(
  files: readonly EngineeringPanoramaRefinerInput["files"][number][],
  modules: readonly EngineeringPanoramaModuleSummary[],
): ReadonlyMap<string, readonly string[]> {
  const byModule = new Map<string, Set<string>>();
  const add = (moduleName: string, relativePath: string): void => {
    const current = byModule.get(moduleName) ?? new Set<string>();
    current.add(relativePath);
    byModule.set(moduleName, current);
  };

  for (const file of files) {
    add(engineeringModuleNameForPath(file.relativePath), file.relativePath);
    if (file.targetName) {
      add(file.targetName, file.relativePath);
    }
  }
  for (const module of modules) {
    for (const filePath of module.representativePaths) {
      add(module.name, filePath);
    }
  }

  return new Map(
    [...byModule.entries()]
      .map(([moduleName, paths]) => [moduleName, [...paths].sort()] as const)
      .sort((left, right) => left[0].localeCompare(right[0])),
  );
}

function collectLocalModules(
  dependencyGraph: EngineeringDependencyGraph,
  modules: readonly EngineeringPanoramaModuleSummary[],
  moduleFiles: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const local = new Set<string>(modules.map((module) => module.name));
  for (const moduleName of moduleFiles.keys()) {
    local.add(moduleName);
  }
  for (const node of dependencyGraph.nodes) {
    const normalized = normalizeEngineeringDependencyNode(node);
    if (!isExternalEngineeringDependencyNode(normalized)) {
      local.add(normalized.id);
    }
  }
  return new Set([...local].filter(Boolean).sort());
}

function buildModuleLayerMap(
  dependencyGraph: EngineeringDependencyGraph,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const node of dependencyGraph.nodes) {
    const normalized = normalizeEngineeringDependencyNode(node);
    if (typeof normalized.layer === "string" && normalized.layer) {
      map.set(normalized.id, normalized.layer);
    }
  }
  return new Map([...map.entries()].sort((left, right) => left[0].localeCompare(right[0])));
}

function edgeNodes(edges: readonly EngineeringCouplingEdge[]): readonly string[] {
  return [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))].sort();
}

function edgeKey(from: string, to: string, relation: string): string {
  return `${from}\u0000${to}\u0000${relation}`;
}

function roundWeight(value: number): number {
  return Math.round(value * 1000) / 1000;
}

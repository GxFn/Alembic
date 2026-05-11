import {
  type EngineeringDependencyGraph,
  type EngineeringDependencyGraphLayer,
  type EngineeringLayerLevel,
  type EngineeringLayerViolation,
  type EngineeringModuleCycle,
  type EngineeringModuleRelationEdge,
  isExternalEngineeringDependencyNode,
  normalizeEngineeringDependencyNode,
} from "../foundation/EngineeringCoreTypes.js";
import {
  computeEngineeringFanMetrics,
  type EngineeringWeightedEdge,
  findEngineeringCycles,
  mergeEngineeringWeightedEdges,
} from "../graph/EngineeringGraphPrimitives.js";
import { EngineeringLanguageProfiles } from "../language/EngineeringLanguageProfiles.js";
import { engineeringModuleNameForPath } from "../workspace/EngineeringWorkspacePaths.js";
import type {
  EngineeringCouplingEdge,
  EngineeringCouplingMetrics,
  EngineeringExternalDependencyRefinement,
  EngineeringPanoramaModuleSummary,
  EngineeringPanoramaRefinement,
  EngineeringPanoramaRefinerInput,
  EngineeringRefinedRole,
  EngineeringRoleResolution,
  EngineeringRoleSignal,
} from "./EngineeringPanoramaTypes.js";

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

const ROLE_WEIGHTS = {
  ast: 0.3,
  callGraph: 0.3,
  dataFlow: 0.15,
  entityGraph: 0.1,
  regex: 0.15,
} as const;

const LAYER_NAME_HINTS: readonly { readonly pattern: RegExp; readonly name: string }[] = [
  { pattern: /^(foundation|core|base|shared|common)$/i, name: "Foundation" },
  { pattern: /foundation/i, name: "Foundation" },
  { pattern: /^(model|entity|dto)$/i, name: "Model" },
  { pattern: /service|repository|manager|provider|store/i, name: "Service" },
  { pattern: /network|api|http/i, name: "Networking" },
  { pattern: /(?:^ui$|^ui[A-Z]|view|screen|component|widget)/i, name: "UI" },
  { pattern: /router|coordinator|navigation/i, name: "Routing" },
  { pattern: /^(app|main|launch|entry)$/i, name: "Application" },
  { pattern: /test|spec|mock/i, name: "Test" },
];

interface LayerResult {
  readonly levels: readonly EngineeringLayerLevel[];
  readonly violations: readonly EngineeringLayerViolation[];
  readonly configBased: boolean;
}

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

function inferLayers(
  edges: readonly EngineeringCouplingEdge[],
  modules: readonly string[],
  cycles: readonly EngineeringModuleCycle[],
  options: {
    readonly configLayers: readonly EngineeringDependencyGraphLayer[];
    readonly moduleLayerMap: ReadonlyMap<string, string>;
  },
): LayerResult {
  if (options.configLayers.length > 0 && options.moduleLayerMap.size > 0) {
    const coverage =
      modules.length === 0
        ? 0
        : modules.filter((moduleName) => options.moduleLayerMap.has(moduleName)).length /
          modules.length;
    if (coverage >= 0.5) {
      return inferLayersFromConfig(edges, modules, options.configLayers, options.moduleLayerMap);
    }
  }
  return inferLayersFromTopology(edges, modules, cycles);
}

function inferLayersFromConfig(
  edges: readonly EngineeringCouplingEdge[],
  modules: readonly string[],
  configLayers: readonly EngineeringDependencyGraphLayer[],
  moduleLayerMap: ReadonlyMap<string, string>,
): LayerResult {
  const sortedLayers = [...configLayers].sort(
    (left, right) => left.order - right.order || left.name.localeCompare(right.name),
  );
  const maxOrder = Math.max(...sortedLayers.map((layer) => layer.order), 0);
  const layerNameToLevel = new Map(
    sortedLayers.map((layer) => [layer.name, maxOrder - layer.order]),
  );
  const moduleLevels = new Map<string, number>();

  for (const moduleName of modules) {
    const layerName = moduleLayerMap.get(moduleName);
    const level = layerName ? layerNameToLevel.get(layerName) : undefined;
    if (level !== undefined) {
      moduleLevels.set(moduleName, level);
    }
  }

  for (const moduleName of modules) {
    if (moduleLevels.has(moduleName)) {
      continue;
    }
    moduleLevels.set(
      moduleName,
      inferNearestConfiguredLayer(moduleName, edges, moduleLevels, maxOrder),
    );
  }

  const levelToConfigName = new Map(
    sortedLayers.map((layer) => [maxOrder - layer.order, layer.name]),
  );
  return {
    levels: groupLayerLevels(
      moduleLevels,
      (level, groupedModules, total) =>
        levelToConfigName.get(level) ?? inferLayerName(level, groupedModules, total),
      "config",
    ),
    violations: detectLayerViolations(edges, moduleLevels),
    configBased: true,
  };
}

function inferNearestConfiguredLayer(
  moduleName: string,
  edges: readonly EngineeringCouplingEdge[],
  moduleLevels: ReadonlyMap<string, number>,
  maxOrder: number,
): number {
  let bestLevel = maxOrder + 1;
  for (const edge of edges.filter((candidate) => candidate.from === moduleName)) {
    const targetLevel = moduleLevels.get(edge.to);
    if (targetLevel !== undefined) {
      bestLevel = Math.min(bestLevel, targetLevel + 1);
    }
  }
  if (bestLevel > maxOrder) {
    for (const edge of edges.filter((candidate) => candidate.to === moduleName)) {
      const sourceLevel = moduleLevels.get(edge.from);
      if (sourceLevel !== undefined) {
        bestLevel = Math.min(bestLevel, Math.max(0, sourceLevel - 1));
      }
    }
  }
  return bestLevel > maxOrder ? maxOrder : bestLevel;
}

function inferLayersFromTopology(
  edges: readonly EngineeringCouplingEdge[],
  modules: readonly string[],
  cycles: readonly EngineeringModuleCycle[],
): LayerResult {
  const allModules = new Set(modules);
  const cycleEdges = new Set<string>();
  for (const cycle of cycles) {
    for (let index = 0; index < cycle.cycle.length; index += 1) {
      const from = cycle.cycle[index];
      const to = cycle.cycle[(index + 1) % cycle.cycle.length];
      if (from && to) {
        cycleEdges.add(`${from}\u0000${to}`);
      }
    }
  }

  const adjacency = new Map<string, Set<string>>();
  for (const moduleName of allModules) {
    adjacency.set(moduleName, new Set());
  }
  for (const edge of edges) {
    if (!allModules.has(edge.from) || !allModules.has(edge.to) || edge.from === edge.to) {
      continue;
    }
    if (!cycleEdges.has(`${edge.from}\u0000${edge.to}`)) {
      adjacency.get(edge.from)?.add(edge.to);
    }
  }

  const levels = new Map<string, number>();
  const active = new Set<string>();
  const computeLevel = (moduleName: string): number => {
    const cached = levels.get(moduleName);
    if (cached !== undefined) {
      return cached;
    }
    if (active.has(moduleName)) {
      return 0;
    }
    active.add(moduleName);
    const deps = [...(adjacency.get(moduleName) ?? [])].sort();
    const level = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => computeLevel(dep))) + 1;
    active.delete(moduleName);
    levels.set(moduleName, level);
    return level;
  };

  for (const moduleName of [...allModules].sort()) {
    computeLevel(moduleName);
  }

  return {
    levels: groupLayerLevels(levels, inferLayerName, "topology"),
    violations: detectLayerViolations(edges, levels),
    configBased: false,
  };
}

function refineRoles(input: {
  readonly projectRoot: string;
  readonly modules: readonly EngineeringPanoramaModuleSummary[];
  readonly moduleFiles: ReadonlyMap<string, readonly string[]>;
  readonly moduleLayerMap: ReadonlyMap<string, string>;
  readonly edges: readonly EngineeringCouplingEdge[];
  readonly metrics: ReadonlyMap<string, EngineeringCouplingMetrics>;
  readonly layers: readonly EngineeringLayerLevel[];
  readonly codeGraph: EngineeringPanoramaRefinerInput["codeGraph"];
}): ReadonlyMap<string, EngineeringRefinedRole> {
  const roles = new Map<string, EngineeringRefinedRole>();
  const projectDirName =
    input.projectRoot.replace(/\/+$/, "").split("/").pop()?.toLowerCase() ?? "";
  const layerByModule = new Map<string, EngineeringLayerLevel>();
  for (const layer of input.layers) {
    for (const moduleName of layer.modules) {
      layerByModule.set(moduleName, layer);
    }
  }

  for (const module of input.modules) {
    const signals: EngineeringRoleSignal[] = [
      ...extractAstSignals(module, input.moduleFiles, input.codeGraph),
      ...extractCallSignals(module.name, input.edges, input.metrics),
      ...extractDataFlowSignals(module.name, input.edges),
      ...extractTopologySignals(module.name, input.metrics, layerByModule.get(module.name)),
    ];

    const configRole = EngineeringLanguageProfiles.roleForConfigLayer(
      input.moduleLayerMap.get(module.name),
    );
    if (configRole) {
      signals.push({
        role: configRole,
        confidence: 0.85,
        weight: ROLE_WEIGHTS.ast,
        source: "config-layer",
      });
    }

    signals.push({
      role: EngineeringLanguageProfiles.normalizeRoleAlias(module.role),
      confidence: 0.5,
      weight: ROLE_WEIGHTS.regex,
      source: "regex-baseline",
    });

    if (projectDirName && module.name.toLowerCase() === projectDirName) {
      signals.push({
        role: "app",
        confidence: 0.95,
        weight: ROLE_WEIGHTS.ast,
        source: "project-name-match",
      });
    }

    roles.set(
      module.name,
      resolveRoleSignals(signals, EngineeringLanguageProfiles.normalizeRoleAlias(module.role)),
    );
  }

  return new Map([...roles.entries()].sort((left, right) => left[0].localeCompare(right[0])));
}

function extractAstSignals(
  module: EngineeringPanoramaModuleSummary,
  moduleFiles: ReadonlyMap<string, readonly string[]>,
  codeGraph: EngineeringPanoramaRefinerInput["codeGraph"],
): EngineeringRoleSignal[] {
  const files = moduleFiles.get(module.name) ?? [];
  if (files.length === 0) {
    return [];
  }
  const families = EngineeringLanguageProfiles.resolveFamiliesForLanguages(module.languages);
  const superclassRoles = EngineeringLanguageProfiles.superclassRoles(families);
  const protocolRoles = EngineeringLanguageProfiles.protocolRoles(families);
  const importRolePatterns = EngineeringLanguageProfiles.importRolePatterns(families);
  const roleCounts = new Map<string, number>();

  for (const filePath of files) {
    const symbols = codeGraph.getFileSymbols(filePath);
    if (!symbols) {
      continue;
    }
    for (const className of symbols.classes) {
      const classInfo = codeGraph.getClassInfo(className);
      const superRole = classInfo?.superClass ? superclassRoles[classInfo.superClass] : undefined;
      if (superRole) {
        addRoleCount(roleCounts, superRole, 1);
      }
      for (const protocolName of classInfo?.protocols ?? []) {
        const protocolRole = protocolRoles[protocolName];
        if (protocolRole) {
          addRoleCount(roleCounts, protocolRole, 0.5);
        }
      }
    }
    for (const protocolName of symbols.protocols) {
      const protocolRole = protocolRoles[protocolName];
      if (protocolRole) {
        addRoleCount(roleCounts, protocolRole, 0.5);
      }
    }
    for (const importRecord of symbols.imports) {
      const text = JSON.stringify(importRecord)?.toLowerCase() ?? "";
      for (const pattern of importRolePatterns) {
        if (pattern.regex.test(text)) {
          addRoleCount(roleCounts, pattern.role, 0.5);
        }
      }
    }
  }

  const total = [...roleCounts.values()].reduce((sum, count) => sum + count, 0);
  if (total <= 0) {
    return [];
  }
  return [...roleCounts.entries()]
    .map(([role, count]) => ({
      role,
      confidence: Math.min(count / total, 1),
      weight: ROLE_WEIGHTS.ast,
      source: "ast-structure",
    }))
    .sort(
      (left, right) => right.confidence - left.confidence || left.role.localeCompare(right.role),
    );
}

function extractCallSignals(
  moduleName: string,
  edges: readonly EngineeringCouplingEdge[],
  metrics: ReadonlyMap<string, EngineeringCouplingMetrics>,
): EngineeringRoleSignal[] {
  const callIn = edges.filter((edge) => edge.to === moduleName && edge.relation === "calls").length;
  const callOut = edges.filter(
    (edge) => edge.from === moduleName && edge.relation === "calls",
  ).length;
  const totalCalls = callIn + callOut;
  if (totalCalls <= 0) {
    const metric = metrics.get(moduleName);
    if (!metric || metric.fanIn + metric.fanOut === 0) {
      return [];
    }
    const ratio = metric.fanIn / (metric.fanIn + metric.fanOut);
    if (ratio > 0.7) {
      return [
        {
          role: "core",
          confidence: ratio * 0.6,
          weight: ROLE_WEIGHTS.callGraph,
          source: "coupling-fanin-heavy",
        },
      ];
    }
    if (ratio < 0.3) {
      return [
        {
          role: "ui",
          confidence: (1 - ratio) * 0.5,
          weight: ROLE_WEIGHTS.callGraph,
          source: "coupling-fanout-heavy",
        },
      ];
    }
    return [
      {
        role: "service",
        confidence: 0.45,
        weight: ROLE_WEIGHTS.callGraph,
        source: "coupling-balanced",
      },
    ];
  }

  const ratio = callIn / totalCalls;
  if (ratio > 0.7) {
    return [
      {
        role: "core",
        confidence: ratio * 0.8,
        weight: ROLE_WEIGHTS.callGraph,
        source: "call-fanin-heavy",
      },
    ];
  }
  if (ratio < 0.3) {
    return [
      {
        role: "ui",
        confidence: (1 - ratio) * 0.6,
        weight: ROLE_WEIGHTS.callGraph,
        source: "call-fanout-heavy",
      },
    ];
  }
  return [
    { role: "service", confidence: 0.5, weight: ROLE_WEIGHTS.callGraph, source: "call-balanced" },
  ];
}

function extractDataFlowSignals(
  moduleName: string,
  edges: readonly EngineeringCouplingEdge[],
): EngineeringRoleSignal[] {
  const out = edges.filter(
    (edge) => edge.from === moduleName && edge.relation === "data_flow",
  ).length;
  const input = edges.filter(
    (edge) => edge.to === moduleName && edge.relation === "data_flow",
  ).length;
  if (out + input === 0) {
    return [];
  }
  const signals: EngineeringRoleSignal[] = [];
  if (out > input * 2) {
    signals.push({
      role: "model",
      confidence: 0.6,
      weight: ROLE_WEIGHTS.dataFlow,
      source: "dataflow-producer",
    });
  }
  if (input > out * 2) {
    signals.push({
      role: "ui",
      confidence: 0.5,
      weight: ROLE_WEIGHTS.dataFlow,
      source: "dataflow-consumer",
    });
  }
  return signals;
}

function extractTopologySignals(
  moduleName: string,
  metrics: ReadonlyMap<string, EngineeringCouplingMetrics>,
  layer: EngineeringLayerLevel | undefined,
): EngineeringRoleSignal[] {
  const metric = metrics.get(moduleName);
  const signals: EngineeringRoleSignal[] = [];
  if (metric && metric.fanIn >= 3 && metric.fanOut <= 1) {
    signals.push({
      role: "core",
      confidence: 0.55,
      weight: ROLE_WEIGHTS.entityGraph,
      source: "topology-hot-foundation",
    });
  }
  if (metric && metric.fanOut >= 3 && metric.fanIn <= 1) {
    signals.push({
      role: "app",
      confidence: 0.45,
      weight: ROLE_WEIGHTS.entityGraph,
      source: "topology-orchestrator",
    });
  }
  const role = EngineeringLanguageProfiles.roleForConfigLayer(layer?.name);
  if (role) {
    signals.push({ role, confidence: 0.4, weight: ROLE_WEIGHTS.entityGraph, source: "layer-name" });
  }
  return signals;
}

function resolveRoleSignals(
  signals: readonly EngineeringRoleSignal[],
  fallbackRole: string,
): EngineeringRefinedRole {
  const scores = new Map<string, number>();
  for (const signal of signals) {
    scores.set(signal.role, (scores.get(signal.role) ?? 0) + signal.confidence * signal.weight);
  }
  const sorted = [...scores.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  if (sorted.length === 0) {
    return {
      refinedRole: fallbackRole,
      confidence: 0,
      resolution: "fallback",
      alternatives: [],
      signals,
    };
  }
  const [topRole, topScore] = sorted[0] ?? [fallbackRole, 0];
  const secondScore = sorted[1]?.[1] ?? 0;
  const resolution: EngineeringRoleResolution =
    topScore > 0.7
      ? "clear"
      : topScore - secondScore < 0.1
        ? "uncertain"
        : topScore > 0.4
          ? "clear"
          : "fallback";
  return {
    refinedRole: topRole,
    confidence: Math.min(roundWeight(topScore), 1),
    resolution,
    alternatives: sorted.slice(0, 3).map(([role, score]) => [role, roundWeight(score)]),
    signals,
  };
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

function groupLayerLevels(
  moduleLevels: ReadonlyMap<string, number>,
  nameForLayer: (level: number, modules: readonly string[], totalLevels: number) => string,
  source: EngineeringLayerLevel["source"],
): EngineeringLayerLevel[] {
  const layerGroups = new Map<number, string[]>();
  for (const [moduleName, level] of moduleLevels) {
    layerGroups.set(level, [...(layerGroups.get(level) ?? []), moduleName]);
  }
  const sortedGroups = [...layerGroups.entries()].sort((left, right) => left[0] - right[0]);
  return sortedGroups.map(([level, groupedModules]) => {
    const modules = groupedModules.sort();
    return { level, name: nameForLayer(level, modules, sortedGroups.length), modules, source };
  });
}

function detectLayerViolations(
  edges: readonly EngineeringCouplingEdge[],
  moduleLevels: ReadonlyMap<string, number>,
): EngineeringLayerViolation[] {
  return edges.flatMap((edge) => {
    const fromLayer = moduleLevels.get(edge.from);
    const toLayer = moduleLevels.get(edge.to);
    if (fromLayer === undefined || toLayer === undefined || fromLayer >= toLayer) {
      return [];
    }
    return [{ from: edge.from, to: edge.to, fromLayer, toLayer, relation: edge.relation }];
  });
}

function inferLayerName(level: number, modules: readonly string[], totalLevels: number): string {
  const votes = new Map<string, number>();
  for (const moduleName of modules) {
    for (const hint of LAYER_NAME_HINTS) {
      if (hint.pattern.test(moduleName)) {
        votes.set(hint.name, (votes.get(hint.name) ?? 0) + 1);
        break;
      }
    }
  }
  if (votes.size > 0) {
    return (
      [...votes.entries()].sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )[0]?.[0] ?? "Feature"
    );
  }
  const position = totalLevels > 1 ? level / (totalLevels - 1) : 0.5;
  if (position <= 0.2) {
    return "Foundation";
  }
  if (position <= 0.5) {
    return "Service";
  }
  if (position <= 0.8) {
    return "Feature";
  }
  return "Application";
}

function addRoleCount(counts: Map<string, number>, role: string, amount: number): void {
  counts.set(role, (counts.get(role) ?? 0) + amount);
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

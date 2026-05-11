import type {
  EngineeringDependencyGraphLayer,
  EngineeringLayerLevel,
  EngineeringLayerViolation,
  EngineeringModuleCycle,
} from "../foundation/types.js";
import type { EngineeringCouplingEdge } from "./types.js";

export interface LayerResult {
  readonly levels: readonly EngineeringLayerLevel[];
  readonly violations: readonly EngineeringLayerViolation[];
  readonly configBased: boolean;
}

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

/** 根据配置层优先、拓扑层兜底的策略产出 Panorama 层级和违规边。 */
export function inferLayers(
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

import type { EngineeringLayerLevel } from "../foundation/types.js";
import { EngineeringLanguageProfiles } from "../language/profiles.js";
import type {
  EngineeringCouplingEdge,
  EngineeringCouplingMetrics,
  EngineeringPanoramaModuleSummary,
  EngineeringPanoramaRefinerInput,
  EngineeringRefinedRole,
  EngineeringRoleResolution,
  EngineeringRoleSignal,
} from "./types.js";

const ROLE_WEIGHTS = {
  ast: 0.3,
  callGraph: 0.3,
  dataFlow: 0.15,
  entityGraph: 0.1,
  regex: 0.15,
} as const;

/** 汇总 AST、调用、数据流、拓扑和配置层信号，给 Panorama 模块角色做二次判定。 */
export function refineRoles(input: {
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

function addRoleCount(counts: Map<string, number>, role: string, amount: number): void {
  counts.set(role, (counts.get(role) ?? 0) + amount);
}

function roundWeight(value: number): number {
  return Math.round(value * 1000) / 1000;
}

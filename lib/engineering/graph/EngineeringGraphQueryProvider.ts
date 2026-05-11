import { EngineeringCodeGraph } from "../code/EngineeringCodeGraph.js";
import type {
  EngineeringCodeCallGraphEdge,
  EngineeringCodeClassInfo,
} from "../code/EngineeringCodeGraphModel.js";
import { EngineeringEntityGraph } from "../entity/EngineeringEntityGraph.js";
import type { EngineeringDependencyGraph } from "../foundation/EngineeringCoreTypes.js";
import type { EngineeringPanoramaSnapshot } from "../panorama/EngineeringPanoramaTypes.js";
import type {
  EngineeringEntityGraphSnapshot,
  EngineeringWorkflowArtifact,
} from "../workflow/EngineeringWorkflowTypes.js";

export type EngineeringGraphTraversalDirection = "incoming" | "outgoing" | "both";

export type EngineeringGraphQueryOperation =
  | "callers"
  | "callees"
  | "impact"
  | "dependencies"
  | "cycles"
  | "class"
  | "protocol"
  | "hierarchy"
  | "overrides"
  | "extensions"
  | "search";

export interface EngineeringGraphQueryInput {
  readonly operation: EngineeringGraphQueryOperation;
  readonly ref?: string;
  readonly entity?: string;
  readonly maxDepth?: number;
  readonly limit?: number;
  readonly direction?: EngineeringGraphTraversalDirection;
  readonly includeStart?: boolean;
}

export interface EngineeringGraphOverviewResult {
  readonly source: "engineering";
  readonly projectRoot: string;
  readonly files: {
    readonly total: number;
    readonly byLanguage: Readonly<Record<string, number>>;
  };
  readonly targets: readonly string[];
  readonly code: {
    readonly totalFiles: number;
    readonly totalClasses: number;
    readonly totalProtocols: number;
    readonly totalMethods: number;
    readonly callEdges: number;
    readonly dataFlowEdges: number;
  };
  readonly dependencies: {
    readonly nodes: number;
    readonly edges: number;
    readonly cycles: number;
  };
  readonly entities: {
    readonly total: number;
    readonly edges: number;
    readonly byType: Readonly<Record<string, number>>;
  };
  readonly panorama: {
    readonly moduleCount: number;
    readonly externalDependencyCount: number;
    readonly healthScore: number | null;
    readonly gaps: number;
  };
}

export interface EngineeringGraphQueryResult {
  readonly operation: EngineeringGraphQueryOperation;
  readonly ref?: string;
  readonly entity?: string;
  readonly result: unknown;
}

export interface EngineeringGraphQueryProvider {
  overview(): Promise<EngineeringGraphOverviewResult> | EngineeringGraphOverviewResult;
  query(
    input: EngineeringGraphQueryInput,
  ): Promise<EngineeringGraphQueryResult> | EngineeringGraphQueryResult;
}

export interface EngineeringWorkflowGraphQueryProviderInput {
  readonly artifact: EngineeringWorkflowArtifact;
}

/**
 * Agent-facing engineering graph read model.
 * 中文说明：工具层只依赖这个统一工程视图，不再感知旧 projectGraph/codeEntityGraph 分叉。
 */
export class EngineeringWorkflowGraphQueryProvider implements EngineeringGraphQueryProvider {
  readonly #artifact: EngineeringWorkflowArtifact;
  readonly #codeGraph: EngineeringCodeGraph;
  readonly #entityGraph: EngineeringEntityGraph;

  constructor(input: EngineeringWorkflowGraphQueryProviderInput) {
    this.#artifact = input.artifact;
    this.#codeGraph = EngineeringCodeGraph.fromJSON(input.artifact.codeGraph);
    this.#entityGraph = entityGraphFromSnapshot(input.artifact.entityGraph);
  }

  overview(): EngineeringGraphOverviewResult {
    const codeOverview = this.#codeGraph.getOverview();
    const entityCounts = countBy(this.#artifact.entityGraph.entities.map((entity) => entity.type));
    const panorama = this.#artifact.panoramaSnapshot;
    return {
      source: "engineering",
      projectRoot: this.#artifact.projectRoot,
      files: {
        total: this.#artifact.files.length,
        byLanguage: countBy(this.#artifact.files.map((file) => file.language)),
      },
      targets: this.#artifact.targets.map((target) => target.name).sort(),
      code: {
        totalFiles: codeOverview.totalFiles,
        totalClasses: codeOverview.totalClasses,
        totalProtocols: codeOverview.totalProtocols,
        totalMethods: codeOverview.totalMethods,
        callEdges: this.#artifact.callGraph.length,
        dataFlowEdges: this.#artifact.dataFlow.length,
      },
      dependencies: {
        nodes: this.#artifact.dependencyGraph.nodes.length,
        edges: this.#artifact.dependencyGraph.edges.length,
        cycles: dependencyCycles(this.#artifact.dependencyGraph, panorama).length,
      },
      entities: {
        total: this.#artifact.entityGraph.entities.length,
        edges: this.#artifact.entityGraph.edges.length,
        byType: entityCounts,
      },
      panorama: {
        moduleCount: panorama?.overview.moduleCount ?? 0,
        externalDependencyCount: panorama?.overview.externalDependencyCount ?? 0,
        healthScore: panoramaHealthScore(panorama),
        gaps: panorama?.gaps.length ?? 0,
      },
    };
  }

  query(input: EngineeringGraphQueryInput): EngineeringGraphQueryResult {
    const entity = input.entity ?? input.ref;
    const ref = input.ref ?? input.entity;
    const limit = bounded(input.limit, 20, 100);
    const maxDepth = bounded(input.maxDepth, 1, 8);
    const direction = input.direction ?? "both";
    const queryInput = {
      limit,
      maxDepth,
      direction,
      includeStart: input.includeStart === true,
      ...(entity === undefined ? {} : { entity }),
      ...(ref === undefined ? {} : { ref }),
    };
    const result = this.#runQuery(input.operation, queryInput);
    return {
      operation: input.operation,
      ...(ref === undefined ? {} : { ref }),
      ...(entity === undefined ? {} : { entity }),
      result,
    };
  }

  #runQuery(
    operation: EngineeringGraphQueryOperation,
    input: {
      readonly entity?: string;
      readonly ref?: string;
      readonly limit: number;
      readonly maxDepth: number;
      readonly direction: EngineeringGraphTraversalDirection;
      readonly includeStart: boolean;
    },
  ): unknown {
    switch (operation) {
      case "callers":
        return this.#callers(requiredRef(operation, input.ref), input.limit);
      case "callees":
        return this.#callees(requiredRef(operation, input.ref), input.limit);
      case "impact":
        return this.#impact(
          requiredRef(operation, input.ref),
          input.maxDepth,
          input.direction,
          input.includeStart,
        );
      case "dependencies":
        return dependencyAdjacency(this.#artifact.dependencyGraph, input.ref);
      case "cycles":
        return dependencyCycles(
          this.#artifact.dependencyGraph,
          this.#artifact.panoramaSnapshot,
          input.ref,
        );
      case "class":
        return this.#codeGraph.getClassInfo(requiredEntity(operation, input.entity));
      case "protocol":
        return this.#codeGraph.getProtocolInfo(requiredEntity(operation, input.entity));
      case "hierarchy":
        return this.#hierarchy(requiredEntity(operation, input.entity));
      case "overrides":
        return this.#overrides(requiredEntity(operation, input.entity));
      case "extensions":
        return this.#codeGraph.getCategoryExtensions(requiredEntity(operation, input.entity));
      case "search":
        return this.#search(requiredEntity(operation, input.entity), input.limit);
    }
  }

  #callers(ref: string, limit: number): readonly unknown[] {
    const entityId = this.#resolveEntityId(ref);
    return dedupeUnknownByJson([
      ...(entityId ? this.#entityGraph.getCallers(entityId, 1) : []),
      ...this.#codeGraph
        .getCallGraphEdges({ callee: ref })
        .map((edge) => callRelation(edge, "caller")),
    ]).slice(0, limit);
  }

  #callees(ref: string, limit: number): readonly unknown[] {
    const entityId = this.#resolveEntityId(ref);
    return dedupeUnknownByJson([
      ...(entityId ? this.#entityGraph.getCallees(entityId, 1) : []),
      ...this.#codeGraph
        .getCallGraphEdges({ caller: ref })
        .map((edge) => callRelation(edge, "callee")),
    ]).slice(0, limit);
  }

  #impact(
    ref: string,
    maxDepth: number,
    direction: EngineeringGraphTraversalDirection,
    includeStart: boolean,
  ) {
    const entityId = this.#resolveEntityId(ref);
    if (!entityId) {
      return { root: ref, depth: maxDepth, direction, nodes: [], edges: [], distanceById: {} };
    }
    const radius = this.#entityGraph.getImpactRadius(entityId, maxDepth, direction);
    if (includeStart) {
      return radius;
    }
    return {
      ...radius,
      nodes: radius.nodes.filter((node) => node.id !== entityId),
      edges: radius.edges.filter((edge) => edge.from !== entityId || edge.to !== entityId),
      distanceById: Object.fromEntries(
        Object.entries(radius.distanceById).filter(([id]) => id !== entityId),
      ),
    };
  }

  #hierarchy(entity: string) {
    return {
      className: entity,
      inheritanceChain: this.#codeGraph.getInheritanceChain(entity),
      subclasses: this.#codeGraph.getSubclasses(entity),
      descendants: this.#codeGraph.getAllDescendants(entity),
    };
  }

  #overrides(entity: string) {
    const [className, methodName] = splitMethodRef(entity);
    if (!methodName) {
      return [];
    }
    return this.#codeGraph.getMethodOverrides(className, methodName);
  }

  #search(query: string, limit: number) {
    const entities = this.#entityGraph.searchByName(query, limit);
    const classNames = this.#codeGraph.searchClasses(query, limit);
    return {
      entities,
      classes: classNames
        .map((className) => this.#codeGraph.getClassInfo(className))
        .filter((classInfo): classInfo is EngineeringCodeClassInfo => classInfo !== null)
        .slice(0, limit),
    };
  }

  #resolveEntityId(ref: string): string | null {
    const candidates = entityIdCandidates(ref);
    for (const candidate of candidates) {
      if (this.#entityGraph.findEntity(candidate)) {
        return candidate;
      }
    }
    const byName = this.#artifact.entityGraph.entities.find(
      (entity) => entity.name === ref || entity.id === ref || entity.filePath === ref,
    );
    return byName?.id ?? null;
  }
}

function entityGraphFromSnapshot(snapshot: EngineeringEntityGraphSnapshot): EngineeringEntityGraph {
  const graph = new EngineeringEntityGraph();
  for (const entity of snapshot.entities) {
    graph.addEntity(entity);
  }
  for (const edge of snapshot.edges) {
    graph.addEdge(edge);
  }
  return graph;
}

function dependencyAdjacency(
  dependencyGraph: EngineeringDependencyGraph,
  ref?: string,
): readonly unknown[] {
  const nodeIds = dependencyGraph.nodes.map((node) => (typeof node === "string" ? node : node.id));
  const selected = ref ? nodeIds.filter((nodeId) => nodeMatchesRef(nodeId, ref)) : nodeIds;
  return selected.sort().map((nodeId) => ({
    node: nodeId,
    dependencies: dependencyGraph.edges
      .filter((edge) => edge.from === nodeId)
      .sort(compareDependencyEdge),
    dependents: dependencyGraph.edges
      .filter((edge) => edge.to === nodeId)
      .sort(compareDependencyEdge),
  }));
}

function dependencyCycles(
  dependencyGraph: EngineeringDependencyGraph,
  panorama: EngineeringPanoramaSnapshot | null,
  ref?: string,
): readonly unknown[] {
  const panoramaCycles =
    panorama?.cycles.map((cycle) => ({
      kind: "module",
      nodes: cycle.cycle,
      severity: cycle.severity,
    })) ?? [];
  const graphCycles = findDependencyCycles(dependencyGraph).map((cycle) => ({
    kind: "dependency",
    nodes: cycle,
    severity: "warning",
  }));
  return [...panoramaCycles, ...graphCycles]
    .filter((cycle) => !ref || cycle.nodes.some((node) => nodeMatchesRef(node, ref)))
    .sort((left, right) => left.nodes.join("\0").localeCompare(right.nodes.join("\0")));
}

function findDependencyCycles(dependencyGraph: EngineeringDependencyGraph): readonly string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of dependencyGraph.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to].sort());
  }
  const cycles = new Map<string, string[]>();
  for (const start of [...adjacency.keys()].sort()) {
    visitCycle(start, start, adjacency, [], cycles);
  }
  return [...cycles.values()].sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0")),
  );
}

function visitCycle(
  start: string,
  current: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  path: readonly string[],
  cycles: Map<string, string[]>,
): void {
  if (path.includes(current)) {
    return;
  }
  const nextPath = [...path, current];
  for (const next of adjacency.get(current) ?? []) {
    if (next === start && nextPath.length > 1) {
      const cycle = canonicalCycle(nextPath);
      cycles.set(cycle.join("\0"), cycle);
      continue;
    }
    if (nextPath.length < 12) {
      visitCycle(start, next, adjacency, nextPath, cycles);
    }
  }
}

function canonicalCycle(cycle: readonly string[]): string[] {
  const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)]);
  return rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")))[0] ?? [];
}

function callRelation(edge: EngineeringCodeCallGraphEdge, side: "caller" | "callee") {
  return {
    symbol: side === "caller" ? edge.caller : edge.callee,
    edge,
  };
}

function dedupeUnknownByJson(values: readonly unknown[]): readonly unknown[] {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
}

function splitMethodRef(ref: string): readonly [string, string | null] {
  const separator = ref.includes("#") ? ref.lastIndexOf("#") : ref.lastIndexOf(".");
  if (separator <= 0 || separator >= ref.length - 1) {
    return [ref, null];
  }
  return [ref.slice(0, separator), ref.slice(separator + 1)];
}

function entityIdCandidates(ref: string): readonly string[] {
  const clean = ref.trim();
  if (!clean) {
    return [];
  }
  if (clean.includes(":")) {
    return [clean];
  }
  return [
    `class:${clean}`,
    `protocol:${clean}`,
    `method:${clean}`,
    `file:${clean}`,
    `module:file:${clean}`,
    `module:${clean}`,
    `target:${clean}`,
    `external:${clean}`,
  ];
}

function requiredRef(operation: string, ref: string | undefined): string {
  if (!ref) {
    throw new Error(`${operation} requires ref.`);
  }
  return ref;
}

function requiredEntity(operation: string, entity: string | undefined): string {
  if (!entity) {
    throw new Error(`${operation} requires entity or ref.`);
  }
  return entity;
}

function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.min(Math.max(0, Math.floor(value)), max);
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function compareDependencyEdge(
  left: EngineeringDependencyGraph["edges"][number],
  right: EngineeringDependencyGraph["edges"][number],
): number {
  return (
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.type.localeCompare(right.type)
  );
}

function nodeMatchesRef(nodeId: string, ref: string): boolean {
  const clean = ref.startsWith("file:") ? ref.slice("file:".length) : ref;
  return nodeId === ref || nodeId === clean || nodeId.endsWith(`:${clean}`);
}

function panoramaHealthScore(panorama: EngineeringPanoramaSnapshot | null): number | null {
  return panorama?.health.score ?? null;
}

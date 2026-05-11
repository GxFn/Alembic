import { EngineeringCodeGraph } from "../code/graph.js";
import type { EngineeringCodeCallGraphEdge, EngineeringCodeClassInfo } from "../code/types.js";
import type {
  EngineeringEntity,
  EngineeringEntityRelation,
  EngineeringEntityType,
} from "../entity/graph.js";
import { EngineeringEntityGraph } from "../entity/graph.js";
import type { EngineeringDependencyGraph } from "../foundation/types.js";
import type { EngineeringPanoramaSnapshot } from "../panorama/types.js";
import type {
  EngineeringEntityGraphSnapshot,
  EngineeringWorkflowArtifact,
} from "../workflow/types.js";

export type EngineeringGraphTraversalDirection = "incoming" | "outgoing" | "both";

export type EngineeringGraphQueryOperation =
  | "callers"
  | "callees"
  | "impact"
  | "path"
  | "topology"
  | "callImpact"
  | "entities"
  | "edges"
  | "conformances"
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
  readonly from?: string;
  readonly to?: string;
  readonly relation?: string;
  readonly entityType?: string;
  readonly query?: string;
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
    this.#entityGraph.addCallGraph(input.artifact.callGraph, input.artifact.dataFlow);
  }

  overview(): EngineeringGraphOverviewResult {
    const codeOverview = this.#codeGraph.getOverview();
    const entities = this.#entityGraph.entities;
    const edges = this.#entityGraph.edges;
    const entityCounts = countBy(entities.map((entity) => entity.type));
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
        total: entities.length,
        edges: edges.length,
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
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
      ...(input.relation === undefined ? {} : { relation: input.relation }),
      ...(input.entityType === undefined ? {} : { entityType: input.entityType }),
      ...(input.query === undefined ? {} : { query: input.query }),
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
      readonly from?: string;
      readonly to?: string;
      readonly relation?: string;
      readonly entityType?: string;
      readonly query?: string;
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
      case "path":
        return this.#path(input);
      case "topology":
        return this.#entityGraph.getTopology();
      case "callImpact":
        return this.#callImpact(requiredRef(operation, input.ref), input.maxDepth);
      case "entities":
        return this.#entities(input);
      case "edges":
        return this.#edges(input);
      case "conformances":
        return this.#conformances(input.ref ?? input.entity, input.limit);
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
    return dedupeCallRelations([
      ...(entityId ? this.#entityGraph.getCallers(entityId, 1).map(entityCallRelation) : []),
      ...this.#codeGraph
        .getCallGraphEdges({ callee: ref })
        .map((edge) => callRelation(edge, "caller")),
    ]).slice(0, limit);
  }

  #callees(ref: string, limit: number): readonly unknown[] {
    const entityId = this.#resolveEntityId(ref);
    return dedupeCallRelations([
      ...(entityId ? this.#entityGraph.getCallees(entityId, 1).map(entityCallRelation) : []),
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

  #path(input: {
    readonly ref?: string;
    readonly entity?: string;
    readonly from?: string;
    readonly to?: string;
    readonly relation?: string;
    readonly maxDepth: number;
  }) {
    const fromRef = input.from ?? input.ref;
    const toRef = input.to ?? input.entity;
    if (!fromRef || !toRef) {
      throw new Error("path requires from/to or ref/entity.");
    }
    const fromId = this.#resolveEntityId(fromRef);
    const toId = this.#resolveEntityId(toRef);
    if (!fromId || !toId) {
      return { found: false, from: fromRef, to: toRef, path: null };
    }
    const path = this.#entityGraph.findPath(
      fromId,
      toId,
      input.relation as EngineeringEntityRelation | undefined,
      input.maxDepth,
    );
    return {
      found: path !== null,
      from: fromRef,
      to: toRef,
      resolvedFrom: fromId,
      resolvedTo: toId,
      path,
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

  #callImpact(ref: string, maxDepth: number) {
    const entityId = this.#resolveEntityId(ref);
    if (!entityId) {
      return {
        root: ref,
        depth: maxDepth,
        direction: "incoming",
        nodes: [],
        edges: [],
        distanceById: {},
        relationCounts: {},
        affectedFiles: [],
        directCallers: 0,
        transitiveCallers: 0,
      };
    }
    return this.#entityGraph.getCallImpactRadius(entityId, maxDepth);
  }

  #entities(input: {
    readonly ref?: string;
    readonly entity?: string;
    readonly entityType?: string;
    readonly query?: string;
    readonly limit: number;
  }): readonly EngineeringEntity[] {
    const selector = input.entityType ?? input.query ?? input.entity ?? input.ref;
    if (!selector) {
      return this.#entityGraph.entities.slice(0, input.limit);
    }
    if (isEntityType(selector)) {
      return this.#entityGraph.listByType(selector).slice(0, input.limit);
    }
    const entityId = this.#resolveEntityId(selector);
    const entity = entityId ? this.#entityGraph.findEntity(entityId) : null;
    if (entity) {
      return [entity];
    }
    return this.#entityGraph.searchByName(selector, input.limit);
  }

  #edges(input: {
    readonly ref?: string;
    readonly entity?: string;
    readonly from?: string;
    readonly to?: string;
    readonly relation?: string;
    readonly direction: EngineeringGraphTraversalDirection;
    readonly limit: number;
  }) {
    const relation = input.relation as EngineeringEntityRelation | undefined;
    const fromId = input.from ? this.#resolveEntityId(input.from) : null;
    const toId = input.to ? this.#resolveEntityId(input.to) : null;
    const refId = !fromId && !toId ? this.#resolveEntityId(input.ref ?? input.entity ?? "") : null;

    let edges = this.#entityGraph.edges;
    if (relation) {
      edges = edges.filter((edge) => edge.relation === relation);
    }
    if (fromId) {
      edges = edges.filter((edge) => edge.from === fromId);
    }
    if (toId) {
      edges = edges.filter((edge) => edge.to === toId);
    }
    if (refId) {
      edges = edges.filter((edge) => {
        if (input.direction === "incoming") {
          return edge.to === refId;
        }
        if (input.direction === "outgoing") {
          return edge.from === refId;
        }
        return edge.from === refId || edge.to === refId;
      });
    }
    return edges.slice(0, input.limit);
  }

  #conformances(ref: string | undefined, limit: number): readonly unknown[] {
    if (!ref) {
      return this.#entityGraph.edges.filter((edge) => edge.relation === "conforms").slice(0, limit);
    }

    const entityId = this.#resolveEntityId(ref);
    const entity = entityId ? this.#entityGraph.findEntity(entityId) : null;
    const graphConformances = entity
      ? entity.type === "protocol"
        ? this.#entityGraph
            .findIncoming(entity.id, "conforms")
            .map((edge) => conformanceResult(edge.from, edge.to, edge, this.#entityGraph))
        : this.#entityGraph
            .findOutgoing(entity.id, "conforms")
            .map((edge) => conformanceResult(edge.from, edge.to, edge, this.#entityGraph))
      : [];

    const className = cleanEntityName(ref);
    const codeConformances =
      this.#codeGraph.getClassInfo(className)?.protocols.map((protocolName) => ({
        class: className,
        protocol: protocolName,
        source: "code-graph",
      })) ?? [];

    return dedupeConformanceResults([...graphConformances, ...codeConformances]).slice(0, limit);
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

function entityCallRelation(reference: {
  readonly entity: EngineeringEntity;
  readonly edge: unknown;
  readonly depth: number;
  readonly callType: string;
}) {
  const fqn = reference.entity.metadata.fqn;
  return {
    symbol: typeof fqn === "string" && fqn.length > 0 ? fqn : reference.entity.name,
    entity: reference.entity,
    edge: reference.edge,
    depth: reference.depth,
    callType: reference.callType,
  };
}

function dedupeCallRelations(values: readonly unknown[]): readonly unknown[] {
  return [
    ...new Map(
      values.map((value) => {
        const record = isRecord(value) ? value : {};
        const symbol = record.symbol;
        return [
          typeof symbol === "string" && symbol.length > 0 ? symbol : JSON.stringify(value),
          value,
        ];
      }),
    ).values(),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  if (entityTypes.some((type) => clean.startsWith(`${type}:`))) {
    return [clean];
  }
  const codeRef = extractCodeEntityRef(clean);
  return [
    `class:${clean}`,
    `protocol:${clean}`,
    `category:${clean}`,
    `method:${clean}`,
    ...(codeRef === clean ? [] : [`method:${codeRef}`]),
    `property:${clean}`,
    `symbol:${clean}`,
    `file:${clean}`,
    `module:file:${clean}`,
    `module:${clean}`,
    `target:${clean}`,
    `external:${clean}`,
    `pattern:${clean}`,
    `recipe:${clean}`,
  ];
}

function extractCodeEntityRef(ref: string): string {
  const separator = ref.lastIndexOf("::");
  if (separator >= 0 && separator < ref.length - 2) {
    return ref.slice(separator + 2).trim();
  }
  return ref;
}

function isEntityType(value: string): value is EngineeringEntityType {
  return entityTypes.includes(value as EngineeringEntityType);
}

function conformanceResult(
  classId: string,
  protocolId: string,
  edge: unknown,
  graph: EngineeringEntityGraph,
) {
  return {
    class: graph.findEntity(classId)?.name ?? cleanEntityName(classId),
    protocol: graph.findEntity(protocolId)?.name ?? cleanEntityName(protocolId),
    edge,
    source: "entity-graph",
  };
}

function dedupeConformanceResults(values: readonly unknown[]): readonly unknown[] {
  const keyed = new Map<string, unknown>();
  for (const value of values) {
    if (!isRecord(value)) {
      keyed.set(JSON.stringify(value), value);
      continue;
    }
    const className = typeof value.class === "string" ? value.class : "";
    const protocolName = typeof value.protocol === "string" ? value.protocol : "";
    const key =
      className && protocolName ? `${className}\u0000${protocolName}` : JSON.stringify(value);
    if (!keyed.has(key) || value.source === "entity-graph") {
      keyed.set(key, value);
    }
  }
  return [...keyed.values()];
}

function cleanEntityName(ref: string): string {
  const codeRef = extractCodeEntityRef(ref);
  const separator = codeRef.indexOf(":");
  return separator >= 0 ? codeRef.slice(separator + 1) : codeRef;
}

const entityTypes: readonly EngineeringEntityType[] = [
  "file",
  "target",
  "module",
  "external",
  "class",
  "protocol",
  "category",
  "method",
  "property",
  "symbol",
  "pattern",
  "recipe",
];

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

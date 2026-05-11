import { EngineeringCodeGraph } from "../code/graph.js";
import type { EngineeringCodeClassInfo } from "../code/types.js";
import type {
  EngineeringEntity,
  EngineeringEntityGraph,
  EngineeringEntityRelation,
} from "../entity/graph.js";
import type { EngineeringWorkflowArtifact } from "../workflow/types.js";
import { dependencyAdjacency, dependencyCycles } from "./dependency-query.js";
import {
  bounded,
  callRelation,
  cleanEntityName,
  conformanceResult,
  countBy,
  dedupeCallRelations,
  dedupeConformanceResults,
  entityCallRelation,
  entityGraphFromSnapshot,
  entityIdCandidates,
  isEntityType,
  panoramaHealthScore,
  requiredEntity,
  requiredRef,
  splitMethodRef,
} from "./query-helpers.js";

export type {
  EngineeringGraphOverviewResult,
  EngineeringGraphQueryInput,
  EngineeringGraphQueryOperation,
  EngineeringGraphQueryProvider,
  EngineeringGraphQueryResult,
  EngineeringGraphTraversalDirection,
} from "./query-types.js";

import type {
  EngineeringGraphOverviewResult,
  EngineeringGraphQueryInput,
  EngineeringGraphQueryOperation,
  EngineeringGraphQueryProvider,
  EngineeringGraphQueryResult,
  EngineeringGraphTraversalDirection,
} from "./query-types.js";

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

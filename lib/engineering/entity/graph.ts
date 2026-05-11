import {
  EmptyEngineeringCodeGraph,
  type EngineeringCodeCallGraphEdge,
  type EngineeringCodeDataFlowEdge,
  type EngineeringCodeGraphReader,
} from "../code/types.js";
import type {
  EngineeringDependencyGraph,
  EngineeringDependencyNode,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/types.js";
import {
  isExternalEngineeringDependencyNode,
  normalizeEngineeringDependencyNode,
} from "../foundation/types.js";

export type EngineeringEntityType =
  | "file"
  | "target"
  | "module"
  | "external"
  | "class"
  | "protocol"
  | "category"
  | "method"
  | "property"
  | "symbol"
  | "pattern"
  | "recipe";

export type EngineeringEntityRelation =
  | "contains"
  | "defines"
  | "depends_on"
  | "imports"
  | "inherits"
  | "conforms"
  | "extends"
  | "calls"
  | "data_flow"
  | "references"
  | "matches"
  | "uses_pattern"
  | "is_part_of"
  | string;

export interface EngineeringEntity {
  readonly id: string;
  readonly type: EngineeringEntityType;
  readonly name: string;
  readonly filePath: string | null;
  readonly line: number | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface EngineeringEntityEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: EngineeringEntityRelation;
  readonly weight: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface EngineeringEntityGraphInput {
  readonly targets: readonly EngineeringTarget[];
  readonly files: readonly EngineeringFile[];
  readonly dependencyGraph: EngineeringDependencyGraph;
  readonly codeGraph?: EngineeringCodeGraphReader;
  readonly callGraph?: readonly EngineeringCodeCallGraphEdge[];
  readonly dataFlow?: readonly EngineeringCodeDataFlowEdge[];
  readonly patternStats?: EngineeringPatternStats;
  readonly candidateRelations?: readonly EngineeringCandidateWithRelations[];
}

export interface EngineeringPatternInstance {
  readonly className?: string;
  readonly name?: string;
  readonly file?: string;
  readonly filePath?: string;
}

export interface EngineeringPatternStat {
  readonly count: number;
  readonly files?: readonly string[];
  readonly instances?: readonly EngineeringPatternInstance[];
}

export type EngineeringPatternStats = Readonly<Record<string, EngineeringPatternStat>>;

export interface EngineeringCandidateRelation {
  readonly type: string;
  readonly target: string;
  readonly description?: string;
}

export interface EngineeringCandidateWithRelations {
  readonly title?: string;
  readonly id?: string;
  readonly relations?: unknown;
}

export interface EngineeringEntityPath {
  readonly nodes: readonly string[];
  readonly edges: readonly EngineeringEntityEdge[];
  readonly distance: number;
}

export interface EngineeringImpactRadius {
  readonly root: string;
  readonly depth: number;
  readonly direction: "outgoing" | "incoming" | "both";
  readonly nodes: readonly EngineeringEntity[];
  readonly edges: readonly EngineeringEntityEdge[];
  readonly distanceById: Readonly<Record<string, number>>;
}

export interface EngineeringEntityTopology {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly roots: readonly string[];
  readonly leaves: readonly string[];
  readonly isolated: readonly string[];
  readonly components: readonly (readonly string[])[];
  readonly cycles: readonly (readonly string[])[];
}

export interface EngineeringHotNode {
  readonly id: string;
  readonly degree: number;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly weightedDegree: number;
}

export interface EngineeringCallReference {
  readonly entity: EngineeringEntity;
  readonly edge: EngineeringEntityEdge;
  readonly depth: number;
  readonly callType: string;
}

export interface EngineeringCallImpactRadius extends EngineeringImpactRadius {
  readonly relationCounts: Readonly<Record<string, number>>;
  readonly affectedFiles: readonly string[];
  readonly directCallers: number;
  readonly transitiveCallers: number;
}

export interface EngineeringFileCleanupResult {
  readonly deletedEntities: number;
  readonly deletedEdges: number;
  readonly entityIds: readonly string[];
}

export interface EngineeringEdgeCleanupResult {
  readonly deletedEdges: number;
}

export interface EngineeringAgentContextOptions {
  readonly maxHotNodes?: number;
  readonly maxPaths?: number;
  readonly maxDependencies?: number;
  readonly maxRiskModules?: number;
}

export interface EngineeringAgentContext {
  readonly stats: {
    readonly entityCount: number;
    readonly edgeCount: number;
    readonly entitiesByType: Readonly<Record<EngineeringEntityType, number>>;
    readonly edgesByRelation: Readonly<Record<string, number>>;
  };
  readonly hotNodes: readonly EngineeringHotNode[];
  readonly criticalPaths: readonly EngineeringEntityPath[];
  readonly externalDependencies: readonly {
    readonly entity: EngineeringEntity;
    readonly incoming: readonly EngineeringEntityEdge[];
  }[];
  readonly callAndDataFlowSummary: {
    readonly calls: number;
    readonly dataFlows: number;
    readonly hotCallees: readonly {
      readonly entity: EngineeringEntity;
      readonly callerCount: number;
      readonly callers: readonly EngineeringEntity[];
    }[];
    readonly dataFlowSources: readonly {
      readonly entity: EngineeringEntity;
      readonly outgoingCount: number;
    }[];
  };
  readonly riskModules: readonly {
    readonly entity: EngineeringEntity;
    readonly score: number;
    readonly reasons: readonly string[];
  }[];
}

export class EngineeringEntityGraph {
  readonly #entities = new Map<string, EngineeringEntity>();
  readonly #edges = new Map<string, EngineeringEntityEdge>();

  static fromInput(input: EngineeringEntityGraphInput): EngineeringEntityGraph {
    const graph = new EngineeringEntityGraph();
    graph.addTargets(input.targets);
    graph.addFiles(input.files);
    graph.addDependencyGraph(input.dependencyGraph);
    graph.addCodeGraph(input.files, input.codeGraph ?? new EmptyEngineeringCodeGraph());
    graph.addCallGraph(input.callGraph ?? [], input.dataFlow ?? []);
    if (input.patternStats) {
      graph.addPatternStats(input.patternStats);
    }
    if (input.candidateRelations) {
      graph.addCandidateRelations(input.candidateRelations);
    }
    return graph;
  }

  addEntity(entity: EngineeringEntity): this {
    this.#entities.set(entity.id, {
      ...entity,
      metadata: { ...entity.metadata },
    });
    return this;
  }

  addEdge(edge: EngineeringEntityEdge): this {
    if (!edge.from || !edge.to || edge.from === edge.to) {
      return this;
    }
    const key = edgeKey(edge.from, edge.to, edge.relation);
    if (!this.#edges.has(key)) {
      this.#edges.set(key, {
        ...edge,
        weight: edge.weight || 1,
        metadata: { ...edge.metadata },
      });
    }
    return this;
  }

  addTargets(targets: readonly EngineeringTarget[]): this {
    for (const target of targets) {
      this.addEntity({
        id: targetId(target.name),
        type: "target",
        name: target.name,
        filePath: target.path,
        line: null,
        metadata: {
          targetType: target.type,
          language: target.language ?? null,
          framework: target.framework ?? null,
          ...(target.metadata ?? {}),
        },
      });
    }
    return this;
  }

  addFiles(files: readonly EngineeringFile[]): this {
    for (const file of files) {
      this.addEntity({
        id: fileId(file.relativePath),
        type: "file",
        name: file.name,
        filePath: file.relativePath,
        line: null,
        metadata: {
          absolutePath: file.path,
          language: file.language,
          targetName: file.targetName ?? null,
          isTest: file.isTest ?? false,
        },
      });
      if (file.targetName) {
        this.addSimpleEdge(targetId(file.targetName), fileId(file.relativePath), "contains", {
          source: "engineering-files",
        });
      }
    }
    return this;
  }

  addDependencyGraph(dependencyGraph: EngineeringDependencyGraph): this {
    for (const rawNode of dependencyGraph.nodes) {
      const node = normalizeEngineeringDependencyNode(rawNode);
      const type = dependencyEntityType(node);
      this.addEntity({
        id: moduleId(node.id),
        type,
        name: node.label ?? node.id,
        filePath: node.fullPath ?? null,
        line: null,
        metadata: { ...node },
      });
    }

    for (const edge of dependencyGraph.edges) {
      this.ensureDependencyNode(edge.from);
      this.ensureDependencyNode(edge.to);
      this.addSimpleEdge(
        moduleId(edge.from),
        moduleId(edge.to),
        edge.type || "depends_on",
        {
          source: "dependency-graph",
          scope: edge.scope ?? null,
          configuration: edge.configuration ?? null,
          bridgeType: edge.bridgeType ?? null,
        },
        edge.weight ?? 1,
      );
    }
    return this;
  }

  addCodeGraph(files: readonly EngineeringFile[], codeGraph: EngineeringCodeGraphReader): this {
    for (const file of files) {
      const symbols = codeGraph.getFileSymbols(file.relativePath);
      if (!symbols) {
        continue;
      }
      for (const className of symbols.classes) {
        this.addClass(className, file.relativePath, codeGraph);
      }
      for (const protocolName of symbols.protocols) {
        this.addProtocol(protocolName, file.relativePath, { source: "code-graph" });
      }
      for (const categoryName of symbols.categories) {
        this.addCategory(categoryName, file.relativePath);
      }
    }
    return this;
  }

  addCallGraph(
    callEdges: readonly EngineeringCodeCallGraphEdge[],
    dataFlowEdges: readonly EngineeringCodeDataFlowEdge[] = [],
  ): this {
    const aggregatedCalls = new Map<
      string,
      {
        callerId: string;
        calleeId: string;
        callType: string;
        resolveMethod: string;
        filePath: string | null;
        sourceFilePath: string | null;
        targetFilePath: string | null;
        hasAwait: boolean;
        argCount: number;
        callCount: number;
        callSites: { readonly line: number | null; readonly isAwait: boolean }[];
      }
    >();

    for (const edge of callEdges) {
      const callerId = codeReferenceEntityId(edge.caller, "method");
      const calleeId = codeReferenceEntityId(edge.callee, "method");
      if (!callerId || !calleeId || callerId === calleeId) {
        continue;
      }

      this.ensureReferenceEntity(callerId, edge.caller, "method", {
        filePath: edge.sourceFilePath ?? filePathFromCodeReference(edge.caller) ?? edge.filePath,
        line: edge.line,
        metadata: { fqn: edge.caller, source: "phase5-call-graph" },
      });
      this.ensureReferenceEntity(calleeId, edge.callee, "method", {
        filePath: edge.targetFilePath ?? filePathFromCodeReference(edge.callee),
        line: null,
        metadata: { fqn: edge.callee, source: "phase5-call-graph" },
      });

      const key = `${callerId}\u0000${calleeId}`;
      const current = aggregatedCalls.get(key);
      if (current) {
        current.callCount += 1;
        current.callSites.push({ line: edge.line, isAwait: edge.isAwait });
        current.hasAwait = current.hasAwait || edge.isAwait;
        current.argCount = Math.max(current.argCount, edge.argCount);
        if (edge.resolveMethod === "direct") {
          current.resolveMethod = "direct";
        }
        continue;
      }

      aggregatedCalls.set(key, {
        callerId,
        calleeId,
        callType: edge.callType,
        resolveMethod: edge.resolveMethod,
        filePath: edge.filePath,
        sourceFilePath: edge.sourceFilePath,
        targetFilePath: edge.targetFilePath,
        hasAwait: edge.isAwait,
        argCount: edge.argCount,
        callCount: 1,
        callSites: [{ line: edge.line, isAwait: edge.isAwait }],
      });
    }

    for (const call of aggregatedCalls.values()) {
      this.addSimpleEdge(
        call.callerId,
        call.calleeId,
        "calls",
        {
          source: "phase5-call-graph",
          callType: call.callType,
          resolveMethod: call.resolveMethod,
          file: call.filePath,
          filePath: call.filePath,
          sourceFilePath: call.sourceFilePath,
          targetFilePath: call.targetFilePath,
          isAwait: call.hasAwait,
          argCount: call.argCount,
          callCount: call.callCount,
          callSites: call.callSites.slice(0, 10),
        },
        call.resolveMethod === "direct" ? 1 : 0.6,
      );
    }

    for (const edge of dataFlowEdges) {
      const fromId = codeReferenceEntityId(edge.from, "method");
      const toId = codeReferenceEntityId(edge.to, "method");
      if (!fromId || !toId || fromId === toId) {
        continue;
      }

      this.ensureReferenceEntity(fromId, edge.from, "method", {
        filePath: edge.filePath ?? filePathFromCodeReference(edge.from),
        line: edge.line,
        metadata: { fqn: edge.from, source: "phase5-data-flow" },
      });
      this.ensureReferenceEntity(toId, edge.to, "method", {
        filePath: edge.filePath ?? filePathFromCodeReference(edge.to),
        line: edge.line,
        metadata: { fqn: edge.to, source: "phase5-data-flow" },
      });
      this.addSimpleEdge(
        fromId,
        toId,
        "data_flow",
        {
          source: "phase5-data-flow",
          flowType: edge.flowType,
          direction: edge.direction,
          confidence: edge.confidence,
          file: edge.filePath,
          filePath: edge.filePath,
          line: edge.line,
          sourceSymbol: edge.source,
          sinkSymbol: edge.sink,
        },
        0.5,
      );
    }

    return this;
  }

  addPatternStats(patternStats: EngineeringPatternStats): this {
    for (const [patternType, stat] of Object.entries(patternStats).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const patternEntityId = patternId(patternType);
      this.addEntity({
        id: patternEntityId,
        type: "pattern",
        name: patternType,
        filePath: null,
        line: null,
        metadata: {
          source: "ast-pattern-detection",
          count: stat.count,
          files: stat.files?.slice(0, 10) ?? [],
        },
      });

      for (const instance of (stat.instances ?? []).slice(0, 50)) {
        const className = firstString(instance.className, instance.name);
        if (!className) {
          continue;
        }
        const sourceId = hasEntityPrefix(className) ? className : classId(className);
        this.ensureReferenceEntity(sourceId, className, "class", {
          filePath: instance.filePath ?? instance.file ?? null,
          line: null,
          metadata: { source: "ast-pattern-detection" },
        });
        this.addSimpleEdge(
          sourceId,
          patternEntityId,
          "uses_pattern",
          {
            source: "ast-pattern-detection",
            file: instance.filePath ?? instance.file ?? null,
          },
          0.8,
        );
      }
    }
    return this;
  }

  addCandidateRelations(candidates: readonly EngineeringCandidateWithRelations[]): this {
    for (const candidate of candidates) {
      const title = firstString(candidate.title, candidate.id);
      if (!title) {
        continue;
      }
      const fromId = recipeId(title);
      this.ensureRecipeEntity(fromId, title);

      for (const relation of flattenCandidateRelations(candidate.relations)) {
        const toId = recipeId(relation.target);
        this.ensureRecipeEntity(toId, relation.target);
        this.addSimpleEdge(
          fromId,
          toId,
          mapCandidateRelationType(relation.type),
          {
            source: "candidate-relations",
            description: relation.description ?? "",
          },
          0.7,
        );
      }
    }
    return this;
  }

  findEntity(id: string): EngineeringEntity | null {
    return this.#entities.get(id) ?? null;
  }

  listByType(type: EngineeringEntityType): readonly EngineeringEntity[] {
    return this.entities.filter((entity) => entity.type === type);
  }

  searchByName(query: string, limit = 20): readonly EngineeringEntity[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return [];
    }
    return this.entities
      .filter((entity) => entity.name.toLowerCase().includes(normalized))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  findOutgoing(id: string, relation?: EngineeringEntityRelation): readonly EngineeringEntityEdge[] {
    return this.edges.filter((edge) => edge.from === id && matchesRelation(edge, relation));
  }

  findIncoming(id: string, relation?: EngineeringEntityRelation): readonly EngineeringEntityEdge[] {
    return this.edges.filter((edge) => edge.to === id && matchesRelation(edge, relation));
  }

  getCallers(id: string, maxDepth = 1): readonly EngineeringCallReference[] {
    return this.walkCalls(id, "incoming", maxDepth);
  }

  getCallees(id: string, maxDepth = 1): readonly EngineeringCallReference[] {
    return this.walkCalls(id, "outgoing", maxDepth);
  }

  findPath(
    from: string,
    to: string,
    relation?: EngineeringEntityRelation,
    maxDepth = Number.POSITIVE_INFINITY,
  ): EngineeringEntityPath | null {
    if (!this.#entities.has(from) || !this.#entities.has(to)) {
      return null;
    }
    if (from === to) {
      return { nodes: [from], edges: [], distance: 0 };
    }

    const boundedDepth = Math.max(0, Math.floor(maxDepth));
    const queue: { readonly id: string; readonly distance: number }[] = [{ id: from, distance: 0 }];
    const visited = new Set([from]);
    const previous = new Map<string, EngineeringEntityEdge>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      if (current.distance >= boundedDepth) {
        continue;
      }
      for (const edge of this.findOutgoing(current.id, relation)) {
        if (visited.has(edge.to)) {
          continue;
        }
        visited.add(edge.to);
        previous.set(edge.to, edge);
        if (edge.to === to) {
          return buildPath(from, to, previous);
        }
        queue.push({ id: edge.to, distance: current.distance + 1 });
      }
    }

    return null;
  }

  getImpactRadius(
    root: string,
    depth = 1,
    direction: "outgoing" | "incoming" | "both" = "outgoing",
  ): EngineeringImpactRadius {
    const maxDepth = Math.max(0, Math.floor(depth));
    const queue: { readonly id: string; readonly distance: number }[] = [{ id: root, distance: 0 }];
    const distanceById = new Map<string, number>([[root, 0]]);
    const edgeKeys = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.distance >= maxDepth) {
        continue;
      }
      for (const edge of this.neighborEdges(current.id, direction)) {
        const nextId = edge.from === current.id ? edge.to : edge.from;
        edgeKeys.add(edgeKey(edge.from, edge.to, edge.relation));
        if (!distanceById.has(nextId)) {
          distanceById.set(nextId, current.distance + 1);
          queue.push({ id: nextId, distance: current.distance + 1 });
        }
      }
    }

    const nodes = [...distanceById.keys()]
      .map((id) => this.findEntity(id))
      .filter((entity): entity is EngineeringEntity => entity !== null)
      .sort(compareEntities);
    const edges = [...edgeKeys]
      .map((key) => this.#edges.get(key))
      .filter((edge): edge is EngineeringEntityEdge => edge !== undefined)
      .sort(compareEdges);

    return {
      root,
      depth: maxDepth,
      direction,
      nodes,
      edges,
      distanceById: Object.fromEntries(
        [...distanceById.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
  }

  getCallImpactRadius(root: string, depth = 3): EngineeringCallImpactRadius {
    const maxDepth = Math.max(0, Math.floor(depth));
    const queue: { readonly id: string; readonly distance: number }[] = [{ id: root, distance: 0 }];
    const distanceById = new Map<string, number>([[root, 0]]);
    const edgeKeys = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.distance >= maxDepth) {
        continue;
      }

      for (const edge of this.callImpactEdges(current.id)) {
        const nextId = edge.relation === "calls" ? edge.from : edge.to;
        edgeKeys.add(edgeKey(edge.from, edge.to, edge.relation));
        if (!distanceById.has(nextId)) {
          distanceById.set(nextId, current.distance + 1);
          queue.push({ id: nextId, distance: current.distance + 1 });
        }
      }
    }

    const nodes = [...distanceById.keys()]
      .map((id) => this.findEntity(id))
      .filter((entity): entity is EngineeringEntity => entity !== null)
      .sort(compareEntities);
    const edges = [...edgeKeys]
      .map((key) => this.#edges.get(key))
      .filter((edge): edge is EngineeringEntityEdge => edge !== undefined)
      .sort(compareEdges);
    const relationCounts = countEdgesByRelation(edges);
    const affectedFiles = [
      ...new Set(nodes.map((node) => node.filePath).filter(isNonEmptyString)),
    ].sort();
    const callerDistances = new Map<string, number>();
    for (const edge of edges) {
      if (edge.relation !== "calls") {
        continue;
      }
      const distance = distanceById.get(edge.from);
      if (distance !== undefined && edge.from !== root) {
        callerDistances.set(edge.from, distance);
      }
    }

    return {
      root,
      depth: maxDepth,
      direction: "incoming",
      nodes,
      edges,
      distanceById: Object.fromEntries(
        [...distanceById.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      relationCounts,
      affectedFiles,
      directCallers: [...callerDistances.values()].filter((distance) => distance === 1).length,
      transitiveCallers: callerDistances.size,
    };
  }

  generateContextForAgent(options: EngineeringAgentContextOptions = {}): EngineeringAgentContext {
    const maxHotNodes = options.maxHotNodes ?? 10;
    const maxPaths = options.maxPaths ?? 8;
    const maxDependencies = options.maxDependencies ?? 10;
    const maxRiskModules = options.maxRiskModules ?? 8;
    const hotNodes = this.getHotNodes(maxHotNodes);
    const edgesByRelation = countEdgesByRelation(this.edges);
    const externalDependencies = this.listByType("external")
      .map((entity) => ({
        entity,
        incoming: this.findIncoming(entity.id).filter((edge) =>
          ["depends_on", "imports", "references"].includes(edge.relation),
        ),
      }))
      .filter((dependency) => dependency.incoming.length > 0)
      .sort(
        (left, right) =>
          right.incoming.length - left.incoming.length ||
          left.entity.id.localeCompare(right.entity.id),
      )
      .slice(0, maxDependencies);

    return {
      stats: {
        entityCount: this.#entities.size,
        edgeCount: this.#edges.size,
        entitiesByType: this.countByType(),
        edgesByRelation,
      },
      hotNodes,
      criticalPaths: this.criticalPaths(hotNodes, maxPaths),
      externalDependencies,
      callAndDataFlowSummary: this.callAndDataFlowSummary(maxHotNodes),
      riskModules: this.riskModules(maxRiskModules),
    };
  }

  renderAgentContextMarkdown(context = this.generateContextForAgent()): string {
    if (context.stats.entityCount === 0) {
      return "";
    }

    const lines = [
      "## Engineering Entity Graph",
      "",
      "### Stats",
      ...Object.entries(context.stats.entitiesByType)
        .filter(([, count]) => count > 0)
        .map(([type, count]) => `- ${type}: ${count}`),
      `- edges: ${context.stats.edgeCount}`,
      "",
    ];

    if (context.hotNodes.length > 0) {
      lines.push("### Hot Nodes");
      for (const node of context.hotNodes) {
        lines.push(
          `- \`${node.id}\` degree=${node.degree}, fanIn=${node.fanIn}, fanOut=${node.fanOut}`,
        );
      }
      lines.push("");
    }

    if (context.criticalPaths.length > 0) {
      lines.push("### Critical Paths");
      for (const path of context.criticalPaths) {
        lines.push(`- \`${path.nodes.join(" -> ")}\` (${path.distance})`);
      }
      lines.push("");
    }

    if (context.externalDependencies.length > 0) {
      lines.push("### External Dependencies");
      for (const dependency of context.externalDependencies) {
        const importers = dependency.incoming.map((edge) => `\`${edge.from}\``).slice(0, 5);
        lines.push(`- \`${dependency.entity.id}\` <- ${importers.join(", ")}`);
      }
      lines.push("");
    }

    const summary = context.callAndDataFlowSummary;
    if (summary.calls > 0 || summary.dataFlows > 0) {
      lines.push("### Calls And Data Flow");
      lines.push(`- calls: ${summary.calls}`);
      lines.push(`- data_flow: ${summary.dataFlows}`);
      for (const item of summary.hotCallees) {
        const callers = item.callers.map((entity) => `\`${entity.id}\``).join(", ");
        lines.push(
          `- hot callee \`${item.entity.id}\` <- ${item.callerCount} callers (${callers})`,
        );
      }
      for (const item of summary.dataFlowSources) {
        lines.push(`- data source \`${item.entity.id}\` -> ${item.outgoingCount} flows`);
      }
      lines.push("");
    }

    if (context.riskModules.length > 0) {
      lines.push("### Risk Modules");
      for (const risk of context.riskModules) {
        lines.push(`- \`${risk.entity.id}\` score=${risk.score}: ${risk.reasons.join(", ")}`);
      }
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }

  getTopology(): EngineeringEntityTopology {
    const ids = this.entities.map((entity) => entity.id);
    const fanIn = new Map(ids.map((id) => [id, 0]));
    const fanOut = new Map(ids.map((id) => [id, 0]));
    const undirected = new Map(ids.map((id) => [id, new Set<string>()]));

    for (const edge of this.edges) {
      fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1);
      fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
      if (!undirected.has(edge.from)) {
        undirected.set(edge.from, new Set());
      }
      if (!undirected.has(edge.to)) {
        undirected.set(edge.to, new Set());
      }
      undirected.get(edge.from)?.add(edge.to);
      undirected.get(edge.to)?.add(edge.from);
    }

    return {
      nodeCount: this.#entities.size,
      edgeCount: this.#edges.size,
      roots: ids.filter((id) => (fanIn.get(id) ?? 0) === 0 && (fanOut.get(id) ?? 0) > 0).sort(),
      leaves: ids.filter((id) => (fanOut.get(id) ?? 0) === 0 && (fanIn.get(id) ?? 0) > 0).sort(),
      isolated: ids
        .filter((id) => (fanIn.get(id) ?? 0) === 0 && (fanOut.get(id) ?? 0) === 0)
        .sort(),
      components: connectedComponents(ids, undirected),
      cycles: directedCycles(ids, this.edges),
    };
  }

  countByType(): Readonly<Record<EngineeringEntityType, number>> {
    const counts = Object.fromEntries(entityTypes.map((type) => [type, 0])) as Record<
      EngineeringEntityType,
      number
    >;
    for (const entity of this.#entities.values()) {
      counts[entity.type] += 1;
    }
    return counts;
  }

  getHotNodes(limit = 10): readonly EngineeringHotNode[] {
    const metrics = new Map<string, EngineeringHotNode>();
    for (const entity of this.#entities.values()) {
      metrics.set(entity.id, {
        id: entity.id,
        degree: 0,
        fanIn: 0,
        fanOut: 0,
        weightedDegree: 0,
      });
    }
    for (const edge of this.#edges.values()) {
      const from = metrics.get(edge.from) ?? zeroHotNode(edge.from);
      metrics.set(edge.from, {
        ...from,
        degree: from.degree + 1,
        fanOut: from.fanOut + 1,
        weightedDegree: roundWeight(from.weightedDegree + edge.weight),
      });
      const to = metrics.get(edge.to) ?? zeroHotNode(edge.to);
      metrics.set(edge.to, {
        ...to,
        degree: to.degree + 1,
        fanIn: to.fanIn + 1,
        weightedDegree: roundWeight(to.weightedDegree + edge.weight),
      });
    }
    return [...metrics.values()]
      .filter((node) => node.degree > 0)
      .sort(
        (left, right) =>
          right.degree - left.degree ||
          right.weightedDegree - left.weightedDegree ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit);
  }

  removeEntity(id: string): EngineeringFileCleanupResult {
    if (!this.#entities.has(id)) {
      return { deletedEntities: 0, deletedEdges: 0, entityIds: [] };
    }
    const deletedEdges = this.removeEdges((edge) => edge.from === id || edge.to === id);
    this.#entities.delete(id);
    return { deletedEntities: 1, deletedEdges, entityIds: [id] };
  }

  removeEntities(ids: readonly string[]): EngineeringFileCleanupResult {
    const entityIds = [...new Set(ids)].filter((id) => this.#entities.has(id)).sort();
    if (entityIds.length === 0) {
      return { deletedEntities: 0, deletedEdges: 0, entityIds: [] };
    }
    const idSet = new Set(entityIds);
    const deletedEdges = this.removeEdges((edge) => idSet.has(edge.from) || idSet.has(edge.to));
    for (const id of entityIds) {
      this.#entities.delete(id);
    }
    return { deletedEntities: entityIds.length, deletedEdges, entityIds };
  }

  removeEntitiesForFiles(filePaths: readonly string[]): EngineeringFileCleanupResult {
    const paths = normalizedPathSet(filePaths);
    if (paths.size === 0) {
      return { deletedEntities: 0, deletedEdges: 0, entityIds: [] };
    }
    const entityIds = this.entities
      .filter((entity) => entityBelongsToFiles(entity, paths))
      .map((entity) => entity.id);
    return this.removeEntities(entityIds);
  }

  removeEdgesForFiles(filePaths: readonly string[]): EngineeringEdgeCleanupResult {
    const paths = normalizedPathSet(filePaths);
    if (paths.size === 0) {
      return { deletedEdges: 0 };
    }
    return {
      deletedEdges: this.removeEdges((edge) => edgeBelongsToFiles(edge, this.#entities, paths)),
    };
  }

  get entities(): readonly EngineeringEntity[] {
    return [...this.#entities.values()].sort(compareEntities);
  }

  get edges(): readonly EngineeringEntityEdge[] {
    return [...this.#edges.values()].sort(compareEdges);
  }

  private addClass(
    className: string,
    relativePath: string,
    codeGraph: EngineeringCodeGraphReader,
  ): void {
    const info = codeGraph.getClassInfo(className);
    const filePath = info?.filePath ?? relativePath;
    this.addEntity({
      id: classId(className),
      type: "class",
      name: className,
      filePath,
      line: null,
      metadata: {
        source: "code-graph",
        superClass: info?.superClass ?? null,
        protocols: info?.protocols ?? [],
      },
    });
    this.addSimpleEdge(fileId(filePath), classId(className), "defines", { source: "code-graph" });
    if (info?.superClass) {
      this.addEntity({
        id: classId(info.superClass),
        type: "class",
        name: info.superClass,
        filePath: null,
        line: null,
        metadata: { source: "code-graph-reference" },
      });
      this.addSimpleEdge(classId(className), classId(info.superClass), "inherits", {
        source: "code-graph",
      });
    }
    for (const protocolName of info?.protocols ?? []) {
      this.addProtocol(protocolName, null, { source: "code-graph-reference" });
      this.addSimpleEdge(classId(className), protocolId(protocolName), "conforms", {
        source: "code-graph",
      });
    }
    for (const method of info?.methods ?? []) {
      const id = methodId(className, method.selector || method.name);
      this.addEntity({
        id,
        type: "method",
        name: method.name || method.selector,
        filePath: method.filePath || filePath,
        line: method.line,
        metadata: {
          source: "code-graph",
          owner: className,
          selector: method.selector,
          isClassMethod: method.isClassMethod,
          returnType: method.returnType,
          paramCount: method.paramCount,
          bodyLines: method.bodyLines,
          complexity: method.complexity,
        },
      });
      this.addSimpleEdge(classId(className), id, "defines", { source: "code-graph" });
    }
    for (const property of info?.properties ?? []) {
      const id = propertyId(className, property.name);
      this.addEntity({
        id,
        type: "property",
        name: property.name,
        filePath,
        line: property.line,
        metadata: {
          source: "code-graph",
          owner: className,
          propertyType: property.type,
          attributes: property.attributes,
        },
      });
      this.addSimpleEdge(classId(className), id, "defines", { source: "code-graph" });
    }
  }

  private addProtocol(
    name: string,
    relativePath: string | null,
    metadata: Readonly<Record<string, unknown>>,
  ): void {
    this.addEntity({
      id: protocolId(name),
      type: "protocol",
      name,
      filePath: relativePath,
      line: null,
      metadata,
    });
    if (relativePath) {
      this.addSimpleEdge(fileId(relativePath), protocolId(name), "defines", {
        source: "code-graph",
      });
    }
  }

  private addCategory(name: string, relativePath: string): void {
    this.addEntity({
      id: categoryId(name),
      type: "category",
      name,
      filePath: relativePath,
      line: null,
      metadata: { source: "code-graph" },
    });
    this.addSimpleEdge(fileId(relativePath), categoryId(name), "defines", { source: "code-graph" });
  }

  private addSimpleEdge(
    from: string,
    to: string,
    relation: EngineeringEntityRelation,
    metadata: Readonly<Record<string, unknown>>,
    weight = 1,
  ): void {
    this.addEdge({ from, to, relation, weight, metadata });
  }

  private ensureDependencyNode(id: string): void {
    const entityId = moduleId(id);
    if (!this.#entities.has(entityId)) {
      this.addEntity({
        id: entityId,
        type: "module",
        name: id,
        filePath: null,
        line: null,
        metadata: { source: "dependency-edge" },
      });
    }
  }

  private ensureReferenceEntity(
    id: string,
    rawRef: string,
    fallbackType: EngineeringEntityType,
    options: {
      readonly filePath: string | null;
      readonly line: number | null;
      readonly metadata: Readonly<Record<string, unknown>>;
    },
  ): void {
    if (this.#entities.has(id)) {
      return;
    }
    const type = entityTypeFromId(id) ?? fallbackType;
    this.addEntity({
      id,
      type,
      name: entityNameFromId(id) || extractCodeEntityRef(rawRef),
      filePath: options.filePath,
      line: options.line,
      metadata: options.metadata,
    });
  }

  private ensureRecipeEntity(id: string, title: string): void {
    if (this.#entities.has(id)) {
      return;
    }
    this.addEntity({
      id,
      type: "recipe",
      name: title,
      filePath: null,
      line: null,
      metadata: { source: "candidate-relations" },
    });
  }

  private neighborEdges(
    id: string,
    direction: "outgoing" | "incoming" | "both",
  ): readonly EngineeringEntityEdge[] {
    if (direction === "outgoing") {
      return this.findOutgoing(id);
    }
    if (direction === "incoming") {
      return this.findIncoming(id);
    }
    return [...this.findOutgoing(id), ...this.findIncoming(id)].sort(compareEdges);
  }

  private walkCalls(
    root: string,
    direction: "incoming" | "outgoing",
    maxDepthInput: number,
  ): readonly EngineeringCallReference[] {
    const maxDepth = Math.max(0, Math.floor(maxDepthInput));
    const results: EngineeringCallReference[] = [];
    const queue: { readonly id: string; readonly depth: number }[] = [{ id: root, depth: 0 }];
    const visited = new Set<string>([root]);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth >= maxDepth) {
        continue;
      }
      const edges =
        direction === "incoming"
          ? this.findIncoming(current.id, "calls")
          : this.findOutgoing(current.id, "calls");
      for (const edge of edges) {
        const nextId = direction === "incoming" ? edge.from : edge.to;
        const entity = this.findEntity(nextId);
        if (!entity) {
          continue;
        }
        const depth = current.depth + 1;
        results.push({
          entity,
          edge,
          depth,
          callType: stringMetadata(edge.metadata.callType, "unknown"),
        });
        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push({ id: nextId, depth });
        }
      }
    }

    return results.sort(
      (left, right) =>
        left.depth - right.depth ||
        left.entity.id.localeCompare(right.entity.id) ||
        compareEdges(left.edge, right.edge),
    );
  }

  private callImpactEdges(id: string): readonly EngineeringEntityEdge[] {
    return [...this.findIncoming(id, "calls"), ...this.findOutgoing(id, "data_flow")].sort(
      compareEdges,
    );
  }

  private criticalPaths(
    hotNodes: readonly EngineeringHotNode[],
    limit: number,
  ): readonly EngineeringEntityPath[] {
    const topology = this.getTopology();
    const paths: EngineeringEntityPath[] = [];
    for (const root of topology.roots) {
      for (const hotNode of hotNodes) {
        if (root === hotNode.id) {
          continue;
        }
        const path = this.findPath(root, hotNode.id);
        if (path && path.distance > 1) {
          paths.push(path);
        }
      }
    }
    return paths
      .sort(
        (left, right) =>
          right.distance - left.distance ||
          left.nodes.join("\u0000").localeCompare(right.nodes.join("\u0000")),
      )
      .slice(0, limit);
  }

  private callAndDataFlowSummary(limit: number): EngineeringAgentContext["callAndDataFlowSummary"] {
    const callEdges = this.edges.filter((edge) => edge.relation === "calls");
    const dataFlowEdges = this.edges.filter((edge) => edge.relation === "data_flow");
    const hotCallees = [...new Set(callEdges.map((edge) => edge.to))]
      .map((id) => {
        const entity = this.findEntity(id);
        const incoming = this.findIncoming(id, "calls");
        return entity
          ? {
              entity,
              callerCount: incoming.length,
              callers: incoming
                .map((edge) => this.findEntity(edge.from))
                .filter((caller): caller is EngineeringEntity => caller !== null)
                .sort(compareEntities)
                .slice(0, 5),
            }
          : null;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort(
        (left, right) =>
          right.callerCount - left.callerCount || left.entity.id.localeCompare(right.entity.id),
      )
      .slice(0, limit);
    const dataFlowSources = [...new Set(dataFlowEdges.map((edge) => edge.from))]
      .map((id) => {
        const entity = this.findEntity(id);
        return entity
          ? {
              entity,
              outgoingCount: this.findOutgoing(id, "data_flow").length,
            }
          : null;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort(
        (left, right) =>
          right.outgoingCount - left.outgoingCount || left.entity.id.localeCompare(right.entity.id),
      )
      .slice(0, limit);

    return {
      calls: callEdges.length,
      dataFlows: dataFlowEdges.length,
      hotCallees,
      dataFlowSources,
    };
  }

  private riskModules(limit: number): readonly {
    readonly entity: EngineeringEntity;
    readonly score: number;
    readonly reasons: readonly string[];
  }[] {
    return this.entities
      .map((entity) => {
        const outgoing = this.findOutgoing(entity.id);
        const incoming = this.findIncoming(entity.id);
        const reasons: string[] = [];
        let score = 0;
        const externalCount = outgoing.filter((edge) => {
          const target = this.findEntity(edge.to);
          return target?.type === "external";
        }).length;
        const callFanIn = incoming.filter((edge) => edge.relation === "calls").length;
        const dataFlowFanOut = outgoing.filter((edge) => edge.relation === "data_flow").length;

        if (externalCount > 0) {
          score += externalCount * 3;
          reasons.push(`${externalCount} external dependency edge(s)`);
        }
        if (callFanIn >= 2) {
          score += callFanIn * 2;
          reasons.push(`${callFanIn} caller(s)`);
        }
        if (dataFlowFanOut > 0) {
          score += dataFlowFanOut * 2;
          reasons.push(`${dataFlowFanOut} outgoing data flow(s)`);
        }
        if (incoming.length + outgoing.length >= 4) {
          score += incoming.length + outgoing.length;
          reasons.push("high graph degree");
        }

        return { entity, score, reasons };
      })
      .filter((risk) => risk.score > 0)
      .sort(
        (left, right) => right.score - left.score || left.entity.id.localeCompare(right.entity.id),
      )
      .slice(0, limit);
  }

  private removeEdges(predicate: (edge: EngineeringEntityEdge) => boolean): number {
    let deleted = 0;
    for (const edge of this.edges) {
      if (predicate(edge)) {
        this.#edges.delete(edgeKey(edge.from, edge.to, edge.relation));
        deleted++;
      }
    }
    return deleted;
  }
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

function targetId(name: string): string {
  return `target:${name}`;
}

function fileId(path: string): string {
  return `file:${path}`;
}

function moduleId(name: string): string {
  return `module:${name}`;
}

function classId(name: string): string {
  return `class:${name}`;
}

function protocolId(name: string): string {
  return `protocol:${name}`;
}

function categoryId(name: string): string {
  return `category:${name}`;
}

function methodId(owner: string, name: string): string {
  return `method:${owner}.${name}`;
}

function propertyId(owner: string, name: string): string {
  return `property:${owner}.${name}`;
}

function patternId(name: string): string {
  return name.startsWith("pattern:") ? name : `pattern:${name}`;
}

function recipeId(name: string): string {
  return name.startsWith("recipe:") ? name : `recipe:${name}`;
}

function dependencyEntityType(node: EngineeringDependencyNode): EngineeringEntityType {
  return isExternalEngineeringDependencyNode(node) ? "external" : "module";
}

function matchesRelation(
  edge: EngineeringEntityEdge,
  relation: EngineeringEntityRelation | undefined,
): boolean {
  return relation === undefined || edge.relation === relation;
}

function countEdgesByRelation(
  edges: readonly EngineeringEntityEdge[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const edge of edges) {
    counts[edge.relation] = (counts[edge.relation] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizedPathSet(paths: readonly string[]): ReadonlySet<string> {
  return new Set(paths.map((path) => path.trim()).filter(Boolean));
}

function entityBelongsToFiles(entity: EngineeringEntity, paths: ReadonlySet<string>): boolean {
  return (
    (entity.filePath !== null && paths.has(entity.filePath)) ||
    (entity.type === "file" && paths.has(entity.id.replace(/^file:/, "")))
  );
}

function edgeBelongsToFiles(
  edge: EngineeringEntityEdge,
  entities: ReadonlyMap<string, EngineeringEntity>,
  paths: ReadonlySet<string>,
): boolean {
  const from = entities.get(edge.from);
  const to = entities.get(edge.to);
  return (
    metadataReferencesFile(edge.metadata, paths) ||
    (from !== undefined && entityBelongsToFiles(from, paths)) ||
    (to !== undefined && entityBelongsToFiles(to, paths))
  );
}

function metadataReferencesFile(
  metadata: Readonly<Record<string, unknown>>,
  paths: ReadonlySet<string>,
): boolean {
  for (const key of ["file", "filePath", "path", "sourceFile"]) {
    const value = metadata[key];
    if (typeof value === "string" && paths.has(value)) {
      return true;
    }
  }
  return false;
}

function isNonEmptyString(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringMetadata(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function codeReferenceEntityId(ref: string, fallbackType: EngineeringEntityType): string {
  const clean = extractCodeEntityRef(ref);
  if (!clean) {
    return "";
  }
  return hasEntityPrefix(clean) ? clean : `${fallbackType}:${clean}`;
}

function extractCodeEntityRef(ref: string): string {
  const clean = ref.trim();
  if (!clean) {
    return "";
  }
  const separator = clean.lastIndexOf("::");
  if (separator >= 0 && separator < clean.length - 2) {
    return clean.slice(separator + 2).trim();
  }
  return clean;
}

function filePathFromCodeReference(ref: string): string | null {
  const clean = ref.trim();
  const separator = clean.lastIndexOf("::");
  if (separator <= 0) {
    return null;
  }
  return clean.slice(0, separator);
}

function hasEntityPrefix(value: string): boolean {
  return entityTypes.some((type) => value.startsWith(`${type}:`));
}

function entityTypeFromId(id: string): EngineeringEntityType | null {
  return entityTypes.find((type) => id.startsWith(`${type}:`)) ?? null;
}

function entityNameFromId(id: string): string {
  const type = entityTypeFromId(id);
  return type ? id.slice(type.length + 1) : id;
}

function flattenCandidateRelations(relations: unknown): readonly EngineeringCandidateRelation[] {
  if (!relations) {
    return [];
  }
  if (hasToFlatArray(relations)) {
    return flattenCandidateRelations(relations.toFlatArray());
  }
  if (Array.isArray(relations)) {
    return relations.flatMap((relation) => relationFromUnknown(relation, null));
  }
  if (isRecord(relations)) {
    const flattened: EngineeringCandidateRelation[] = [];
    for (const [type, list] of Object.entries(relations)) {
      for (const item of Array.isArray(list) ? list : [list]) {
        flattened.push(...relationFromUnknown(item, type));
      }
    }
    return flattened;
  }
  return [];
}

function relationFromUnknown(
  value: unknown,
  fallbackType: string | null,
): EngineeringCandidateRelation[] {
  if (typeof value === "string" && fallbackType) {
    return [{ type: fallbackType, target: value }];
  }
  if (!isRecord(value)) {
    return [];
  }
  const type = firstString(value.type, fallbackType);
  const target = firstString(value.target, value.id, value.title);
  if (!type || !target) {
    return [];
  }
  const description = firstString(value.description);
  return [
    {
      type,
      target,
      ...(description ? { description } : {}),
    },
  ];
}

function hasToFlatArray(value: unknown): value is { toFlatArray: () => unknown } {
  return isRecord(value) && typeof value.toFlatArray === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mapCandidateRelationType(type: string): string {
  const mapping: Readonly<Record<string, string>> = {
    inherits: "inherits",
    implements: "conforms",
    calls: "calls",
    depends_on: "depends_on",
    data_flow: "data_flow",
    conflicts: "conflicts",
    extends: "extends",
    related: "related",
    alternative: "related",
    prerequisite: "depends_on",
    deprecated_by: "related",
    solves: "related",
    enforces: "enforces",
    references: "references",
  };
  return mapping[type] ?? "related";
}

function buildPath(
  from: string,
  to: string,
  previous: ReadonlyMap<string, EngineeringEntityEdge>,
): EngineeringEntityPath {
  const edges: EngineeringEntityEdge[] = [];
  let current = to;
  while (current !== from) {
    const edge = previous.get(current);
    if (!edge) {
      break;
    }
    edges.push(edge);
    current = edge.from;
  }
  edges.reverse();
  return {
    nodes: [from, ...edges.map((edge) => edge.to)],
    edges,
    distance: edges.length,
  };
}

function connectedComponents(
  ids: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): readonly (readonly string[])[] {
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of ids) {
    if (visited.has(id)) {
      continue;
    }
    const component: string[] = [];
    const stack = [id];
    visited.add(id);
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      component.push(current);
      for (const next of [...(adjacency.get(current) ?? [])].sort()) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
    components.push(component.sort());
  }
  return components.sort((left, right) => left[0]?.localeCompare(right[0] ?? "") ?? 0);
}

function directedCycles(
  ids: readonly string[],
  edges: readonly EngineeringEntityEdge[],
): readonly (readonly string[])[] {
  const adjacency = new Map<string, string[]>();
  for (const id of ids) {
    adjacency.set(id, []);
  }
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to].sort());
  }

  const cycles = new Map<string, readonly string[]>();
  for (const start of ids) {
    visitCycle(start, start, adjacency, [], new Set(), cycles);
  }
  return [...cycles.values()].sort((left, right) =>
    left.join("\u0000").localeCompare(right.join("\u0000")),
  );
}

function visitCycle(
  start: string,
  current: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  path: readonly string[],
  seen: ReadonlySet<string>,
  cycles: Map<string, readonly string[]>,
): void {
  if (path.length > 24) {
    return;
  }
  const nextPath = [...path, current];
  const nextSeen = new Set(seen);
  nextSeen.add(current);
  for (const next of adjacency.get(current) ?? []) {
    if (next === start && nextPath.length > 1) {
      const cycle = canonicalCycle(nextPath);
      cycles.set(cycle.join("\u0000"), cycle);
    } else if (!nextSeen.has(next)) {
      visitCycle(start, next, adjacency, nextPath, nextSeen, cycles);
    }
  }
}

function canonicalCycle(cycle: readonly string[]): readonly string[] {
  const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)]);
  return (
    rotations.sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000")))[0] ??
    []
  );
}

function zeroHotNode(id: string): EngineeringHotNode {
  return { id, degree: 0, fanIn: 0, fanOut: 0, weightedDegree: 0 };
}

function edgeKey(from: string, to: string, relation: EngineeringEntityRelation): string {
  return `${from}\u0000${to}\u0000${relation}`;
}

function compareEntities(left: EngineeringEntity, right: EngineeringEntity): number {
  return left.id.localeCompare(right.id);
}

function compareEdges(left: EngineeringEntityEdge, right: EngineeringEntityEdge): number {
  return (
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.relation.localeCompare(right.relation)
  );
}

function roundWeight(value: number): number {
  return Math.round(value * 1000) / 1000;
}

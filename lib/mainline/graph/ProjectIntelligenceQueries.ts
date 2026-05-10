import { normalizeMainlinePosixPath } from "../core/PathIdentity.js";
import type {
  MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceEdge,
  MainlineProjectIntelligenceSymbol,
} from "./ProjectIntelligenceArtifact.js";

export type MainlineProjectIntelligenceTraversalDirection = "incoming" | "outgoing" | "both";

export interface MainlineProjectIntelligenceSymbolRelation {
  readonly symbol: MainlineProjectIntelligenceSymbol;
  readonly edge: MainlineProjectIntelligenceEdge;
}

export interface MainlineProjectIntelligenceImpactOptions {
  readonly maxDepth?: number;
  readonly direction?: MainlineProjectIntelligenceTraversalDirection;
  readonly includeStart?: boolean;
}

export interface MainlineProjectIntelligenceImpactNode {
  readonly id: string;
  readonly kind: "file" | "symbol";
  readonly depth: number;
  readonly path?: string;
  readonly fqn?: string;
  readonly name?: string;
  readonly via: MainlineProjectIntelligenceEdge[];
}

export interface MainlineProjectIntelligenceFileDependency {
  readonly file: string;
  readonly kind: MainlineProjectIntelligenceEdge["kind"];
  readonly specifier?: string;
  readonly edge: MainlineProjectIntelligenceEdge;
}

export interface MainlineProjectIntelligenceFileDependencyAdjacency {
  readonly file: string;
  readonly dependencies: MainlineProjectIntelligenceFileDependency[];
  readonly dependents: MainlineProjectIntelligenceFileDependency[];
}

export interface MainlineProjectIntelligenceCycle {
  readonly kind: "file";
  readonly nodes: string[];
}

/**
 * ProjectIntelligenceQueries 是 runtime/search 的事实查询底座。
 * 它只读取 MainlineProjectIntelligenceArtifact 并返回稳定纯对象；
 * 这里不承担持久化，也不迁移旧 CodeEntityGraph repository。
 */
export class MainlineProjectIntelligenceQueries {
  readonly #artifact: MainlineProjectIntelligenceArtifact;
  readonly #symbolsById: Map<string, MainlineProjectIntelligenceSymbol>;
  readonly #symbolsByFqn: Map<string, MainlineProjectIntelligenceSymbol>;
  readonly #fileIds: Set<string>;
  readonly #edgesByFrom: Map<string, MainlineProjectIntelligenceEdge[]>;
  readonly #edgesByTo: Map<string, MainlineProjectIntelligenceEdge[]>;

  constructor(artifact: MainlineProjectIntelligenceArtifact) {
    this.#artifact = artifact;
    this.#symbolsById = new Map(artifact.symbols.map((symbol) => [symbol.id, symbol]));
    this.#symbolsByFqn = new Map(artifact.symbols.map((symbol) => [symbol.fqn, symbol]));
    this.#fileIds = new Set(artifact.files.map((file) => fileNodeId(file.path)));
    this.#edgesByFrom = groupEdges(artifact.semanticEdges, "from");
    this.#edgesByTo = groupEdges(artifact.semanticEdges, "to");
  }

  callers(symbolRef: string): MainlineProjectIntelligenceSymbolRelation[] {
    const symbolId = this.#normalizeSymbolRef(symbolRef);
    if (!symbolId) {
      return [];
    }

    return (this.#edgesByTo.get(symbolId) ?? [])
      .filter(isCallEdge)
      .flatMap((edge) => {
        const symbol = this.#symbolsById.get(edge.from);
        return symbol ? [{ symbol: cloneSymbol(symbol), edge: cloneEdge(edge) }] : [];
      })
      .sort(compareSymbolRelations);
  }

  callees(symbolRef: string): MainlineProjectIntelligenceSymbolRelation[] {
    const symbolId = this.#normalizeSymbolRef(symbolRef);
    if (!symbolId) {
      return [];
    }

    return (this.#edgesByFrom.get(symbolId) ?? [])
      .filter(isCallEdge)
      .flatMap((edge) => {
        const symbol = this.#symbolsById.get(edge.to);
        return symbol ? [{ symbol: cloneSymbol(symbol), edge: cloneEdge(edge) }] : [];
      })
      .sort(compareSymbolRelations);
  }

  impactRadius(
    nodeRef: string,
    options: MainlineProjectIntelligenceImpactOptions = {},
  ): MainlineProjectIntelligenceImpactNode[] {
    const startId = this.#normalizeNodeRef(nodeRef);
    if (!startId) {
      return [];
    }

    const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 1));
    const direction = options.direction ?? "both";
    const visitedDepth = new Map<string, number>([[startId, 0]]);
    const viaEdges = new Map<string, MainlineProjectIntelligenceEdge[]>();
    const queue: Array<{ readonly id: string; readonly depth: number }> = [
      { id: startId, depth: 0 },
    ];

    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!current || current.depth >= maxDepth) {
        continue;
      }

      for (const { edge, next } of this.#neighborEdges(current.id, direction)) {
        const nextDepth = current.depth + 1;
        const knownDepth = visitedDepth.get(next);
        if (knownDepth === undefined) {
          visitedDepth.set(next, nextDepth);
          viaEdges.set(next, [edge]);
          queue.push({ id: next, depth: nextDepth });
          continue;
        }
        if (knownDepth === nextDepth) {
          viaEdges.set(next, sortEdges([...(viaEdges.get(next) ?? []), edge]));
        }
      }
    }

    return [...visitedDepth.entries()]
      .filter(([id]) => options.includeStart || id !== startId)
      .map(([id, depth]) => this.#impactNode(id, depth, viaEdges.get(id) ?? []))
      .filter((node): node is MainlineProjectIntelligenceImpactNode => Boolean(node))
      .sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id));
  }

  fileDependencyAdjacency(fileRef?: string): MainlineProjectIntelligenceFileDependencyAdjacency[] {
    const fileIds = fileRef
      ? this.#normalizeFileRef(fileRef)
        ? [this.#normalizeFileRef(fileRef)]
        : []
      : [...this.#fileIds].sort();

    return fileIds
      .flatMap((fileId) => {
        if (!fileId || !this.#fileIds.has(fileId)) {
          return [];
        }

        return [
          {
            file: fileId.slice("file:".length),
            dependencies: this.#fileDependencies(fileId, "outgoing"),
            dependents: this.#fileDependencies(fileId, "incoming"),
          },
        ];
      })
      .sort((left, right) => left.file.localeCompare(right.file));
  }

  cycles(fileRef?: string): MainlineProjectIntelligenceCycle[] {
    const normalizedFile = fileRef ? this.#normalizeFileRef(fileRef) : undefined;
    if (fileRef && (!normalizedFile || !this.#fileIds.has(normalizedFile))) {
      return [];
    }
    const pathFilter = normalizedFile?.slice("file:".length);

    return this.#artifact.projectGraph.cycles
      .filter((cycle) => !pathFilter || cycle.includes(pathFilter))
      .map((cycle) => ({ kind: "file" as const, nodes: [...cycle] }))
      .sort((left, right) => left.nodes.join("\u0000").localeCompare(right.nodes.join("\u0000")));
  }

  #normalizeSymbolRef(ref: string): string | undefined {
    const trimmed = ref.trim();
    if (!trimmed) {
      return undefined;
    }

    if (trimmed.startsWith("symbol:")) {
      if (this.#symbolsById.has(trimmed)) {
        return trimmed;
      }
      const normalizedLegacyId = normalizeLegacySymbolId(trimmed);
      return this.#symbolsById.has(normalizedLegacyId) ? normalizedLegacyId : undefined;
    }

    const symbol = this.#symbolsByFqn.get(normalizeLegacySymbolFqn(trimmed));
    return symbol?.id;
  }

  #normalizeFileRef(ref: string): string | undefined {
    const rawPath = ref.startsWith("file:") ? ref.slice("file:".length) : ref;
    const normalizedPath = normalizeMainlinePosixPath(rawPath);
    return normalizedPath ? fileNodeId(normalizedPath) : undefined;
  }

  #normalizeNodeRef(ref: string): string | undefined {
    const symbolId = this.#normalizeSymbolRef(ref);
    if (symbolId) {
      return symbolId;
    }

    const fileId = this.#normalizeFileRef(ref);
    if (fileId && this.#fileIds.has(fileId)) {
      return fileId;
    }

    return undefined;
  }

  #neighborEdges(
    nodeId: string,
    direction: MainlineProjectIntelligenceTraversalDirection,
  ): Array<{ readonly edge: MainlineProjectIntelligenceEdge; readonly next: string }> {
    const outgoing =
      direction === "incoming"
        ? []
        : (this.#edgesByFrom.get(nodeId) ?? []).map((edge) => ({ edge, next: edge.to }));
    const incoming =
      direction === "outgoing"
        ? []
        : (this.#edgesByTo.get(nodeId) ?? []).map((edge) => ({ edge, next: edge.from }));
    return [...outgoing, ...incoming].sort(
      (left, right) => compareEdges(left.edge, right.edge) || left.next.localeCompare(right.next),
    );
  }

  #impactNode(
    id: string,
    depth: number,
    via: readonly MainlineProjectIntelligenceEdge[],
  ): MainlineProjectIntelligenceImpactNode | undefined {
    if (id.startsWith("file:")) {
      if (!this.#fileIds.has(id)) {
        return undefined;
      }
      return {
        id,
        kind: "file",
        depth,
        path: id.slice("file:".length),
        via: sortEdges(via).map(cloneEdge),
      };
    }

    const symbol = this.#symbolsById.get(id);
    if (!symbol) {
      return undefined;
    }

    return {
      id,
      kind: "symbol",
      depth,
      path: symbol.file,
      fqn: symbol.fqn,
      name: symbol.name,
      via: sortEdges(via).map(cloneEdge),
    };
  }

  #fileDependencies(
    fileId: string,
    direction: Extract<MainlineProjectIntelligenceTraversalDirection, "incoming" | "outgoing">,
  ): MainlineProjectIntelligenceFileDependency[] {
    const edges =
      direction === "outgoing"
        ? (this.#edgesByFrom.get(fileId) ?? [])
        : (this.#edgesByTo.get(fileId) ?? []);

    return edges
      .filter(isFileDependencyEdge)
      .flatMap((edge) => {
        const relatedFileId = direction === "outgoing" ? edge.to : edge.from;
        if (!this.#fileIds.has(relatedFileId)) {
          return [];
        }
        return [
          {
            file: relatedFileId.slice("file:".length),
            kind: edge.kind,
            ...(edge.specifier ? { specifier: edge.specifier } : {}),
            edge: cloneEdge(edge),
          },
        ];
      })
      .sort(
        (left, right) =>
          left.file.localeCompare(right.file) ||
          left.kind.localeCompare(right.kind) ||
          (left.specifier ?? "").localeCompare(right.specifier ?? ""),
      );
  }
}

function fileNodeId(path: string): string {
  return `file:${path}`;
}

function normalizeLegacySymbolId(symbolId: string): string {
  const body = symbolId.slice("symbol:".length);
  const separator = body.lastIndexOf("#");
  if (separator <= 0) {
    return symbolId;
  }
  return `symbol:${body.slice(0, separator)}::${body.slice(separator + 1)}`;
}

function normalizeLegacySymbolFqn(fqn: string): string {
  const separator = fqn.lastIndexOf("#");
  if (separator <= 0 || fqn.includes("::")) {
    return fqn;
  }
  return `${fqn.slice(0, separator)}::${fqn.slice(separator + 1)}`;
}

function groupEdges(
  edges: readonly MainlineProjectIntelligenceEdge[],
  key: "from" | "to",
): Map<string, MainlineProjectIntelligenceEdge[]> {
  const grouped = new Map<string, MainlineProjectIntelligenceEdge[]>();
  for (const edge of sortEdges(edges)) {
    grouped.set(edge[key], [...(grouped.get(edge[key]) ?? []), edge]);
  }
  return grouped;
}

function isCallEdge(edge: MainlineProjectIntelligenceEdge): boolean {
  return edge.kind === "calls" || edge.kind === "constructs";
}

function isFileDependencyEdge(edge: MainlineProjectIntelligenceEdge): boolean {
  return (
    edge.from.startsWith("file:") &&
    edge.to.startsWith("file:") &&
    ["imports", "exports", "requires", "dynamic-import"].includes(edge.kind)
  );
}

function cloneSymbol(symbol: MainlineProjectIntelligenceSymbol): MainlineProjectIntelligenceSymbol {
  return { ...symbol };
}

function cloneEdge(edge: MainlineProjectIntelligenceEdge): MainlineProjectIntelligenceEdge {
  return { ...edge };
}

function sortEdges(
  edges: readonly MainlineProjectIntelligenceEdge[],
): MainlineProjectIntelligenceEdge[] {
  return [...edges].sort(compareEdges);
}

function compareEdges(
  left: MainlineProjectIntelligenceEdge,
  right: MainlineProjectIntelligenceEdge,
): number {
  return (
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.kind.localeCompare(right.kind) ||
    (left.specifier ?? "").localeCompare(right.specifier ?? "") ||
    (left.line ?? 0) - (right.line ?? 0)
  );
}

function compareSymbolRelations(
  left: MainlineProjectIntelligenceSymbolRelation,
  right: MainlineProjectIntelligenceSymbolRelation,
): number {
  return left.symbol.fqn.localeCompare(right.symbol.fqn) || compareEdges(left.edge, right.edge);
}

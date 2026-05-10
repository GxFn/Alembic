import type { ContextIndexWriter } from "../data/index.js";
import type {
  MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceFile,
  MainlineProjectIntelligenceSymbol,
} from "../graph/index.js";
import { createSourceRef, type SourceRef } from "../knowledge/index.js";
import type { MainlineSearchDocument, MainlineSearchIndex } from "../search/index.js";

export interface MainlineProjectIntelligenceSearchWriter
  extends Pick<MainlineSearchIndex, "upsert" | "remove"> {}

export interface MainlineProjectIntelligenceMaterializeTarget {
  readonly contextIndex?: ContextIndexWriter;
  readonly searchIndex?: MainlineProjectIntelligenceSearchWriter;
}

export interface MainlineProjectIntelligenceMaterializeOptions {
  readonly staleSourceRefs?: readonly SourceRef[];
  readonly searchDocumentIdsToRemove?: readonly string[];
}

export interface MainlineProjectIntelligenceMaterializeResult {
  readonly sourceRefs: SourceRef[];
  readonly staleSourceRefs: SourceRef[];
  readonly searchDocuments: MainlineSearchDocument[];
  readonly removedSearchDocumentIds: string[];
}

/**
 * ProjectIntelligenceMaterializer 是项目 facts 进入运行期底座的写入路径。
 * 它只物化 SourceRef 和搜索文档，不生成 Recipe；Recipe 仍由内容挖掘主线负责。
 */
export class MainlineProjectIntelligenceMaterializer {
  async materialize(
    artifact: MainlineProjectIntelligenceArtifact,
    target: MainlineProjectIntelligenceMaterializeTarget,
    options: MainlineProjectIntelligenceMaterializeOptions = {},
  ): Promise<MainlineProjectIntelligenceMaterializeResult> {
    const sourceRefs = sourceRefsFromProjectIntelligence(artifact);
    const staleSourceRefs = [...(options.staleSourceRefs ?? [])];
    const searchDocuments = searchDocumentsFromProjectIntelligence(artifact);
    const removedSearchDocumentIds = [...(options.searchDocumentIdsToRemove ?? [])];

    if (target.contextIndex) {
      await target.contextIndex.upsertContextArtifacts({
        sourceRefs: [...sourceRefs, ...staleSourceRefs],
      });
    }
    if (target.searchIndex) {
      target.searchIndex.remove(removedSearchDocumentIds);
      target.searchIndex.upsert(searchDocuments);
    }

    return { sourceRefs, staleSourceRefs, searchDocuments, removedSearchDocumentIds };
  }
}

export function staleSourceRefsFromProjectIntelligence(
  artifact: MainlineProjectIntelligenceArtifact,
  sourceRefIds: readonly string[],
): SourceRef[] {
  const files = new Map(artifact.files.map((file) => [file.path, file]));
  const symbols = new Map(artifact.symbols.map((symbol) => [symbol.id, symbol]));

  return [...new Set(sourceRefIds)].flatMap((sourceRefId) => {
    const file = files.get(sourceRefId);
    if (file) {
      return [staleFileSourceRef(file)];
    }
    const symbol = symbols.get(sourceRefId);
    if (symbol) {
      return [staleSymbolSourceRef(symbol)];
    }
    return [];
  });
}

export function sourceRefsFromProjectIntelligence(
  artifact: MainlineProjectIntelligenceArtifact,
): SourceRef[] {
  const fileRefs = artifact.files.map((file) =>
    createSourceRef({
      id: file.path,
      kind: "file",
      path: file.path,
      status: file.status === "parsed" ? "active" : "unknown",
      contentHash: file.contentHash,
      summary: `${file.languageId} source file`,
      metadata: {
        languageId: file.languageId,
        symbolCount: file.symbolIds.length,
        projectIntelligence: true,
      },
    }),
  );
  const symbolRefs = artifact.symbols.map((symbol) =>
    createSourceRef({
      id: symbol.id,
      kind: "symbol",
      path: symbol.file,
      startLine: symbol.line || undefined,
      symbol: symbol.fqn,
      status: "active",
      summary: `${symbol.kind} ${symbol.name}`,
      metadata: {
        languageId: symbol.languageId,
        fqn: symbol.fqn,
        kind: symbol.kind,
        containerName: symbol.containerName,
        isExported: symbol.isExported,
        projectIntelligence: true,
      },
    }),
  );

  return [...fileRefs, ...symbolRefs];
}

function staleFileSourceRef(file: MainlineProjectIntelligenceFile): SourceRef {
  return createSourceRef({
    id: file.path,
    kind: "file",
    path: file.path,
    status: "stale",
    contentHash: file.contentHash,
    summary: `${file.languageId} source file removed or invalidated`,
    metadata: {
      languageId: file.languageId,
      symbolCount: file.symbolIds.length,
      projectIntelligence: true,
      staleReason: "project-intelligence-incremental-plan",
    },
  });
}

function staleSymbolSourceRef(symbol: MainlineProjectIntelligenceSymbol): SourceRef {
  return createSourceRef({
    id: symbol.id,
    kind: "symbol",
    path: symbol.file,
    startLine: symbol.line || undefined,
    symbol: symbol.fqn,
    status: "stale",
    summary: `${symbol.kind} ${symbol.name} removed or invalidated`,
    metadata: {
      languageId: symbol.languageId,
      fqn: symbol.fqn,
      kind: symbol.kind,
      projectIntelligence: true,
      staleReason: "project-intelligence-incremental-plan",
    },
  });
}

export function searchDocumentsFromProjectIntelligence(
  artifact: MainlineProjectIntelligenceArtifact,
): MainlineSearchDocument[] {
  const fileDocuments = artifact.files.map((file) => ({
    id: `file:${file.path}`,
    kind: "file" as const,
    title: file.path,
    path: file.path,
    tags: [file.languageId, "project-intelligence"],
    metadata: {
      languageId: file.languageId,
      status: file.status,
      contentHash: file.contentHash,
      symbolCount: file.symbolIds.length,
    },
  }));
  const symbolDocuments = artifact.symbols.map((symbol) => ({
    id: symbol.id,
    kind: "symbol" as const,
    title: `${symbol.name} (${symbol.kind})`,
    body: [symbol.fqn, symbol.containerName, symbol.isExported ? "exported" : "local"]
      .filter(Boolean)
      .join("\n"),
    path: symbol.file,
    symbol: symbol.fqn,
    tags: [symbol.kind, symbol.languageId],
    metadata: {
      languageId: symbol.languageId,
      kind: symbol.kind,
      fqn: symbol.fqn,
      line: symbol.line,
      isExported: symbol.isExported,
    },
  }));
  const edgeDocuments = artifact.semanticEdges.map((edge, index) => ({
    id: `graph-edge:${index}:${edge.kind}:${edge.from}:${edge.to}`,
    kind: "graph-node" as const,
    title: `${edge.kind}: ${edge.from} -> ${edge.to}`,
    body: [edge.from, edge.to, edge.specifier, edge.file].filter(Boolean).join("\n"),
    ...(edge.file === undefined ? {} : { path: edge.file }),
    tags: ["graph", edge.kind],
    metadata: {
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      line: edge.line,
      specifier: edge.specifier,
    },
  }));

  return [...fileDocuments, ...symbolDocuments, ...edgeDocuments];
}

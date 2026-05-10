import { normalizeMainlinePosixPath } from "../core/PathIdentity.js";
import { fuseMainlineRankedHits, type MainlineRankedSearchHit } from "./RrfFusion.js";
import type {
  MainlineSearchDocument,
  MainlineSearchHit,
  MainlineSearchIndex,
  MainlineSearchQuery,
} from "./SearchIndex.js";
import type { MainlineVectorSearchHit, MainlineVectorStore } from "./VectorStore.js";

export interface MainlineEmbeddingInput {
  readonly id: string;
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
}

export interface MainlineEmbeddingSuccess {
  readonly id: string;
  readonly vector: readonly number[];
  readonly metadata?: Record<string, unknown>;
}

export interface MainlineEmbeddingFailure {
  readonly id: string;
  readonly error: unknown;
  readonly metadata?: Record<string, unknown>;
}

export type MainlineEmbeddingResult = MainlineEmbeddingSuccess | MainlineEmbeddingFailure;

export interface MainlineBatchEmbeddingReport {
  readonly vectors: MainlineEmbeddingSuccess[];
  readonly failures: MainlineEmbeddingFailure[];
}

export interface MainlineBatchEmbedder {
  embedBatch(
    inputs: readonly MainlineEmbeddingInput[],
  ): Promise<readonly MainlineEmbeddingResult[]>;
}

export interface MainlineHybridSearchHit {
  readonly document: MainlineSearchDocument;
  readonly score: number;
  readonly confidence?: number;
  readonly reasons: string[];
  readonly meta?: Record<string, unknown>;
  readonly sources: string[];
  readonly ranks: Record<string, number>;
  readonly sparseScore?: number;
  readonly vectorScore?: number;
}

export interface MainlineHybridSearchConfig {
  readonly searchIndex: MainlineSearchIndex;
  readonly vectorStore?: MainlineVectorStore;
  readonly embedder?: MainlineBatchEmbedder;
  readonly rrfK?: number;
}

export interface MainlineHybridSearchOptions {
  readonly queryVector?: readonly number[];
  readonly embedder?: MainlineBatchEmbedder;
  readonly vectorLimit?: number;
  readonly vectorMinScore?: number;
  readonly vectorFilter?: Record<string, unknown>;
  readonly sparseLimit?: number;
  readonly rrfK?: number;
}

export interface MainlineHybridEmbedDocumentsOptions {
  readonly embedder?: MainlineBatchEmbedder;
}

/**
 * 主线 hybrid retrieval facade。
 * 中文注释：稀疏索引和向量库各自产生稳定排名，RRF 只消费排名；
 * provider、embedding 维度和向量库实现都留在端口后面，不向运行期泄露。
 */
export class MainlineHybridSearch {
  readonly #searchIndex: MainlineSearchIndex;
  readonly #vectorStore: MainlineVectorStore | undefined;
  readonly #embedder: MainlineBatchEmbedder | undefined;
  readonly #rrfK: number | undefined;

  constructor(config: MainlineHybridSearchConfig) {
    this.#searchIndex = config.searchIndex;
    this.#vectorStore = config.vectorStore;
    this.#embedder = config.embedder;
    this.#rrfK = config.rrfK;
  }

  async search(
    query: MainlineSearchQuery,
    options: MainlineHybridSearchOptions = {},
  ): Promise<MainlineHybridSearchHit[]> {
    const limit = query.limit ?? 20;
    const sparseHits = this.#searchSparse(query, options, limit);
    const queryVector = await this.#resolveQueryVector(query, options);
    const vectorHits = await this.#searchVector(query, queryVector, options, limit);

    // 降级策略：没有向量、embedding 失败或向量库异常时，不抛给调用方。
    // 稀疏搜索是硬路径，语义搜索只是增强路径。
    if (vectorHits.length === 0) {
      return sparseHits.slice(0, limit).map((hit, index) => ({
        document: hit.document,
        score: hit.score,
        reasons: hit.reasons,
        meta: {
          ...hit.meta,
          degraded: true,
          degradedReason: vectorDegradedReason(query, options, Boolean(this.#vectorStore)),
        },
        sources: ["sparse"],
        ranks: { sparse: index + 1 },
        sparseScore: hit.score,
        ...(hit.confidence === undefined ? {} : { confidence: hit.confidence }),
      }));
    }

    const documentsById = new Map(
      this.#searchIndex.snapshot().map((document) => [document.id, document]),
    );
    const sparseById = new Map(sparseHits.map((hit) => [hit.document.id, hit]));
    const vectorById = new Map(vectorHits.map((hit) => [hit.item.id, hit]));
    const rankedLists: MainlineRankedSearchHit[][] = [
      sparseHits.map((hit) => ({ id: hit.document.id, score: hit.score, source: "sparse" })),
      vectorHits.map((hit) => ({ id: hit.item.id, score: hit.score, source: "vector" })),
    ].filter((list) => list.length > 0);

    const hits: MainlineHybridSearchHit[] = [];
    const rrfK = options.rrfK ?? this.#rrfK;
    const fusionOptions = rrfK === undefined ? { limit } : { limit, k: rrfK };
    for (const hit of fuseMainlineRankedHits(rankedLists, fusionOptions)) {
      const document = documentsById.get(hit.id);
      if (!document) {
        continue;
      }
      const sparseHit = sparseById.get(hit.id);
      const vectorHit = vectorById.get(hit.id);
      hits.push({
        document,
        score: hit.score,
        reasons: uniqueStrings([
          ...(sparseHit?.reasons ?? []),
          ...(vectorHit ? ["vector:cosine"] : []),
          "fusion:rrf",
        ]),
        meta: {
          ...(sparseHit?.meta ?? {}),
          degraded: false,
        },
        sources: hit.sources,
        ranks: hit.ranks,
        ...(sparseHit?.confidence === undefined ? {} : { confidence: sparseHit.confidence }),
        ...(sparseHit ? { sparseScore: sparseHit.score } : {}),
        ...(vectorHit ? { vectorScore: vectorHit.score } : {}),
      });
    }

    return hits;
  }

  async embedDocuments(
    documents: readonly MainlineSearchDocument[],
    options: MainlineHybridEmbedDocumentsOptions = {},
  ): Promise<MainlineBatchEmbeddingReport> {
    const embedder = options.embedder ?? this.#embedder;
    if (!embedder) {
      return {
        vectors: [],
        failures: documents.map((document) => ({
          id: document.id,
          error: new Error("MainlineBatchEmbedder is required"),
          ...(document.metadata === undefined ? {} : { metadata: document.metadata }),
        })),
      };
    }

    const report = await embedMainlineBatch(
      embedder,
      documents.map((document) => ({
        id: document.id,
        text: mainlineSearchDocumentEmbeddingText(document),
        metadata: {
          ...document.metadata,
          kind: document.kind,
          path: document.path,
          symbol: document.symbol,
        },
      })),
    );

    if (this.#vectorStore && report.vectors.length > 0) {
      const contentById = new Map(
        documents.map((document) => [document.id, mainlineSearchDocumentEmbeddingText(document)]),
      );
      await this.#vectorStore.upsert(
        report.vectors.map((result) => {
          const content = contentById.get(result.id);
          return {
            id: result.id,
            vector: result.vector,
            ...(content === undefined ? {} : { content }),
            ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
          };
        }),
      );
    }

    return report;
  }

  #searchSparse(
    query: MainlineSearchQuery,
    options: MainlineHybridSearchOptions,
    limit: number,
  ): MainlineSearchHit[] {
    if (!hasSparseSignal(query) && options.queryVector) {
      return [];
    }
    return this.#searchIndex.search({
      ...query,
      limit: options.sparseLimit ?? Math.max(limit, 50),
    });
  }

  async #resolveQueryVector(
    query: MainlineSearchQuery,
    options: MainlineHybridSearchOptions,
  ): Promise<readonly number[] | undefined> {
    if (options.queryVector && options.queryVector.length > 0) {
      return options.queryVector;
    }
    const embedder = options.embedder ?? this.#embedder;
    if (!embedder || !query.text?.trim()) {
      return undefined;
    }
    const report = await embedMainlineBatch(embedder, [{ id: "query", text: query.text }]);
    return report.vectors[0]?.vector;
  }

  async #searchVector(
    query: MainlineSearchQuery,
    queryVector: readonly number[] | undefined,
    options: MainlineHybridSearchOptions,
    limit: number,
  ): Promise<MainlineVectorSearchHit[]> {
    if (!this.#vectorStore || !queryVector || queryVector.length === 0) {
      return [];
    }
    try {
      const documentsById = new Map(
        this.#searchIndex.snapshot().map((document) => [document.id, document]),
      );
      return (
        await this.#vectorStore.search(queryVector, {
          limit: options.vectorLimit ?? Math.max(limit, 50),
          ...(options.vectorMinScore === undefined ? {} : { minScore: options.vectorMinScore }),
          ...(options.vectorFilter === undefined ? {} : { filter: options.vectorFilter }),
        })
      ).filter((hit) => {
        const document = documentsById.get(hit.item.id);
        return document ? matchesStructuredFilters(document, query) : false;
      });
    } catch {
      return [];
    }
  }
}

function vectorDegradedReason(
  query: MainlineSearchQuery,
  options: MainlineHybridSearchOptions,
  hasVectorStore: boolean,
): string {
  if (!hasVectorStore) {
    return "vector store is not configured; sparse search was used";
  }
  if (!options.queryVector && !query.text?.trim()) {
    return "query vector is unavailable for an empty text query";
  }
  return "query vector or vector results were unavailable; sparse search was used";
}

export async function embedMainlineBatch(
  embedder: MainlineBatchEmbedder,
  inputs: readonly MainlineEmbeddingInput[],
): Promise<MainlineBatchEmbeddingReport> {
  if (inputs.length === 0) {
    return { vectors: [], failures: [] };
  }

  try {
    const results = await embedder.embedBatch(inputs);
    const vectors: MainlineEmbeddingSuccess[] = [];
    const failures: MainlineEmbeddingFailure[] = [];
    const seen = new Set<string>();

    for (const result of results) {
      seen.add(result.id);
      if (isEmbeddingSuccess(result)) {
        vectors.push({
          id: result.id,
          vector: [...result.vector],
          ...(result.metadata ? { metadata: { ...result.metadata } } : {}),
        });
        continue;
      }
      failures.push({
        id: result.id,
        error: result.error,
        ...(result.metadata ? { metadata: { ...result.metadata } } : {}),
      });
    }

    for (const input of inputs) {
      if (!seen.has(input.id)) {
        failures.push({
          id: input.id,
          error: new Error("Missing embedding result"),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        });
      }
    }

    return { vectors, failures };
  } catch (error) {
    return {
      vectors: [],
      failures: inputs.map((input) => ({
        id: input.id,
        error,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      })),
    };
  }
}

export function mainlineSearchDocumentEmbeddingText(document: MainlineSearchDocument): string {
  return [
    document.title,
    document.body,
    document.path,
    document.symbol,
    ...(document.tags ?? []),
    metadataString(document, "trigger"),
    metadataString(document, "summary"),
    metadataString(document, "description"),
  ]
    .filter(Boolean)
    .join("\n");
}

function hasSparseSignal(query: MainlineSearchQuery): boolean {
  return Boolean(
    query.text?.trim() || (query.paths?.length ?? 0) > 0 || (query.symbols?.length ?? 0) > 0,
  );
}

function matchesStructuredFilters(
  document: MainlineSearchDocument,
  query: MainlineSearchQuery,
): boolean {
  if (query.kinds && !query.kinds.includes(document.kind)) {
    return false;
  }
  if (
    query.paths &&
    query.paths.length > 0 &&
    !query.paths.some((pathQuery) => matchesPath(document.path, pathQuery))
  ) {
    return false;
  }
  if (
    query.symbols &&
    query.symbols.length > 0 &&
    !query.symbols.some((symbolQuery) => matchesSymbol(document.symbol, symbolQuery))
  ) {
    return false;
  }
  return true;
}

function matchesPath(pathValue: string | undefined, pathQuery: string): boolean {
  if (!pathValue) {
    return false;
  }
  const normalizedPath = normalizeMainlinePosixPath(pathValue);
  const normalizedQuery = normalizeMainlinePosixPath(pathQuery);
  return (
    normalizedPath === normalizedQuery ||
    normalizedPath.endsWith(`/${normalizedQuery}`) ||
    normalizedPath.includes(normalizedQuery)
  );
}

function matchesSymbol(symbolValue: string | undefined, symbolQuery: string): boolean {
  if (!symbolValue) {
    return false;
  }
  return symbolValue.toLowerCase().includes(symbolQuery.toLowerCase());
}

function isEmbeddingSuccess(result: MainlineEmbeddingResult): result is MainlineEmbeddingSuccess {
  return "vector" in result;
}

function metadataString(document: MainlineSearchDocument, key: string): string {
  const value = document.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

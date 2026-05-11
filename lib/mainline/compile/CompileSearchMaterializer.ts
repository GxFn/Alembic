import type { MainlineEmbeddingPort } from "../ai/index.js";
import { uniqueStrings } from "../core/assert.js";
import type { Recipe, SourceRef } from "../knowledge/index.js";
import {
  type MainlineBatchEmbedder,
  type MainlineBatchEmbeddingReport,
  type MainlineEmbeddingFailure,
  type MainlineEmbeddingInput,
  type MainlineEmbeddingResult,
  type MainlineHybridEmbedDocumentsOptions,
  MainlineHybridSearch,
  type MainlineSearchDocument,
  type MainlineSearchIndex,
  type MainlineVectorStore,
  projectMainlineSearchDocuments,
  projectRecipeSearchDocument,
  projectSourceRefSearchDocument,
} from "../search/index.js";

export interface MainlineCompileSearchHybrid {
  embedDocuments(
    documents: readonly MainlineSearchDocument[],
    options?: MainlineHybridEmbedDocumentsOptions,
  ): Promise<MainlineBatchEmbeddingReport>;
}

export interface MainlineCompileSearchMaterializerDependencies {
  readonly searchIndex: MainlineSearchIndex;
  readonly hybridSearch?: MainlineCompileSearchHybrid;
  readonly embedder?: MainlineBatchEmbedder;
  readonly vectorStore?: MainlineVectorStore;
}

export interface MainlineCompileSearchMaterializeRequest {
  readonly recipes?: readonly Recipe[];
  readonly sourceRefs?: readonly SourceRef[];
  readonly searchDocuments?: readonly MainlineSearchDocument[];
  readonly searchDocumentIdsToRemove?: readonly string[];
}

export interface MainlineCompileSearchMaterializeResult {
  readonly upserted: number;
  readonly removed: number;
  readonly embedded: number;
  readonly embeddingFailures: MainlineEmbeddingFailure[];
  readonly searchDocuments: MainlineSearchDocument[];
  readonly removedSearchDocumentIds: string[];
}

/**
 * MainlineCompileSearchMaterializer 把编译期产物投影到 SearchIndex。
 * 中文注释：稀疏索引是硬路径；embedding 是增强路径，失败只进入 report，
 * 不能阻断冷启动或增量扫描对 SearchIndex 的刷新。
 */
export class MainlineCompileSearchMaterializer {
  readonly #searchIndex: MainlineSearchIndex;
  readonly #hybridSearch: MainlineCompileSearchHybrid | undefined;
  readonly #embedder: MainlineBatchEmbedder | undefined;
  readonly #vectorStore: MainlineVectorStore | undefined;

  constructor(dependencies: MainlineCompileSearchMaterializerDependencies) {
    this.#searchIndex = dependencies.searchIndex;
    this.#embedder = dependencies.embedder;
    this.#vectorStore = dependencies.vectorStore;
    this.#hybridSearch =
      dependencies.hybridSearch ??
      (dependencies.embedder
        ? new MainlineHybridSearch({
            searchIndex: dependencies.searchIndex,
            embedder: dependencies.embedder,
            ...(dependencies.vectorStore === undefined
              ? {}
              : { vectorStore: dependencies.vectorStore }),
          })
        : undefined);
  }

  async materialize(
    request: MainlineCompileSearchMaterializeRequest,
  ): Promise<MainlineCompileSearchMaterializeResult> {
    const removedSearchDocumentIds = uniqueStrings(request.searchDocumentIdsToRemove ?? []);
    const searchDocuments = uniqueSearchDocuments([
      ...projectMainlineSearchDocuments({
        recipes: request.recipes ?? [],
        sourceRefs: request.sourceRefs ?? [],
      }),
      ...(request.searchDocuments ?? []),
    ]);

    this.#searchIndex.remove(removedSearchDocumentIds);
    const vectorRemovalFailures = await this.#removeVectors(removedSearchDocumentIds);
    this.#searchIndex.upsert(searchDocuments);
    const embeddingReport = await this.#embedDocuments(searchDocuments);

    return {
      upserted: searchDocuments.length,
      removed: removedSearchDocumentIds.length,
      embedded: embeddingReport.vectors.length,
      embeddingFailures: [...vectorRemovalFailures, ...embeddingReport.failures],
      searchDocuments,
      removedSearchDocumentIds,
    };
  }

  async #removeVectors(documentIds: readonly string[]): Promise<MainlineEmbeddingFailure[]> {
    if (!this.#vectorStore || documentIds.length === 0) {
      return [];
    }
    try {
      await this.#vectorStore.remove(documentIds);
      return [];
    } catch (error) {
      // 中文注释：向量删除是增强路径清理；失败不影响稀疏索引删除。
      return documentIds.map((id) => ({ id, error }));
    }
  }

  async #embedDocuments(
    documents: readonly MainlineSearchDocument[],
  ): Promise<MainlineBatchEmbeddingReport> {
    if (!this.#hybridSearch || documents.length === 0) {
      return { vectors: [], failures: [] };
    }

    try {
      return await this.#hybridSearch.embedDocuments(
        documents,
        this.#embedder ? { embedder: this.#embedder } : undefined,
      );
    } catch (error) {
      // 中文注释：向量链路不能阻断 SearchIndex 刷新；异常按逐文档失败返回给编译报告。
      return {
        vectors: [],
        failures: documents.map((document) => ({
          id: document.id,
          error,
          ...(document.metadata === undefined ? {} : { metadata: document.metadata }),
        })),
      };
    }
  }
}

export class MainlineEmbeddingPortBatchEmbedder implements MainlineBatchEmbedder {
  readonly #embeddingPort: MainlineEmbeddingPort;

  constructor(embeddingPort: MainlineEmbeddingPort) {
    this.#embeddingPort = embeddingPort;
  }

  async embedBatch(
    inputs: readonly MainlineEmbeddingInput[],
  ): Promise<readonly MainlineEmbeddingResult[]> {
    if (inputs.length === 0) {
      return [];
    }
    const vectors = await this.#embeddingPort.embedBatch(inputs.map((input) => input.text));
    return inputs.map((input, index) => {
      const vector = vectors[index];
      if (Array.isArray(vector) && vector.every((entry) => typeof entry === "number")) {
        return {
          id: input.id,
          vector,
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        };
      }
      return {
        id: input.id,
        error: new Error("Missing embedding vector"),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      };
    });
  }
}

export function searchDocumentsFromRecipes(recipes: readonly Recipe[]): MainlineSearchDocument[] {
  return recipes.filter((recipe) => recipe.status === "active").map(projectRecipeSearchDocument);
}

export function searchDocumentsFromSourceRefs(
  sourceRefs: readonly SourceRef[],
): MainlineSearchDocument[] {
  return sourceRefs.map(projectSourceRefSearchDocument);
}

function uniqueSearchDocuments(
  documents: readonly MainlineSearchDocument[],
): MainlineSearchDocument[] {
  const byId = new Map<string, MainlineSearchDocument>();
  for (const document of documents) {
    byId.set(document.id, document);
  }
  return [...byId.values()];
}

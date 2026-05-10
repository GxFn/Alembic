import { uniqueStrings } from "../core/assert.js";
import type { Recipe, SourceRef } from "../knowledge/index.js";
import {
  type MainlineSearchDocument,
  type MainlineSearchIndex,
  projectMainlineSearchDocuments,
  projectRecipeSearchDocument,
  projectSourceRefSearchDocument,
} from "../search/index.js";

export interface MainlineCompileSearchMaterializerDependencies {
  readonly searchIndex: MainlineSearchIndex;
}

export interface MainlineCompileSearchMaterializeRequest {
  readonly recipes?: readonly Recipe[];
  readonly sourceRefs?: readonly SourceRef[];
  readonly searchDocumentIdsToRemove?: readonly string[];
}

export interface MainlineCompileSearchMaterializeResult {
  readonly upserted: number;
  readonly removed: number;
  readonly embedded: 0;
  readonly embeddingFailures: readonly [];
  readonly searchDocuments: MainlineSearchDocument[];
  readonly removedSearchDocumentIds: string[];
}

/**
 * MainlineCompileSearchMaterializer 把编译期产物投影到 SearchIndex。
 * 中文注释：这里复用新主线统一的 SearchProjection，保持 `recipe:` / `source-ref:`
 * 文档 id 约定；embedding 仍是后续 adapter 能力，不在核心主线里隐式引入旧向量依赖。
 */
export class MainlineCompileSearchMaterializer {
  readonly #searchIndex: MainlineSearchIndex;

  constructor(dependencies: MainlineCompileSearchMaterializerDependencies) {
    this.#searchIndex = dependencies.searchIndex;
  }

  async materialize(
    request: MainlineCompileSearchMaterializeRequest,
  ): Promise<MainlineCompileSearchMaterializeResult> {
    const removedSearchDocumentIds = uniqueStrings(request.searchDocumentIdsToRemove ?? []);
    const searchDocuments = projectMainlineSearchDocuments({
      recipes: request.recipes ?? [],
      sourceRefs: request.sourceRefs ?? [],
    });

    this.#searchIndex.remove(removedSearchDocumentIds);
    this.#searchIndex.upsert(searchDocuments);

    return {
      upserted: searchDocuments.length,
      removed: removedSearchDocumentIds.length,
      embedded: 0,
      embeddingFailures: [],
      searchDocuments,
      removedSearchDocumentIds,
    };
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

import { fuseMainlineRankedHits } from "./RrfFusion.js";
import type { MainlineSearchHit, MainlineSearchIndex, MainlineSearchQuery } from "./SearchIndex.js";
import type { MainlineVectorStore } from "./VectorStore.js";

export interface MainlineHybridSearchOptions {
  readonly sparse: MainlineSearchIndex;
  readonly vector?: MainlineVectorStore;
}

export interface MainlineHybridSearchQuery extends MainlineSearchQuery {
  readonly vector?: readonly number[];
  readonly vectorLimit?: number;
}

/**
 * HybridSearch 是向量召回的可选包裹层。
 * 当前 L3 只保证 sparse snapshot 可用；没有 vector store 时直接返回主线稀疏结果。
 */
export class MainlineHybridSearch {
  readonly #sparse: MainlineSearchIndex;
  readonly #vector: MainlineVectorStore | undefined;

  constructor(options: MainlineHybridSearchOptions) {
    this.#sparse = options.sparse;
    this.#vector = options.vector;
  }

  async search(query: MainlineHybridSearchQuery): Promise<MainlineSearchHit[]> {
    const sparseHits = this.#sparse.search(query);
    if (!this.#vector || !query.vector) {
      return sparseHits;
    }

    const vectorLimit = query.vectorLimit ?? query.limit;
    const vectorHits = await this.#vector.search(query.vector, {
      ...(vectorLimit === undefined ? {} : { limit: vectorLimit }),
    });
    const sparseById = new Map(sparseHits.map((hit) => [hit.document.id, hit]));
    const fused = fuseMainlineRankedHits([
      sparseHits.map((hit) => ({ id: hit.document.id, score: hit.score, source: "sparse" })),
      vectorHits.map((hit) => ({ id: hit.item.id, score: hit.score, source: "vector" })),
    ]);

    return fused
      .map((hit) => sparseById.get(hit.id))
      .filter((hit): hit is MainlineSearchHit => hit !== undefined)
      .slice(0, query.limit ?? 20);
  }
}

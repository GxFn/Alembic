/**
 * HybridRetriever — 统一混合检索 (RRF 融合)
 *
 * 使用 Reciprocal Rank Fusion (RRF) 融合 Dense + Sparse 搜索:
 *   score = Σ 1/(k + rank_i)
 *
 * RRF 优势:
 * - 不需要分数归一化 (不同检索器分数尺度无关)
 * - 对异常高分 (outlier) 不敏感
 * - 数学性质稳定 (有界, 单调)
 * - 已被 Elasticsearch, Weaviate, Qdrant 采用为默认融合策略
 *
 * @module service/search/HybridRetriever
 */

export class HybridRetriever {
  #vectorStore;
  #rrfK;
  #defaultAlpha;

  /**
   * @param {object} options
   * @param {import('../../infrastructure/vector/VectorStore.js').VectorStore} options.vectorStore
   * @param {number} [options.rrfK=60] - RRF 常数 (k), 值越大越平滑
   * @param {number} [options.alpha=0.5] - Dense 权重 (1-alpha = Sparse 权重)
   */
  constructor(options: any = {}) {
    this.#vectorStore = options.vectorStore || null;
    this.#rrfK = options.rrfK || 60;
    this.#defaultAlpha = options.alpha ?? 0.5;
  }

  /**
   * RRF 融合搜索
   *
   * Dense: vectorStore 向量搜索 (HNSW or brute-force)
   * Sparse: BM25 关键词搜索 (由外部传入结果)
   *
   * @param {object} params
   * @param {Array<{ id: string, score: number, [key: string]: any }>} params.denseResults - 向量搜索结果
   * @param {Array<{ id: string, score: number, [key: string]: any }>} params.sparseResults - 关键词搜索结果
   * @param {number} [params.topK=10]
   * @param {number} [params.alpha=0.5] - Dense 权重
   * @returns {Array<{ id: string, score: number, rrfScore: number, denseRank: number, sparseRank: number, data: object }>}
   */
  fuse({ denseResults = [], sparseResults = [], topK = 10, alpha = 0.5 }) {
    const k = this.#rrfK;
    const scores = new Map();

    // Dense RRF 分数
    denseResults.forEach((result, rank) => {
      const id = result.item?.id || result.id;
      if (!id) {
        return;
      }
      const existing = scores.get(id) || {
        id,
        denseRank: Infinity,
        sparseRank: Infinity,
        rrfScore: 0,
        data: result,
      };
      existing.denseRank = rank + 1;
      existing.rrfScore += alpha * (1 / (k + rank + 1));
      existing.data = result;
      scores.set(id, existing);
    });

    // Sparse RRF 分数
    sparseResults.forEach((result, rank) => {
      const id = result.id;
      if (!id) {
        return;
      }
      const existing = scores.get(id) || {
        id,
        denseRank: Infinity,
        sparseRank: Infinity,
        rrfScore: 0,
        data: result,
      };
      existing.sparseRank = rank + 1;
      existing.rrfScore += (1 - alpha) * (1 / (k + rank + 1));
      if (!existing.data || !existing.data.item) {
        existing.data = result;
      }
      scores.set(id, existing);
    });

    // 按 RRF 分数降序排列
    const fused = [...scores.values()].sort((a, b) => b.rrfScore - a.rrfScore).slice(0, topK);

    // 归一化 score 到 [0, 1] 方便下游使用
    const maxRrf = fused.length > 0 ? fused[0].rrfScore : 1;
    for (const item of fused) {
      item.score = maxRrf > 0 ? item.rrfScore / maxRrf : 0;
    }

    return fused;
  }

  /**
   * 完整搜索: 同时执行 Dense + Sparse 并融合
   *
   * @param {string} query - 查询文本
   * @param {number[]} queryVector - 查询向量
   * @param {object} [options]
   * @param {number} [options.topK=10]
   * @param {number} [options.alpha=0.5]
   * @param {object} [options.filter]
   * @param {function} [options.sparseSearchFn] - 外部 sparse 搜索函数 (query, limit) => results[]
   * @returns {Promise<Array>}
   */
  async search(query, queryVector, options: any = {}) {
    const { topK = 10, alpha = this.#defaultAlpha, filter = null, sparseSearchFn = null } = options;
    const expandedK = topK * 3; // 每路召回更多候选以提高融合质量

    // 并行执行 Dense + Sparse
    const [denseResults, sparseResults] = await Promise.all([
      queryVector?.length && this.#vectorStore
        ? this.#vectorStore.searchVector(queryVector, { topK: expandedK, filter })
        : Promise.resolve([]),
      sparseSearchFn ? Promise.resolve(sparseSearchFn(query, expandedK)) : Promise.resolve([]),
    ]);

    return this.fuse({
      denseResults,
      sparseResults,
      topK,
      alpha,
    });
  }
}

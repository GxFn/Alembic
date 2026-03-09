/**
 * BatchEmbedder — 批量 embedding, 支持背压控制
 *
 * 利用 OpenAI/Gemini 的批量 embed API:
 * - OpenAI: embed(string[]) → number[][]
 * - Gemini: batchEmbedContents → 批量请求
 *
 * 使用 p-limit 并发控制, 避免 API 限流:
 * - 每批 batchSize (默认 32) 条文本
 * - 最多 maxConcurrency (默认 2) 个批次并行
 *
 * 性能: 100 chunks × 串行 300ms = 30s → 批量 ≈ 0.6s (50× 加速)
 *
 * @module infrastructure/vector/BatchEmbedder
 */

import { createLimit } from '#shared/concurrency.js';

export class BatchEmbedder {
  #aiProvider;
  #batchSize;
  #maxConcurrency;

  /** @param aiProvider AI Provider (需实现 embed(text|string[]) 方法) */
  constructor(
    aiProvider: { embed: (text: string | string[]) => Promise<number[] | number[][]> },
    options: { batchSize?: number; maxConcurrency?: number } = {}
  ) {
    this.#aiProvider = aiProvider;
    this.#batchSize = options.batchSize || 32;
    this.#maxConcurrency = options.maxConcurrency || 2;
  }

  /**
   * 批量 embed 文本
   *
   * @param {Array<{ id: string, content: string }>} items
   * @param [onProgress] (embedded, total) => void
   * @returns id → vector
   */
  async embedAll(
    items: Array<{ id: string; content: string }>,
    onProgress?: (embedded: number, total: number) => void
  ) {
    if (!this.#aiProvider || typeof this.#aiProvider.embed !== 'function') {
      return new Map();
    }

    const results = new Map();
    const batches = this.#chunkArray(items, this.#batchSize);
    const limit = createLimit(this.#maxConcurrency);

    // p-limit 并发控制
    const batchResults = await Promise.all(
      batches.map((batch) =>
        limit(async () => {
          const batchResult = await this.#embedBatch(batch);
          for (const [id, vector] of batchResult) {
            results.set(id, vector);
          }
          onProgress?.(results.size, items.length);
          return batchResult;
        })
      )
    );

    return results;
  }

  /**
   * embed 单个批次
   * @param {Array<{ id: string, content: string }>} items
   */
  async #embedBatch(items: Array<{ id: string; content: string }>) {
    const result = new Map();

    try {
      // 截断过长文本 (8K 字符限制)
      const texts = items.map((item) => (item.content || '').slice(0, 8000));
      const vectors = await this.#aiProvider.embed(texts);

      // embed(string[]) 返回 number[][] — OpenAiProvider 已支持
      if (Array.isArray(vectors) && Array.isArray(vectors[0])) {
        // 批量返回
        items.forEach((item, idx) => {
          if (vectors[idx]) {
            result.set(item.id, vectors[idx]);
          }
        });
      } else if (Array.isArray(vectors) && typeof vectors[0] === 'number') {
        // 单条返回 (只有一个元素或 provider 不支持批量)
        if (items.length === 1) {
          result.set(items[0].id, vectors);
        } else {
          // provider 不支持批量, 降级到串行
          for (const item of items) {
            try {
              const vec = await this.#aiProvider.embed(item.content.slice(0, 8000));
              if (Array.isArray(vec)) {
                result.set(item.id, vec);
              }
            } catch {
              /* skip failed embed */
            }
          }
        }
      }
    } catch {
      // 整批失败, 降级到逐条
      for (const item of items) {
        try {
          const vec = await this.#aiProvider.embed(item.content.slice(0, 8000));
          if (Array.isArray(vec)) {
            // 可能返回 [number[]] (批量格式包装的单条)
            const vector = Array.isArray(vec[0]) ? vec[0] : vec;
            result.set(item.id, vector);
          }
        } catch {
          /* skip */
        }
      }
    }

    return result;
  }

  /** 将数组分成固定大小的批次 */
  #chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}

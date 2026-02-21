/**
 * JsonVectorAdapter — 基于 JSON 文件的向量存储实现
 * 适用于中小规模（<10K 文档），无外部依赖
 * 支持余弦相似度搜索、混合搜索（向量 70% + 关键词 30%）
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pathGuard from '../../shared/PathGuard.js';
import { cosineSimilarity } from '../../shared/similarity.js';
import { VectorStore } from './VectorStore.js';

export class JsonVectorAdapter extends VectorStore {
  #indexPath;
  #data; // Map<id, { id, content, vector, metadata }>
  #dirty;

  constructor(projectRoot, options = {}) {
    super();
    const contextDir = options.contextDir || '.autosnippet/context/index';
    this.#indexPath = options.indexPath || join(projectRoot, contextDir, 'vector_index.json');
    this.#data = new Map();
    this.#dirty = false;
  }

  async init() {
    this.#load();
  }

  /**
   * 同步初始化 — 供 ServiceContainer 懒加载工厂使用
   * （#load 本身就是同步的 readFileSync，无需 await）
   */
  initSync() {
    this.#load();
  }

  async upsert(item) {
    if (!item?.id) {
      throw new Error('Item must have an id');
    }
    this.#data.set(item.id, {
      id: item.id,
      content: item.content || '',
      vector: item.vector || [],
      metadata: item.metadata || {},
      updatedAt: Date.now(),
    });
    this.#dirty = true;
    this.#autoSave();
  }

  async batchUpsert(items) {
    for (const item of items) {
      if (!item?.id) {
        continue;
      }
      this.#data.set(item.id, {
        id: item.id,
        content: item.content || '',
        vector: item.vector || [],
        metadata: item.metadata || {},
        updatedAt: Date.now(),
      });
    }
    this.#dirty = true;
    this.#autoSave();
  }

  async remove(id) {
    this.#data.delete(id);
    this.#dirty = true;
    this.#autoSave();
  }

  async getById(id) {
    return this.#data.get(id) || null;
  }

  /**
   * 向量相似度搜索（余弦相似度）
   */
  async searchVector(queryVector, options = {}) {
    const { topK = 10, filter = null, minScore = 0 } = options;

    if (!queryVector || queryVector.length === 0) {
      return [];
    }

    let candidates = [...this.#data.values()];

    // 应用过滤
    if (filter) {
      candidates = this.#applyFilter(candidates, filter);
    }

    // 计算余弦相似度
    const scored = candidates
      .filter((item) => item.vector && item.vector.length > 0)
      .map((item) => ({
        item,
        score: this.#cosineSimilarity(queryVector, item.vector),
      }))
      .filter((result) => result.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored;
  }

  /**
   * 混合搜索：向量 70% + 关键词 30%
   */
  async hybridSearch(queryVector, queryText, options = {}) {
    const { topK = 10, filter = null } = options;

    let candidates = [...this.#data.values()];
    if (filter) {
      candidates = this.#applyFilter(candidates, filter);
    }

    const scored = candidates
      .map((item) => {
        // 向量分数
        let vectorScore = 0;
        if (queryVector && queryVector.length > 0 && item.vector && item.vector.length > 0) {
          vectorScore = this.#cosineSimilarity(queryVector, item.vector);
        }

        // 关键词分数
        let keywordScore = 0;
        if (queryText) {
          const text = (item.content || '').toLowerCase();
          const query = queryText.toLowerCase();
          const words = query.split(/\s+/);
          const hits = words.filter((w) => text.includes(w)).length;
          keywordScore = words.length > 0 ? hits / words.length : 0;
        }

        return {
          item,
          score: vectorScore * 0.7 + keywordScore * 0.3,
          vectorScore,
          keywordScore,
        };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored;
  }

  /**
   * query() — SearchEngine / RetrievalFunnel 使用的向量搜索别名
   * 接口: query(vector, topK) → Array<{ id, similarity, metadata }>
   */
  async query(queryVector, topK = 10) {
    const results = await this.searchVector(queryVector, { topK });
    return results.map((r) => ({
      id: r.item.id,
      similarity: r.score,
      score: r.score,
      content: r.item.content,
      metadata: r.item.metadata || {},
    }));
  }

  async searchByFilter(filter) {
    return this.#applyFilter([...this.#data.values()], filter);
  }

  async listIds() {
    return [...this.#data.keys()];
  }

  async clear() {
    this.#data.clear();
    this.#dirty = true;
    this.#autoSave();
  }

  async getStats() {
    let indexSize = 0;
    try {
      if (existsSync(this.#indexPath)) {
        indexSize = statSync(this.#indexPath).size;
      }
    } catch {
      /* ignore */
    }

    return {
      count: this.#data.size,
      indexSize,
      indexPath: this.#indexPath,
      hasVectors: [...this.#data.values()].filter((d) => d.vector?.length > 0).length,
    };
  }

  // --- 私有方法 ---

  #applyFilter(items, filter) {
    return items.filter((item) => {
      const meta = item.metadata || {};
      if (filter.type && meta.type !== filter.type) {
        return false;
      }
      if (filter.category && meta.category !== filter.category) {
        return false;
      }
      if (filter.language && meta.language !== filter.language) {
        return false;
      }
      if (filter.sourcePath && !meta.sourcePath?.includes(filter.sourcePath)) {
        return false;
      }
      if (filter.module && meta.module !== filter.module) {
        return false;
      }
      if (filter.tags && Array.isArray(filter.tags)) {
        const itemTags = meta.tags || [];
        if (!filter.tags.some((t) => itemTags.includes(t))) {
          return false;
        }
      }
      if (filter.deprecated === false && meta.deprecated) {
        return false;
      }
      return true;
    });
  }

  #cosineSimilarity(a, b) {
    return cosineSimilarity(a, b);
  }

  #load() {
    try {
      if (!existsSync(this.#indexPath)) {
        return;
      }
      const raw = readFileSync(this.#indexPath, 'utf-8');
      const items = JSON.parse(raw);
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item?.id) {
            this.#data.set(item.id, item);
          }
        }
      } else if (typeof items === 'object') {
        // 兼容旧格式 { id: item }
        for (const [id, item] of Object.entries(items)) {
          this.#data.set(id, { ...item, id });
        }
      }
    } catch {
      /* silent: start empty */
    }
  }

  #autoSave() {
    if (!this.#dirty) {
      return;
    }
    try {
      const dir = dirname(this.#indexPath);
      pathGuard.assertProjectWriteSafe(dir);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const items = [...this.#data.values()];
      writeFileSync(this.#indexPath, JSON.stringify(items, null, 2));
      this.#dirty = false;
    } catch {
      /* silent */
    }
  }
}

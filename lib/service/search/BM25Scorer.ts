/**
 * BM25Scorer — BM25 全文检索评分器
 *
 * 从 SearchEngine.ts 提取的独立模块。
 * 支持增量 add/remove/update、tombstone 压缩、O(1) ID 查找。
 *
 * @module BM25Scorer
 */

import type { BM25Document, BM25SearchResult } from './SearchTypes.js';
import { BM25_B, BM25_K1, tokenize } from './tokenizer.js';

/**
 * BM25 评分器
 */
export class BM25Scorer {
  _idIndex: Map<string, number>;
  _totalLength: number;
  avgLength: number;
  docFreq: Record<string, number>;
  documents: (BM25Document | null)[];
  totalDocs: number;
  constructor() {
    this.documents = []; // [{id, tokens, tokenFreq, length, meta}]
    this.avgLength = 0;
    this.docFreq = {}; // token → 出现在多少文档中
    this.totalDocs = 0;
    this._totalLength = 0; // 累计文档长度，避免 O(N) 重算
    this._idIndex = new Map(); // id → array index (O(1) 查找)
  }

  /**
   * 添加文档到索引
   */
  addDocument(id: string, text: string, meta: Record<string, unknown> = {}) {
    // 如果 id 已存在，先移除旧版本（确保幂等）
    if (this._idIndex.has(id)) {
      this.removeDocument(id);
    }
    const tokens = tokenize(text);
    // 预计算 token frequency map — 避免 search 时 O(T) filter 计算 TF
    const tokenFreq: Record<string, number> = {};
    for (const t of tokens) {
      tokenFreq[t] = (tokenFreq[t] || 0) + 1;
    }
    const idx = this.documents.length;
    this.documents.push({ id, tokens, tokenFreq, length: tokens.length, meta });
    this._idIndex.set(id, idx);
    for (const token of new Set(tokens)) {
      this.docFreq[token] = (this.docFreq[token] || 0) + 1;
    }
    this.totalDocs = this._idIndex.size;
    this._totalLength += tokens.length;
    this.avgLength = this.totalDocs > 0 ? this._totalLength / this.totalDocs : 0;
  }

  /**
   * 移除文档（增量删除）
   * 采用标记删除 + 懒清理策略：将文档标记为 null，当空洞率 > 30% 时自动压缩
   * @returns {boolean} 是否成功移除
   */
  removeDocument(id: string) {
    const idx = this._idIndex.get(id);
    if (idx === undefined) {
      return false;
    }

    const doc = this.documents[idx];
    if (!doc) {
      return false; // 已被标记删除
    }

    // 递减 docFreq
    for (const token of new Set(doc.tokens) as Set<string>) {
      if (this.docFreq[token]) {
        this.docFreq[token]--;
        if (this.docFreq[token] <= 0) {
          delete this.docFreq[token];
        }
      }
    }

    this._totalLength -= doc.length;
    this.documents[idx] = null; // 标记删除（tombstone）
    this._idIndex.delete(id);
    this.totalDocs = this._idIndex.size;
    this.avgLength = this.totalDocs > 0 ? this._totalLength / this.totalDocs : 0;

    // 空洞率 > 30% 时压缩数组
    const nullCount = this.documents.length - this.totalDocs;
    if (this.documents.length > 100 && nullCount / this.documents.length > 0.3) {
      this._compact();
    }

    return true;
  }

  /**
   * 更新文档（增量: remove + add）
   */
  updateDocument(id: string, text: string, meta: Record<string, unknown> = {}) {
    this.removeDocument(id);
    this.addDocument(id, text, meta);
  }

  /**
   * 检查文档是否存在
   */
  hasDocument(id: string) {
    return this._idIndex.has(id);
  }

  /**
   * 压缩 documents 数组，清除 tombstone 空洞
   */
  _compact() {
    const alive = this.documents.filter((d): d is BM25Document => d !== null);
    this.documents = alive;
    this._idIndex.clear();
    for (let i = 0; i < alive.length; i++) {
      this._idIndex.set(alive[i].id, i);
    }
  }

  /**
   * 查询文档，返回按 BM25 分数排序的结果
   */
  search(query: string, limit = 20) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }

    const scores: BM25SearchResult[] = [];

    for (const doc of this.documents) {
      if (!doc) {
        continue; // skip tombstone
      }
      let score = 0;
      const dl = doc.length;

      for (const qt of queryTokens) {
        const tf = doc.tokenFreq[qt] || 0; // O(1) 查找，替代 O(T) filter
        if (tf === 0) {
          continue;
        }

        const df = this.docFreq[qt] || 0;
        const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1);
        const tfNorm =
          (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / this.avgLength)));
        score += idf * tfNorm;
      }

      if (score > 0) {
        scores.push({ id: doc.id, score, meta: doc.meta });
      }
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, limit);
  }

  /**
   * 清空索引
   */
  clear() {
    this.documents = [];
    this.docFreq = {};
    this.totalDocs = 0;
    this.avgLength = 0;
    this._totalLength = 0;
    this._idIndex.clear();
  }
}

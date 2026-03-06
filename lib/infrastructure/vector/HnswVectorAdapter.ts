/**
 * HnswVectorAdapter — 基于 HNSW 的向量存储实现
 *
 * 实现 VectorStore 接口, 内部使用:
 * - HnswIndex: 纯 JS HNSW 近似最近邻索引
 * - ScalarQuantizer: SQ8 量化 (文档数 > threshold 时自动启用)
 * - BinaryPersistence: .asvec 二进制持久化
 *
 * 特点:
 * - O(log N) 搜索, 替代暴力 O(N)
 * - 75% 内存节省 (SQ8 量化)
 * - 异步 debounced 持久化
 * - 自动从 JSON 旧格式迁移
 *
 * @module infrastructure/vector/HnswVectorAdapter
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { cosineSimilarity } from '../../shared/similarity.js';
import { AsyncPersistence, WAL_OP } from './AsyncPersistence.js';
import { BinaryPersistence } from './BinaryPersistence.js';
import { HnswIndex, cosineDistance } from './HnswIndex.js';
import { ScalarQuantizer } from './ScalarQuantizer.js';
import { VectorStore } from './VectorStore.js';

export class HnswVectorAdapter extends VectorStore {
  /** @type {HnswIndex} */
  #index;
  /** @type {Map<string, object>} id → metadata */
  #metadata;
  /** @type {Map<string, string>} id → content */
  #contents;
  /** @type {ScalarQuantizer|null} */
  #quantizer;
  /** @type {number} 向量维度 (首次 upsert 自动检测) */
  #dimension = 0;
  /** @type {boolean} 数据是否已修改 */
  #dirty = false;
  /** @type {ReturnType<typeof setTimeout>|null} flush 定时器 */
  #flushTimer = null;
  /** @type {number} 待刷盘操作计数 */
  #pendingOps = 0;
  /** @type {boolean} 是否正在刷盘 */
  #flushing = false;
  /** @type {AsyncPersistence|null} WAL 持久化管理 */
  #wal = null;

  // ── 配置 ──
  #config;
  #indexDir;
  #indexPath; // .asvec 文件路径

  /**
   * @param {string} projectRoot
   * @param {object} [options]
   * @param {number} [options.M=16]
   * @param {number} [options.efConstruct=200]
   * @param {number} [options.efSearch=100]
   * @param {string} [options.quantize='auto'] - 'auto' | 'sq8' | 'none'
   * @param {number} [options.quantizeThreshold=3000]
   * @param {string} [options.indexDir]
   * @param {number} [options.flushIntervalMs=2000]
   * @param {number} [options.flushBatchSize=100]
   * @param {boolean} [options.walEnabled=true] - 启用 WAL 持久化
   */
  constructor(projectRoot, options: any = {}) {
    super();
    this.#config = {
      M: options.M || 16,
      efConstruct: options.efConstruct || 200,
      efSearch: options.efSearch || 100,
      quantize: options.quantize ?? 'auto',
      quantizeThreshold: options.quantizeThreshold || 3000,
      flushIntervalMs: options.flushIntervalMs || 2000,
      flushBatchSize: options.flushBatchSize || 100,
      walEnabled: options.walEnabled !== false,
    };
    this.#indexDir = options.indexDir || join(projectRoot, '.autosnippet/context/index');
    this.#indexPath = join(this.#indexDir, 'vector_index.asvec');
    this.#metadata = new Map();
    this.#contents = new Map();
    this.#quantizer = null;

    this.#index = new HnswIndex({
      M: this.#config.M,
      efConstruct: this.#config.efConstruct,
      efSearch: this.#config.efSearch,
    });
  }

  /**
   * 初始化: 加载已有索引或创建新索引
   * 自动检测 JSON 旧索引并迁移
   */
  async init() {
    // 确保目录存在
    if (!existsSync(this.#indexDir)) {
      mkdirSync(this.#indexDir, { recursive: true });
    }

    // 尝试加载二进制索引
    if (existsSync(this.#indexPath) && BinaryPersistence.isValid(this.#indexPath)) {
      try {
        const loaded = BinaryPersistence.load(this.#indexPath);
        const { indexData, quantizerData, metadata, contents, dimension } = loaded;

        // 恢复 HNSW 索引
        this.#index = HnswIndex.deserialize(indexData);
        this.#index.efSearch = this.#config.efSearch;
        this.#dimension = dimension;

        // 恢复量化器
        if (quantizerData) {
          this.#quantizer = ScalarQuantizer.deserialize(quantizerData);
          // 从 quantizer 重新编码量化向量到 HNSW 节点 (qvector 不序列化, 启动时重建)
          this.#index.setQuantizedVectors(this.#quantizer);
        }

        // 恢复 metadata 和 contents
        this.#metadata = metadata;
        this.#contents = contents;

        // 初始化 WAL + replay 崩溃前未刷盘的操作
        this.#initWal();
        const { replayed } = this.#wal?.recover() || { replayed: 0 };
        if (replayed > 0) {
          this.#dirty = true;
          await this.#persist();
        }

        return;
      } catch {
        // 损坏的文件, 忽略, 重新构建
      }
    }

    // 尝试从 JSON 迁移
    const { VectorMigration } = await import('./VectorMigration.js');
    const migrationResult = await VectorMigration.migrate(this.#indexDir, this);
    if (migrationResult === 'migrated') {
      // 迁移完成, 数据已加载到内存
      await this.#persist();
    }

    // 初始化 WAL (即使是空索引也创建, 以便后续操作写 WAL)
    this.#initWal();
  }

  /**
   * 同步初始化 (兼容 JsonVectorAdapter)
   * 注意: 同步路径无法执行 async 迁移, 但会尝试同步加载 JSON
   */
  initSync() {
    if (!existsSync(this.#indexDir)) {
      mkdirSync(this.#indexDir, { recursive: true });
    }

    // 尝试加载二进制索引
    if (existsSync(this.#indexPath) && BinaryPersistence.isValid(this.#indexPath)) {
      try {
        const loaded = BinaryPersistence.load(this.#indexPath);
        const { indexData, quantizerData, metadata, contents, dimension } = loaded;
        this.#index = HnswIndex.deserialize(indexData);
        this.#index.efSearch = this.#config.efSearch;
        this.#dimension = dimension;
        if (quantizerData) {
          this.#quantizer = ScalarQuantizer.deserialize(quantizerData);
          // 从 quantizer 重新编码量化向量到 HNSW 节点 (qvector 不序列化, 启动时重建)
          this.#index.setQuantizedVectors(this.#quantizer);
        }
        this.#metadata = metadata;
        this.#contents = contents;

        // 初始化 WAL + replay
        this.#initWal();
        const { replayed } = this.#wal?.recover() || { replayed: 0 };
        if (replayed > 0) {
          this.#dirty = true;
          // 同步 persist (WAL 已 replay 到内存, 需要落盘)
          BinaryPersistence.save(this.#indexPath, {
            index: this.#index,
            quantizer: this.#quantizer,
            metadata: this.#metadata,
            contents: this.#contents,
          });
          this.#dirty = false;
        }
        return;
      } catch {
        // 损坏或不兼容, 尝试从 JSON 迁移
      }
    }

    // 同步迁移: 读取 JSON 索引并加载到内存
    this.#syncMigrateFromJson();

    // 初始化 WAL
    this.#initWal();
  }

  /**
   * 同步从 JSON 索引迁移 (用于 initSync 路径)
   */
  #syncMigrateFromJson() {
    const jsonPath = join(this.#indexDir, 'vector_index.json');
    if (!existsSync(jsonPath)) return;

    try {
      const raw = readFileSync(jsonPath, 'utf-8');
      const items = JSON.parse(raw);
      const itemList = Array.isArray(items)
        ? items
        // @ts-expect-error TS migration: TS2698
        : Object.entries(items).map(([id, item]) => ({ ...item, id }));

      for (const item of itemList) {
        if (!item?.id) continue;
        const vector = item.vector || [];
        if (vector.length > 0 && this.#dimension === 0) {
          this.#dimension = vector.length;
        }
        this.#metadata.set(item.id, {
          ...(item.metadata || {}),
          updatedAt: Date.now(),
        });
        this.#contents.set(item.id, item.content || '');
        if (vector.length > 0) {
          this.#index.addPoint(item.id, vector);
        }
      }

      // 同步保存二进制索引
      BinaryPersistence.save(this.#indexPath, {
        index: this.#index,
        quantizer: this.#quantizer,
        metadata: this.#metadata,
        contents: this.#contents,
      });
      this.#dirty = false;

      // 重命名旧文件
      try {
        renameSync(jsonPath, `${jsonPath}.bak`);
      } catch { /* ignore */ }
    } catch {
      // JSON 解析失败, 保持空索引
    }
  }

  async upsert(item) {
    if (!item?.id) {
      throw new Error('Item must have an id');
    }

    const vector = item.vector || [];

    // 自动检测维度
    if (vector.length > 0 && this.#dimension === 0) {
      this.#dimension = vector.length;
    }

    // 存储 metadata 和 content
    this.#metadata.set(item.id, {
      ...(item.metadata || {}),
      updatedAt: Date.now(),
    });
    this.#contents.set(item.id, item.content || '');

    // 如果有向量, 插入 HNSW 索引
    if (vector.length > 0) {
      const qvector = this.#quantizer?.trained ? this.#quantizer.encode(vector) : null;
      this.#index.addPoint(item.id, vector, { qvector });
    }

    this.#dirty = true;
    this.#pendingOps++;

    // 定期检查是否需要训练量化器 (每 500 次 upsert 检查一次)
    if (this.#pendingOps % 500 === 0) {
      this.#maybeTrainQuantizer();
    }

    // WAL 追加 + 调度 flush
    if (this.#wal) {
      this.#wal.appendWal({
        t: WAL_OP.UPSERT,
        id: item.id,
        c: item.content || '',
        v: vector.length > 0 ? Array.from(vector) : [],
        m: item.metadata || {},
      });
    } else {
      this.#scheduleFlush();
    }
  }

  async batchUpsert(items) {
    const walOps = [];

    for (const item of items) {
      if (!item?.id) continue;

      const vector = item.vector || [];
      if (vector.length > 0 && this.#dimension === 0) {
        this.#dimension = vector.length;
      }

      this.#metadata.set(item.id, {
        ...(item.metadata || {}),
        updatedAt: Date.now(),
      });
      this.#contents.set(item.id, item.content || '');

      if (vector.length > 0) {
        const qvector = this.#quantizer?.trained ? this.#quantizer.encode(vector) : null;
        this.#index.addPoint(item.id, vector, { qvector });
      }

      walOps.push({
        t: WAL_OP.UPSERT,
        id: item.id,
        c: item.content || '',
        v: vector.length > 0 ? Array.from(vector) : [],
        m: item.metadata || {},
      });
    }

    this.#dirty = true;
    this.#pendingOps += items.length;

    // 检查是否需要训练/重训练量化器
    this.#maybeTrainQuantizer();

    // WAL 批量追加
    if (this.#wal) {
      for (const op of walOps) {
        this.#wal.appendWal(op);
      }
    } else {
      this.#scheduleFlush();
    }
  }

  async remove(id) {
    this.#index.removePoint(id);
    this.#metadata.delete(id);
    this.#contents.delete(id);
    this.#dirty = true;
    this.#pendingOps++;

    if (this.#wal) {
      this.#wal.appendWal({ t: WAL_OP.REMOVE, id });
    } else {
      this.#scheduleFlush();
    }
  }

  // @ts-expect-error TS migration: TS2416
  async getById(id) {
    if (!this.#metadata.has(id) && !this.#contents.has(id)) {
      return null;
    }

    const nodeIdx = this.#index.idToIndex.get(id);
    const node = nodeIdx !== undefined ? this.#index.nodes[nodeIdx] : null;

    return {
      id,
      content: this.#contents.get(id) || '',
      vector: node ? Array.from(node.vector) : [],
      metadata: this.#metadata.get(id) || {},
    };
  }

  /**
   * 向量相似度搜索 — HNSW O(log N)
   *
   * 当量化器已训练时启用 2-pass 搜索:
   * - Pass 1 (粗排): SQ8 量化距离在 HNSW 图中遍历, 获取 efSearch 个候选
   * - Pass 2 (精排): Float32 精确余弦距离对候选重排, 返回 top-K
   */
  async searchVector(queryVector, options: any = {}) {
    const { topK = 10, filter = null, minScore = 0 } = options;

    if (!queryVector || queryVector.length === 0) {
      return [];
    }

    // HNSW 搜索 (多召回一些, 后续过滤可能减少)
    const rawK = filter ? topK * 3 : topK;

    let knnResults;
    if (this.#quantizer?.trained && this.#index.size > this.#config.quantizeThreshold) {
      // 2-pass: SQ8 粗排 → Float32 精排
      const quantizedQuery = this.#quantizer.encode(queryVector);
      knnResults = this.#index.searchKnn(queryVector, rawK, {
        quantizedQuery,
        quantizer: this.#quantizer,
      });
    } else {
      // 直接 Float32 搜索
      knnResults = this.#index.searchKnn(queryVector, rawK);
    }

    // 转换为标准格式 + 过滤
    let results = knnResults
      .filter((r) => r.id) // 过滤掉已删除节点
      .map((r) => ({
        item: {
          id: r.id,
          content: this.#contents.get(r.id) || '',
          vector: this.#index.nodes[r.nodeIdx]
            ? Array.from(this.#index.nodes[r.nodeIdx].vector)
            : [],
          metadata: this.#metadata.get(r.id) || {},
        },
        score: 1 - r.dist, // 距离转相似度
      }))
      .filter((r) => r.score >= minScore);

    // 应用过滤
    if (filter) {
      results = results.filter((r) => this.#matchFilter(r.item, filter));
    }

    return results.slice(0, topK);
  }

  /**
   * 混合搜索: HNSW 向量 + 关键词, 使用 RRF (Reciprocal Rank Fusion) 融合
   *
   * score = α × 1/(k+rank_dense) + (1-α) × 1/(k+rank_sparse)
   */
  async hybridSearch(queryVector, queryText, options: any = {}) {
    const { topK = 10, filter = null, rrfK = 60, alpha = 0.5 } = options;
    const expandedK = topK * 3;

    // Dense: HNSW 向量搜索
    const vectorResults =
      queryVector && queryVector.length > 0
        ? await this.searchVector(queryVector, { topK: expandedK, filter })
        : [];

    // Sparse: 关键词搜索
    const keywordResults = this.#keywordSearch(queryText, expandedK, filter);

    // RRF 融合
    const scores = new Map();

    // Dense RRF 分数
    vectorResults.forEach((r, rank) => {
      const id = r.item.id;
      const entry = scores.get(id) || { item: r.item, rrfScore: 0 };
      entry.rrfScore += alpha * (1 / (rrfK + rank + 1));
      entry.item = r.item;
      scores.set(id, entry);
    });

    // Sparse RRF 分数
    keywordResults.forEach((r, rank) => {
      const id = r.id;
      const existing = scores.get(id);
      if (existing) {
        existing.rrfScore += (1 - alpha) * (1 / (rrfK + rank + 1));
      } else {
        scores.set(id, {
          item: {
            id,
            content: this.#contents.get(id) || '',
            vector: [],
            metadata: this.#metadata.get(id) || {},
          },
          rrfScore: (1 - alpha) * (1 / (rrfK + rank + 1)),
        });
      }
    });

    // 按 RRF 分数降序, 归一化到 [0, 1]
    const fused = [...scores.values()]
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, topK);

    const maxScore = fused.length > 0 ? fused[0].rrfScore : 1;
    return fused.map((r) => ({
      item: r.item,
      score: maxScore > 0 ? r.rrfScore / maxScore : 0,
      vectorScore: 0,
      keywordScore: 0,
    }));
  }

  /**
   * 关键词搜索 (BM25 简化版: token 匹配 + IDF 近似)
   * @param {string} queryText
   * @param {number} limit
   * @param {object|null} filter
   * @returns {Array<{ id: string, score: number }>}
   */
  #keywordSearch(queryText, limit, filter) {
    if (!queryText) return [];

    const queryLower = queryText.toLowerCase();
    const words = queryLower.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return [];

    const results = [];
    for (const [id, content] of this.#contents) {
      if (filter) {
        const item = { metadata: this.#metadata.get(id) || {} };
        if (!this.#matchFilter(item, filter)) continue;
      }

      const textLower = content.toLowerCase();
      const hits = words.filter((w) => textLower.includes(w)).length;
      const keywordScore = hits / words.length;

      if (keywordScore > 0) {
        results.push({ id, score: keywordScore });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * query() — SearchEngine / RetrievalFunnel 使用的向量搜索别名
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

  // @ts-expect-error TS migration: TS2416
  async searchByFilter(filter) {
    const results = [];
    for (const [id, meta] of this.#metadata) {
      const item = { id, content: this.#contents.get(id) || '', metadata: meta };
      if (this.#matchFilter(item, filter)) {
        results.push(item);
      }
    }
    return results;
  }

  // @ts-expect-error TS migration: TS2416
  async listIds() {
    return [...this.#metadata.keys()];
  }

  async clear() {
    this.#index = new HnswIndex({
      M: this.#config.M,
      efConstruct: this.#config.efConstruct,
      efSearch: this.#config.efSearch,
    });
    this.#metadata.clear();
    this.#contents.clear();
    this.#quantizer = null;
    this.#dimension = 0;
    this.#dirty = true;

    if (this.#wal) {
      this.#wal.appendWal({ t: WAL_OP.CLEAR });
    } else {
      this.#scheduleFlush();
    }
  }

  // @ts-expect-error TS migration: TS2416
  async getStats() {
    const stats = this.#index.getStats();
    return {
      count: this.#metadata.size,
      indexSize: 0, // 实际文件大小在 flush 后才知道
      indexPath: this.#indexPath,
      hasVectors: stats.totalNodes,
      hnswLevels: stats.levels,
      hnswEdges: stats.totalEdges,
      quantized: this.#quantizer?.trained || false,
      dimension: this.#dimension,
    };
  }

  // ── 持久化 ──

  /**
   * 初始化 WAL (Write-Ahead Log)
   */
  #initWal() {
    if (!this.#config.walEnabled) return;
    this.#wal = new AsyncPersistence({
      indexPath: this.#indexPath,
      enabled: true,
      flushIntervalMs: this.#config.flushIntervalMs,
      flushBatchSize: this.#config.flushBatchSize,
      onPersist: () => this.#persist(),
      onReplay: (op) => this.#replayOp(op),
    });
  }

  /**
   * 重放 WAL 操作 (启动时恢复崩溃前未刷盘的操作)
   * @param {object} op - WAL 操作
   */
  #replayOp(op) {
    switch (op.t) {
      case WAL_OP.UPSERT: {
        const vector = op.v || [];
        if (vector.length > 0 && this.#dimension === 0) {
          this.#dimension = vector.length;
        }
        this.#metadata.set(op.id, { ...(op.m || {}), updatedAt: Date.now() });
        this.#contents.set(op.id, op.c || '');
        if (vector.length > 0) {
          const qvector = this.#quantizer?.trained ? this.#quantizer.encode(vector) : null;
          this.#index.addPoint(op.id, vector, { qvector });
        }
        break;
      }
      case WAL_OP.REMOVE:
        this.#index.removePoint(op.id);
        this.#metadata.delete(op.id);
        this.#contents.delete(op.id);
        break;
      case WAL_OP.CLEAR:
        this.#index = new HnswIndex({
          M: this.#config.M,
          efConstruct: this.#config.efConstruct,
          efSearch: this.#config.efSearch,
        });
        this.#metadata.clear();
        this.#contents.clear();
        this.#quantizer = null;
        this.#dimension = 0;
        break;
    }
  }

  /**
   * 手动触发持久化 (测试/关闭时使用)
   */
  async flush() {
    if (this.#wal) {
      await this.#wal.flush();
    }
    if (this.#dirty) {
      await this.#persist();
    }
  }

  #scheduleFlush() {
    if (this.#flushing) return;

    // 如果积累了足够操作, 立即 flush
    if (this.#pendingOps >= this.#config.flushBatchSize) {
      this.#doFlush();
      return;
    }

    // 否则 debounced flush
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#doFlush();
    }, this.#config.flushIntervalMs);
    // unref() 使定时器不阻止 Node 进程退出
    if (this.#flushTimer?.unref) this.#flushTimer.unref();
  }

  async #doFlush() {
    if (this.#flushing || !this.#dirty) return;
    this.#flushing = true;
    this.#pendingOps = 0;
    try {
      await this.#persist();
    } catch {
      /* persist failure is non-fatal */
    } finally {
      this.#flushing = false;
    }
  }

  async #persist() {
    try {
      await BinaryPersistence.saveAsync(this.#indexPath, {
        index: this.#index,
        quantizer: this.#quantizer,
        metadata: this.#metadata,
        contents: this.#contents,
      });
      this.#dirty = false;
    } catch {
      /* 写入失败暂时忽略, 下次重试 */
    }
  }

  // ── 量化器 ──

  /**
   * 检查是否需要训练量化器, 训练后批量设置量化向量到 HNSW 节点
   */
  #maybeTrainQuantizer() {
    if (this.#config.quantize === 'none') return;
    if (this.#config.quantize === 'auto' && this.#index.size < this.#config.quantizeThreshold) {
      return;
    }

    // 已训练则跳过 (除非文档增长 50% 以上需要重训练)
    if (this.#quantizer?.trained) return;

    // 收集训练向量
    const vectors = [];
    for (const node of this.#index.nodes) {
      if (node && node.vector.length > 0) {
        vectors.push(node.vector);
      }
    }

    if (vectors.length < 100) return; // 数据太少不训练

    this.#quantizer = new ScalarQuantizer(this.#dimension);
    this.#quantizer.train(vectors);

    // 批量设置量化向量到 HNSW 节点 (用于 2-pass 搜索)
    this.#index.setQuantizedVectors(this.#quantizer);
  }

  // ── 过滤 ──

  #matchFilter(item, filter) {
    const meta = item.metadata || {};
    if (filter.type && meta.type !== filter.type) return false;
    if (filter.category && meta.category !== filter.category) return false;
    if (filter.language && meta.language !== filter.language) return false;
    if (filter.sourcePath && !meta.sourcePath?.includes(filter.sourcePath)) return false;
    if (filter.module && meta.module !== filter.module) return false;
    if (filter.tags && Array.isArray(filter.tags)) {
      const itemTags = meta.tags || [];
      if (!filter.tags.some((t) => itemTags.includes(t))) return false;
    }
    if (filter.deprecated === false && meta.deprecated) return false;
    return true;
  }

  /**
   * 销毁: 清理定时器
   */
  destroy() {
    // 清理 WAL
    if (this.#wal) {
      this.#wal.destroy();
    }
    // 清理 legacy 定时器
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    // 同步最后一次 persist
    if (this.#dirty) {
      try {
        BinaryPersistence.save(this.#indexPath, {
          index: this.#index,
          quantizer: this.#quantizer,
          metadata: this.#metadata,
          contents: this.#contents,
        });
        this.#dirty = false;
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * PersistentMemory — 持久化语义记忆 (Tier 3) — Facade
 *
 * 统一的项目级永久记忆存储，使用 SQLite 提供:
 *   - 重要性评分 (importance 1.0-10.0)
 *   - 综合检索 (recency × importance × relevance)
 *   - Extract-Update 模式固化 (ADD / UPDATE / MERGE / NOOP)
 *   - Mem0 风格冲突解决 (矛盾检测 + 自动替换)
 *   - TTL 自动过期 + 访问计数
 *   - 向量嵌入预留接口
 *   - 预算感知 toPromptSection
 *
 * 内部委托:
 *   - MemoryStore        — CRUD + SQL 基础设施
 *   - MemoryRetriever    — 三维打分检索 + Prompt 生成
 *   - MemoryConsolidator — 智能固化 + 冲突解决
 *
 * 记忆类型: fact / insight / preference
 * 来源: bootstrap / user / system
 *
 * @module PersistentMemory
 */

import { MemoryStore } from './MemoryStore.js';
import { MemoryRetriever } from './MemoryRetriever.js';
import { MemoryConsolidator } from './MemoryConsolidator.js';

export class PersistentMemory {
  /** @type {MemoryStore} */
  #store;

  /** @type {MemoryRetriever} */
  #retriever;

  /** @type {MemoryConsolidator} */
  #consolidator;

  /** @type {object|null} */
  #logger;

  /**
   * @param {import('better-sqlite3').Database} db - better-sqlite3 实例
   * @param {object} [opts]
   * @param {object}   [opts.logger]
   * @param {Function} [opts.embeddingFn]
   */
  constructor(db, opts: any = {}) {
    const { logger, embeddingFn } = typeof opts === 'object' && opts !== null ? opts : {};
    if (!db) {
      throw new Error('PersistentMemory requires a database instance');
    }
    const rawDb = typeof db?.getDb === 'function' ? db.getDb() : db;
    this.#logger = logger || null;

    // 组装子模块
    this.#store = new MemoryStore(rawDb);
    this.#retriever = new MemoryRetriever(this.#store, { embeddingFn });
    this.#consolidator = new MemoryConsolidator(this.#store, { logger: this.#logger });
  }

  // ═══════════════════════════════════════════════════════════
  // 基本 CRUD — 委托 MemoryStore
  // ═══════════════════════════════════════════════════════════

  /** 添加一条记忆 */
  add(memory) {
    return this.#store.add(memory);
  }

  /** 更新已有记忆 */
  update(id, updates) {
    return this.#store.update(id, updates);
  }

  /** 删除一条记忆 */
  delete(id) {
    return this.#store.delete(id);
  }

  /** 按 ID 获取 */
  get(id) {
    return this.#store.get(id);
  }

  // ═══════════════════════════════════════════════════════════
  // 智能固化 — 委托 MemoryConsolidator
  // ═══════════════════════════════════════════════════════════

  /** 智能固化 (ADD / UPDATE / MERGE / NOOP + 冲突解决) */
  consolidate(candidateMemories, opts) {
    return this.#consolidator.consolidate(candidateMemories, opts);
  }

  // ═══════════════════════════════════════════════════════════
  // 综合检索 — 委托 MemoryRetriever
  // ═══════════════════════════════════════════════════════════

  /** 三维打分综合检索 */
  retrieve(query, opts) {
    return this.#retriever.retrieve(query, opts);
  }

  /** 简单文本搜索 */
  search(content, opts) {
    return this.#retriever.search(content, opts);
  }

  // ═══════════════════════════════════════════════════════════
  // Prompt 生成 + 兼容层 — 委托 MemoryRetriever
  // ═══════════════════════════════════════════════════════════

  /** 预算感知 Prompt section */
  toPromptSection(opts) {
    return this.#retriever.toPromptSection(opts);
  }

  /** 兼容 Memory.load() */
  load(limit, opts) {
    return this.#retriever.load(limit, opts);
  }

  /** 兼容 Memory.append() */
  append(entry) {
    return this.#retriever.append(entry);
  }

  // ═══════════════════════════════════════════════════════════
  // 维护 + 统计 — 委托 MemoryStore
  // ═══════════════════════════════════════════════════════════

  /** 记忆总数 */
  size(opts) {
    return this.#store.size(opts);
  }

  /** 维护: 过期清理 + 容量控制 */
  compact() {
    const stats = this.#store.compact();
    this.#log(
      `Compact: ${stats.expired} expired, ${stats.forgotten} forgotten, ${stats.archived} archived, ${stats.remaining} remaining`
    );
    return stats;
  }

  /** 获取统计信息 */
  getStats() {
    return this.#store.getStats();
  }

  /** 清除所有 bootstrap 来源的记忆 */
  clearBootstrapMemories() {
    const changes = this.#store.clearBootstrapMemories();
    this.#log(`Cleared ${changes} bootstrap memories`);
    return changes;
  }

  // ═══════════════════════════════════════════════════════════
  // Legacy Migration — 委托 MemoryConsolidator
  // ═══════════════════════════════════════════════════════════

  /** 从旧版 Memory.js JSONL 文件迁移 */
  async migrateFromLegacy(projectRoot) {
    return this.#consolidator.migrateFromLegacy(projectRoot);
  }

  // ═══════════════════════════════════════════════════════════
  // 向量嵌入接口 — 委托 MemoryRetriever
  // ═══════════════════════════════════════════════════════════

  setEmbeddingFunction(fn) {
    this.#retriever.setEmbeddingFunction(fn);
  }

  getEmbeddingFunction() {
    return this.#retriever.getEmbeddingFunction();
  }

  computeEmbeddingRelevance(query, content) {
    return this.#retriever.computeEmbeddingRelevance(query, content);
  }

  // ═══════════════════════════════════════════════════════════
  // Private
  // ═══════════════════════════════════════════════════════════

  #log(msg) {
    const formatted = `[PersistentMemory] ${msg}`;
    if (this.#logger?.info) {
      this.#logger.info(formatted);
    }
  }
}

// ── 向后兼容 ──
export { PersistentMemory as ProjectSemanticMemory };
export default PersistentMemory;

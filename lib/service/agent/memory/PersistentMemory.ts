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

import type {
  CandidateMemory,
  ConsolidateOptions,
  ConsolidateStats,
} from './MemoryConsolidator.js';
import { MemoryConsolidator } from './MemoryConsolidator.js';
import type {
  AppendEntry,
  EmbeddingFn,
  LoadOptions,
  PromptSectionOptions,
  RetrieveOptions,
  ScoredMemory,
} from './MemoryRetriever.js';
import { MemoryRetriever } from './MemoryRetriever.js';
import type {
  DeserializedMemory,
  MemoryInput,
  MemoryUpdates,
  SqliteDatabase,
} from './MemoryStore.js';
import { MemoryStore } from './MemoryStore.js';

/** PersistentMemory 构造选项 */
export interface PersistentMemoryOptions {
  logger?: MemoryLogger | null;
  embeddingFn?: EmbeddingFn;
}

/** Logger 接口 */
interface MemoryLogger {
  info(msg: string): void;
  warn?(msg: string): void;
  debug?(msg: string): void;
}

/** 数据库包装器 (getDb 模式) */
interface DbWrapper {
  getDb(): SqliteDatabase;
}

export class PersistentMemory {
  /** @type {MemoryStore} */
  #store: MemoryStore;

  /** @type {MemoryRetriever} */
  #retriever: MemoryRetriever;

  /** @type {MemoryConsolidator} */
  #consolidator: MemoryConsolidator;

  /** @type {MemoryLogger|null} */
  #logger: MemoryLogger | null;

  /**
   * @param {import('better-sqlite3').Database} db - better-sqlite3 实例
   * @param {object} [opts]
   * @param {object}   [opts.logger]
   * @param {Function} [opts.embeddingFn]
   */
  constructor(db: SqliteDatabase | DbWrapper, opts: PersistentMemoryOptions = {}) {
    const { logger, embeddingFn } =
      typeof opts === 'object' && opts !== null ? opts : ({} as PersistentMemoryOptions);
    if (!db) {
      throw new Error('PersistentMemory requires a database instance');
    }
    const rawDb =
      typeof (db as DbWrapper)?.getDb === 'function'
        ? (db as DbWrapper).getDb()
        : (db as SqliteDatabase);
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
  add(memory: MemoryInput) {
    return this.#store.add(memory);
  }

  /** 更新已有记忆 */
  update(id: string, updates: MemoryUpdates) {
    return this.#store.update(id, updates);
  }

  /** 删除一条记忆 */
  delete(id: string) {
    return this.#store.delete(id);
  }

  /** 按 ID 获取 */
  get(id: string): DeserializedMemory | null {
    return this.#store.get(id);
  }

  // ═══════════════════════════════════════════════════════════
  // 智能固化 — 委托 MemoryConsolidator
  // ═══════════════════════════════════════════════════════════

  /** 智能固化 (ADD / UPDATE / MERGE / NOOP + 冲突解决) */
  consolidate(candidateMemories: CandidateMemory[], opts?: ConsolidateOptions): ConsolidateStats {
    return this.#consolidator.consolidate(candidateMemories, opts);
  }

  // ═══════════════════════════════════════════════════════════
  // 综合检索 — 委托 MemoryRetriever
  // ═══════════════════════════════════════════════════════════

  /** 三维打分综合检索 (含向量相关性) */
  async retrieve(query: string, opts?: RetrieveOptions): Promise<ScoredMemory[]> {
    return this.#retriever.retrieve(query, opts);
  }

  /** 简单文本搜索 */
  search(content: string, opts?: { limit?: number }): DeserializedMemory[] {
    return this.#retriever.search(content, opts);
  }

  // ═══════════════════════════════════════════════════════════
  // Prompt 生成 + 兼容层 — 委托 MemoryRetriever
  // ═══════════════════════════════════════════════════════════

  /** 预算感知 Prompt section */
  async toPromptSection(opts?: PromptSectionOptions): Promise<string> {
    return this.#retriever.toPromptSection(opts);
  }

  /** 兼容 Memory.load() */
  load(limit: number, opts?: LoadOptions) {
    return this.#retriever.load(limit, opts);
  }

  /** 兼容 Memory.append() */
  append(entry: AppendEntry) {
    return this.#retriever.append(entry);
  }

  // ═══════════════════════════════════════════════════════════
  // 维护 + 统计 — 委托 MemoryStore
  // ═══════════════════════════════════════════════════════════

  /** 记忆总数 */
  size(opts?: { source?: string }) {
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
  async migrateFromLegacy(projectRoot: string) {
    return this.#consolidator.migrateFromLegacy(projectRoot);
  }

  // ═══════════════════════════════════════════════════════════
  // 向量嵌入接口 — 委托 MemoryRetriever
  // ═══════════════════════════════════════════════════════════

  /** 设置向量嵌入函数 */
  setEmbeddingFunction(fn: EmbeddingFn | null) {
    this.#retriever.setEmbeddingFunction(fn);
  }

  /** 获取当前嵌入函数 */
  getEmbeddingFunction() {
    return this.#retriever.getEmbeddingFunction();
  }

  /**
   * 为所有缺少 embedding 的记忆批量生成向量嵌入
   * @param batchSize 每批数量
   * @returns 成功嵌入的记忆数
   */
  async embedAllMemories(batchSize = 20): Promise<number> {
    const count = await this.#retriever.embedAllMemories(batchSize);
    if (count > 0) {
      this.#log(`Embedded ${count} memories`);
    }
    return count;
  }

  /**
   * 计算语义相关性 (异步，使用向量余弦相似度)
   * @param query 查询文本
   * @param content 记忆内容
   * @returns 相似度分数 或 null
   */
  async computeEmbeddingRelevance(query: string, content: string): Promise<number | null> {
    return this.#retriever.computeEmbeddingRelevance(query, content);
  }

  // ═══════════════════════════════════════════════════════════
  // Private
  // ═══════════════════════════════════════════════════════════

  #log(msg: string) {
    const formatted = `[PersistentMemory] ${msg}`;
    if (this.#logger?.info) {
      this.#logger.info(formatted);
    }
  }
}

// ── 向后兼容 ──
export { PersistentMemory as ProjectSemanticMemory };
export default PersistentMemory;

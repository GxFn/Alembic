/**
 * MemoryStore — 持久化记忆 SQLite 存储层（Drizzle 类型安全版）
 *
 * 从 PersistentMemory.js 提取的 CRUD + SQL 基础设施。
 * 负责:
 *   - 基本 CRUD: add, update, delete, get
 *   - 批量查询: getAllActive, size, getStats
 *   - 访问计数: touchAccess
 *   - 容量控制: enforceCapacity
 *   - 维护: compact
 *   - 统计: getStats, clearBootstrapMemories
 *
 * 设计原则:
 *   - 大部分操作通过 Drizzle 类型安全 API
 *   - update() 使用 Drizzle 类型安全 partial update
 *   - embedding 已迁移至 MemoryEmbeddingStore (JSON sidecar)
 *   - 数据序列化/反序列化统一在此层处理
 *
 * @module MemoryStore
 */

import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { and, asc, avg, count, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { DrizzleDB } from '#infra/database/drizzle/index.js';
import * as schema from '#infra/database/drizzle/schema.js';
import { semanticMemories } from '#infra/database/drizzle/schema.js';
import { jaccardSimilarity, tokenizeForSimilarity } from '#shared/similarity.js';

// ─── 类型定义 ──────────────────────────────────────────

/** better-sqlite3 Database 结构接口 */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
}

/** better-sqlite3 Statement 结构接口 */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** Drizzle row type */
type DrizzleMemoryRow = typeof semanticMemories.$inferSelect;

/** 数据库行 (raw row from SQLite — 保持向后兼容) */
export interface MemoryRow {
  id: string;
  type: string;
  content: string;
  source: string;
  importance: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  related_entities: string;
  related_memories: string;
  source_dimension: string | null;
  source_evidence: string | null;
  bootstrap_session: string | null;
  tags: string;
  /** findSimilar 附加字段 */
  similarity?: number;
  related_memories_raw?: string;
}

/** 反序列化后的记忆对象 */
export interface DeserializedMemory {
  id: string;
  type: string;
  content: string;
  source: string;
  importance: number;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  relatedEntities: string[];
  relatedMemories: string[];
  sourceDimension: string | null;
  sourceEvidence: string | null;
  bootstrapSession: string | null;
  tags: string[];
}

/** 添加记忆时的输入 */
export interface MemoryInput {
  type?: string;
  content: string;
  source?: string;
  importance?: number;
  ttlDays?: number | null;
  relatedEntities?: string[];
  sourceDimension?: string | null;
  sourceEvidence?: string | null;
  bootstrapSession?: string | null;
  tags?: string[];
}

/** 更新记忆时的字段 */
export interface MemoryUpdates {
  content?: string;
  importance?: number;
  accessCount?: number;
  relatedEntities?: string[];
  relatedMemories?: string[];
  tags?: string[];
}

// ─── 常量 ──────────────────────────────────────────────

/** 最大记忆条数 (防止无限膨胀) */
const MAX_MEMORIES = 500;

/** 自然遗忘阈值 */
const ARCHIVE_DAYS = 30;
const FORGET_DAYS = 90;

export class MemoryStore {
  #db: SqliteDatabase;
  #drizzle: DrizzleDB;

  /** @param db better-sqlite3 实例 (raw) */
  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#drizzle = drizzle(db as unknown as Database, { schema });
    this.#ensureTable();
  }

  /** 获取原始 db 引用 (for transaction) */
  get db() {
    return this.#db;
  }

  /** 确保表存在 (兼容 :memory: 测试 DB) */
  #ensureTable() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_memories (
        id                TEXT PRIMARY KEY,
        type              TEXT NOT NULL DEFAULT 'fact',
        content           TEXT NOT NULL DEFAULT '',
        source            TEXT NOT NULL DEFAULT 'bootstrap',
        importance        REAL NOT NULL DEFAULT 5.0,
        access_count      INTEGER NOT NULL DEFAULT 0,
        last_accessed_at  TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        expires_at        TEXT,
        related_entities  TEXT DEFAULT '[]',
        related_memories  TEXT DEFAULT '[]',
        source_dimension  TEXT,
        source_evidence   TEXT,
        bootstrap_session TEXT,
        tags              TEXT DEFAULT '[]'
      )
    `);
  }

  // ═══════════════════════════════════════════════════════════
  // 基本 CRUD
  // ═══════════════════════════════════════════════════════════

  /**
   * 添加一条记忆
   * @returns }
   */
  add(memory: MemoryInput) {
    const id = `smem_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
    const now = new Date().toISOString();
    const content = (memory.content || '').trim().substring(0, 500);
    const importance = Math.max(1, Math.min(10, memory.importance || 5));
    const expiresAt = memory.ttlDays
      ? new Date(Date.now() + memory.ttlDays * 86400_000).toISOString()
      : null;

    this.#drizzle
      .insert(semanticMemories)
      .values({
        id,
        type: memory.type || 'fact',
        content,
        source: memory.source || 'bootstrap',
        importance,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        relatedEntities: JSON.stringify(memory.relatedEntities || []),
        relatedMemories: JSON.stringify([]),
        sourceDimension: memory.sourceDimension || null,
        sourceEvidence: memory.sourceEvidence || null,
        bootstrapSession: memory.bootstrapSession || null,
        tags: JSON.stringify(memory.tags || []),
      })
      .run();

    return { id, action: 'ADD' };
  }

  /**
   * 更新已有记忆
   */
  update(id: string, updates: MemoryUpdates) {
    const existing = this.#drizzle
      .select({ id: semanticMemories.id })
      .from(semanticMemories)
      .where(eq(semanticMemories.id, id))
      .get();

    if (!existing) {
      return false;
    }

    const now = new Date().toISOString();
    const setFields: Partial<typeof semanticMemories.$inferInsert> = {};

    if (updates.content !== undefined) {
      setFields.content = updates.content.substring(0, 500);
    }
    if (updates.importance !== undefined) {
      setFields.importance = Math.max(1, Math.min(10, updates.importance));
    }
    if (updates.accessCount !== undefined) {
      setFields.accessCount = updates.accessCount;
    }
    if (updates.relatedEntities !== undefined) {
      setFields.relatedEntities = JSON.stringify(updates.relatedEntities);
    }
    if (updates.relatedMemories !== undefined) {
      setFields.relatedMemories = JSON.stringify(updates.relatedMemories);
    }
    if (updates.tags !== undefined) {
      setFields.tags = JSON.stringify(updates.tags);
    }

    if (Object.keys(setFields).length === 0) {
      return false;
    }

    setFields.updatedAt = now;

    this.#drizzle.update(semanticMemories).set(setFields).where(eq(semanticMemories.id, id)).run();
    return true;
  }

  /** 删除一条记忆 */
  delete(id: string) {
    const result = this.#drizzle.delete(semanticMemories).where(eq(semanticMemories.id, id)).run();
    return (result.changes ?? 0) > 0;
  }

  /** 按 ID 获取 */
  get(id: string): DeserializedMemory | null {
    const row = this.#drizzle
      .select()
      .from(semanticMemories)
      .where(eq(semanticMemories.id, id))
      .get();
    return row ? MemoryStore.deserialize(MemoryStore.#toRow(row)) : null;
  }

  // ═══════════════════════════════════════════════════════════
  // 批量查询
  // ═══════════════════════════════════════════════════════════

  /**
   * 获取所有活跃记忆 (未过期)
   * @returns raw rows
   */
  getAllActive({ source, type }: { source?: string; type?: string } = {}): MemoryRow[] {
    const now = new Date().toISOString();
    const notExpired = or(
      isNull(semanticMemories.expiresAt),
      sql`${semanticMemories.expiresAt} > ${now}`
    );

    const conditions = [notExpired];
    if (source) {
      conditions.push(eq(semanticMemories.source, source));
    }
    if (type) {
      conditions.push(eq(semanticMemories.type, type));
    }

    const rows = this.#drizzle
      .select()
      .from(semanticMemories)
      .where(and(...conditions))
      .orderBy(desc(semanticMemories.updatedAt))
      .all();

    return rows.map(MemoryStore.#toRow);
  }

  /** 获取候选记忆 (用于相似度搜索) */
  getCandidates(type: string | null): MemoryRow[] {
    const now = new Date().toISOString();
    const notExpired = or(
      isNull(semanticMemories.expiresAt),
      sql`${semanticMemories.expiresAt} > ${now}`
    );

    const conditions = [notExpired];
    if (type) {
      conditions.push(eq(semanticMemories.type, type));
    }

    const rows = this.#drizzle
      .select()
      .from(semanticMemories)
      .where(and(...conditions))
      .orderBy(desc(semanticMemories.updatedAt))
      .limit(50)
      .all();

    return rows.map(MemoryStore.#toRow);
  }

  /** 更新访问计数 */
  touchAccess(id: string) {
    try {
      this.#drizzle
        .update(semanticMemories)
        .set({
          accessCount: sql`${semanticMemories.accessCount} + 1`,
          lastAccessedAt: new Date().toISOString(),
        })
        .where(eq(semanticMemories.id, id))
        .run();
    } catch {
      /* non-critical */
    }
  }

  /** 记忆总数 */
  size({ source }: { source?: string } = {}) {
    const condition = source ? eq(semanticMemories.source, source) : undefined;
    const [row] = this.#drizzle
      .select({ cnt: count() })
      .from(semanticMemories)
      .where(condition)
      .all();
    return row?.cnt ?? 0;
  }

  // ═══════════════════════════════════════════════════════════
  // 维护
  // ═══════════════════════════════════════════════════════════

  /**
   * 执行维护: 清理过期记忆 + 容量控制
   * @returns }
   */
  compact() {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const stats = { expired: 0, forgotten: 0, archived: 0, remaining: 0 };

    this.#drizzle.transaction((tx) => {
      // 清除已过期
      const expiredResult = tx
        .delete(semanticMemories)
        .where(
          and(sql`${semanticMemories.expiresAt} IS NOT NULL`, lt(semanticMemories.expiresAt, now))
        )
        .run();
      stats.expired = expiredResult.changes ?? 0;

      // 遗忘：长期未访问且不重要的
      const forgetThreshold = new Date(nowMs - FORGET_DAYS * 86400_000).toISOString();
      const forgottenResult = tx
        .delete(semanticMemories)
        .where(
          and(
            lt(semanticMemories.lastAccessedAt, forgetThreshold),
            lt(semanticMemories.importance, 7)
          )
        )
        .run();
      stats.forgotten = forgottenResult.changes ?? 0;

      // 归档：降低重要性
      const archiveThreshold = new Date(nowMs - ARCHIVE_DAYS * 86400_000).toISOString();
      const archiveResult = tx
        .update(semanticMemories)
        .set({
          importance: sql`MAX(1, ${semanticMemories.importance} - 1)`,
        })
        .where(
          and(
            lt(semanticMemories.lastAccessedAt, archiveThreshold),
            lt(semanticMemories.importance, 3)
          )
        )
        .run();
      stats.archived = archiveResult.changes ?? 0;

      const [remainRow] = tx.select({ cnt: count() }).from(semanticMemories).all();
      stats.remaining = remainRow?.cnt ?? 0;
    });

    return stats;
  }

  /** 容量控制 */
  enforceCapacity() {
    const [row] = this.#drizzle.select({ cnt: count() }).from(semanticMemories).all();
    const total = row?.cnt ?? 0;
    if (total <= MAX_MEMORIES) {
      return;
    }

    const excess = total - MAX_MEMORIES;
    this.#drizzle
      .delete(semanticMemories)
      .where(
        sql`${semanticMemories.id} IN (
          SELECT ${semanticMemories.id} FROM ${semanticMemories}
          ORDER BY ${semanticMemories.importance} ASC, ${semanticMemories.accessCount} ASC, ${semanticMemories.updatedAt} ASC
          LIMIT ${excess}
        )`
      )
      .run();
  }

  /** 获取统计信息 */
  getStats() {
    const [totalRow] = this.#drizzle.select({ cnt: count() }).from(semanticMemories).all();
    const total = totalRow?.cnt ?? 0;

    const byType = this.#drizzle
      .select({
        type: semanticMemories.type,
        cnt: count(),
      })
      .from(semanticMemories)
      .groupBy(semanticMemories.type)
      .all();

    const bySource = this.#drizzle
      .select({
        source: semanticMemories.source,
        cnt: count(),
      })
      .from(semanticMemories)
      .groupBy(semanticMemories.source)
      .all();

    const [avgRow] = this.#drizzle
      .select({
        avg: avg(semanticMemories.importance),
      })
      .from(semanticMemories)
      .all();
    const avgImportance = avgRow?.avg ? Number(avgRow.avg) : 0;

    return {
      total,
      byType: Object.fromEntries(byType.map((r) => [r.type, r.cnt])),
      bySource: Object.fromEntries(bySource.map((r) => [r.source, r.cnt])),
      avgImportance: Math.round(avgImportance * 10) / 10,
    };
  }

  /** 清除所有 bootstrap 来源的记忆 */
  clearBootstrapMemories() {
    const result = this.#drizzle
      .delete(semanticMemories)
      .where(eq(semanticMemories.source, 'bootstrap'))
      .run();
    return result.changes ?? 0;
  }

  // ═══════════════════════════════════════════════════════════
  // 相似度搜索
  // ═══════════════════════════════════════════════════════════

  /**
   * 查找相似记忆 (基于 token overlap)
   * @param content 搜索文本
   * @param type 过滤 type (null=全部)
   * @param limit 返回条数
   * @returns 带 similarity 和 related_memories_raw 字段的 raw rows
   */
  findSimilar(content: string, type: string | null, limit: number): MemoryRow[] {
    const candidates = this.getCandidates(type);
    const lowerContent = content.toLowerCase();
    const contentTokens = tokenizeForSimilarity(lowerContent) as Set<string>;

    const scored = candidates
      .map((row) => {
        const similarity = MemoryStore.computeSimilarity(contentTokens, lowerContent, row.content);
        return { ...row, similarity, related_memories_raw: row.related_memories };
      })
      .filter((r) => r.similarity > 0.1)
      .sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, limit);
  }

  /**
   * 计算两段文本的相似度 (Jaccard + 子串匹配)
   * @returns 0.0-1.0
   */
  static computeSimilarity(tokensA: Set<string>, lowerA: string, contentB: string): number {
    const lowerB = (contentB || '').toLowerCase();
    const tokensB = tokenizeForSimilarity(lowerB);

    if (tokensA.size === 0 && tokensB.size === 0) {
      return 1.0;
    }
    if (tokensA.size === 0 || tokensB.size === 0) {
      return 0.0;
    }

    const jaccard = jaccardSimilarity(tokensA, tokensB);
    const containsBonus = lowerA.includes(lowerB) || lowerB.includes(lowerA) ? 0.3 : 0;
    return Math.min(1.0, jaccard + containsBonus);
  }

  /** 创建 transaction wrapper */
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    return this.#db.transaction(fn);
  }

  // ═══════════════════════════════════════════════════════════
  // 序列化
  // ═══════════════════════════════════════════════════════════

  /** 反序列化数据库行为域对象 */
  static deserialize(row: MemoryRow): DeserializedMemory {
    return {
      id: row.id,
      type: row.type,
      content: row.content,
      source: row.source,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      relatedEntities: MemoryStore.safeParseJSON(row.related_entities, []),
      relatedMemories: MemoryStore.safeParseJSON(row.related_memories, []),
      sourceDimension: row.source_dimension,
      sourceEvidence: row.source_evidence,
      bootstrapSession: row.bootstrap_session,
      tags: MemoryStore.safeParseJSON(row.tags, []),
    };
  }

  static safeParseJSON<T>(str: string | null | undefined, fallback: T): T {
    try {
      return str ? JSON.parse(str) : fallback;
    } catch {
      return fallback;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Private: Drizzle → MemoryRow 映射
  // ═══════════════════════════════════════════════════════════

  /** Drizzle camelCase row → MemoryRow snake_case (保持向后兼容) */
  static #toRow(row: DrizzleMemoryRow): MemoryRow {
    return {
      id: row.id,
      type: row.type,
      content: row.content,
      source: row.source,
      importance: row.importance,
      access_count: row.accessCount,
      last_accessed_at: row.lastAccessedAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      expires_at: row.expiresAt,
      related_entities: row.relatedEntities ?? '[]',
      related_memories: row.relatedMemories ?? '[]',
      source_dimension: row.sourceDimension,
      source_evidence: row.sourceEvidence,
      bootstrap_session: row.bootstrapSession,
      tags: row.tags ?? '[]',
    };
  }
}

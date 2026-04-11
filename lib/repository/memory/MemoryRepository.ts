/**
 * MemoryRepository — Agent 语义记忆的仓储实现
 *
 * 从 MemoryStore 提取的数据操作，
 * 使用 Drizzle 类型安全 API 操作 semantic_memories 表。
 * embedding 已迁移到 JSON sidecar (MemoryEmbeddingStore)。
 */

import { and, avg, count, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import { semanticMemories } from '../../infrastructure/database/drizzle/schema.js';
import { RepositoryBase } from '../base/RepositoryBase.js';

/* ═══ 类型定义 ═══ */

export interface SemanticMemoryEntity {
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

export interface SemanticMemoryInsert {
  id: string;
  type?: string;
  content: string;
  source?: string;
  importance?: number;
  expiresAt?: string | null;
  relatedEntities?: string[];
  sourceDimension?: string | null;
  sourceEvidence?: string | null;
  bootstrapSession?: string | null;
  tags?: string[];
}

export interface SemanticMemoryUpdate {
  content?: string;
  importance?: number;
  accessCount?: number;
  relatedEntities?: string[];
  relatedMemories?: string[];
  tags?: string[];
}

export interface MemoryStats {
  total: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  avgImportance: number;
}

/* ═══ 常量 ═══ */

const MAX_MEMORIES = 500;
const ARCHIVE_DAYS = 30;
const FORGET_DAYS = 90;

/* ═══ Repository 实现 ═══ */

export class MemoryRepositoryImpl extends RepositoryBase<
  typeof semanticMemories,
  SemanticMemoryEntity
> {
  constructor(
    drizzle: ConstructorParameters<
      typeof RepositoryBase<typeof semanticMemories, SemanticMemoryEntity>
    >[0]
  ) {
    super(drizzle, semanticMemories);
  }

  /* ─── CRUD ─── */

  async findById(id: string): Promise<SemanticMemoryEntity | null> {
    const row = this.drizzle.select().from(this.table).where(eq(this.table.id, id)).limit(1).get();
    return row ? this.#mapRow(row) : null;
  }

  async create(data: SemanticMemoryInsert): Promise<SemanticMemoryEntity> {
    const now = new Date().toISOString();

    this.drizzle
      .insert(this.table)
      .values({
        id: data.id,
        type: data.type ?? 'fact',
        content: (data.content || '').trim().substring(0, 500),
        source: data.source ?? 'bootstrap',
        importance: Math.max(1, Math.min(10, data.importance ?? 5)),
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        updatedAt: now,
        expiresAt: data.expiresAt ?? null,
        relatedEntities: JSON.stringify(data.relatedEntities ?? []),
        relatedMemories: JSON.stringify([]),
        sourceDimension: data.sourceDimension ?? null,
        sourceEvidence: data.sourceEvidence ?? null,
        bootstrapSession: data.bootstrapSession ?? null,
        tags: JSON.stringify(data.tags ?? []),
      })
      .run();

    return (await this.findById(data.id))!;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.drizzle.delete(this.table).where(eq(this.table.id, id)).run();
    return result.changes > 0;
  }

  /** 动态字段更新 */
  async update(id: string, updates: SemanticMemoryUpdate): Promise<boolean> {
    const existing = await this.findById(id);
    if (!existing) {
      return false;
    }

    const now = new Date().toISOString();
    const setValues: Record<string, unknown> = { updatedAt: now };

    if (updates.content !== undefined) {
      setValues.content = updates.content.substring(0, 500);
    }
    if (updates.importance !== undefined) {
      setValues.importance = Math.max(1, Math.min(10, updates.importance));
    }
    if (updates.accessCount !== undefined) {
      setValues.accessCount = updates.accessCount;
    }
    if (updates.relatedEntities !== undefined) {
      setValues.relatedEntities = JSON.stringify(updates.relatedEntities);
    }
    if (updates.relatedMemories !== undefined) {
      setValues.relatedMemories = JSON.stringify(updates.relatedMemories);
    }
    if (updates.tags !== undefined) {
      setValues.tags = JSON.stringify(updates.tags);
    }

    this.drizzle.update(this.table).set(setValues).where(eq(this.table.id, id)).run();

    return true;
  }

  /* ─── 访问计数 ─── */

  /** 更新访问计数 */
  async touchAccess(id: string): Promise<void> {
    this.drizzle
      .update(this.table)
      .set({
        accessCount: sql`${this.table.accessCount} + 1`,
        lastAccessedAt: new Date().toISOString(),
      })
      .where(eq(this.table.id, id))
      .run();
  }

  /* ─── 批量查询 ─── */

  /** 获取所有活跃记忆 (未过期) */
  async getAllActive(
    filters: { source?: string; type?: string } = {}
  ): Promise<SemanticMemoryEntity[]> {
    const now = new Date().toISOString();
    const conditions = [or(isNull(this.table.expiresAt), sql`${this.table.expiresAt} > ${now}`)];

    if (filters.source) {
      conditions.push(eq(this.table.source, filters.source));
    }
    if (filters.type) {
      conditions.push(eq(this.table.type, filters.type));
    }

    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(and(...conditions))
      .orderBy(desc(this.table.updatedAt))
      .all();

    return rows.map((r) => this.#mapRow(r));
  }

  /** 获取候选记忆 (用于相似度搜索) */
  async getCandidates(type: string | null, limit = 50): Promise<SemanticMemoryEntity[]> {
    const now = new Date().toISOString();
    const conditions = [or(isNull(this.table.expiresAt), sql`${this.table.expiresAt} > ${now}`)];

    if (type) {
      conditions.push(eq(this.table.type, type));
    }

    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(and(...conditions))
      .orderBy(desc(this.table.updatedAt))
      .limit(limit)
      .all();

    return rows.map((r) => this.#mapRow(r));
  }

  /** 记忆总数 */
  async size(filters: { source?: string } = {}): Promise<number> {
    const condition = filters.source ? eq(this.table.source, filters.source) : undefined;
    const [row] = this.drizzle.select({ cnt: count() }).from(this.table).where(condition).all();
    return row?.cnt ?? 0;
  }

  /* ─── 维护 ─── */

  /**
   * 执行维护: 清理过期记忆 + 自然遗忘 + 重要度衰减
   */
  async compact(): Promise<{
    expired: number;
    forgotten: number;
    archived: number;
    remaining: number;
  }> {
    const stats = { expired: 0, forgotten: 0, archived: 0, remaining: 0 };
    const now = new Date().toISOString();
    const nowMs = Date.now();

    this.transaction(() => {
      // 清理过期
      const expiredResult = this.drizzle
        .delete(this.table)
        .where(and(sql`${this.table.expiresAt} IS NOT NULL`, sql`${this.table.expiresAt} < ${now}`))
        .run();
      stats.expired = expiredResult.changes;

      // 自然遗忘: 90 天未访问 + importance < 7
      const forgetThreshold = new Date(nowMs - FORGET_DAYS * 86400_000).toISOString();
      const forgottenResult = this.drizzle
        .delete(this.table)
        .where(
          and(
            sql`${this.table.lastAccessedAt} < ${forgetThreshold}`,
            sql`${this.table.importance} < 7`
          )
        )
        .run();
      stats.forgotten = forgottenResult.changes;

      // 30 天未访问 + importance < 3 → 衰减
      const archiveThreshold = new Date(nowMs - ARCHIVE_DAYS * 86400_000).toISOString();
      const archiveResult = this.drizzle
        .update(this.table)
        .set({
          importance: sql`MAX(1, ${this.table.importance} - 1)`,
        })
        .where(
          and(
            sql`${this.table.lastAccessedAt} < ${archiveThreshold}`,
            sql`${this.table.importance} < 3`
          )
        )
        .run();
      stats.archived = archiveResult.changes;

      // 剩余数量
      const [row] = this.drizzle.select({ cnt: count() }).from(this.table).all();
      stats.remaining = row?.cnt ?? 0;
    });

    return stats;
  }

  /** 容量控制 */
  async enforceCapacity(maxMemories = MAX_MEMORIES): Promise<number> {
    const currentSize = await this.size();
    if (currentSize <= maxMemories) {
      return 0;
    }

    const excess = currentSize - maxMemories;
    const result = this.drizzle
      .delete(this.table)
      .where(
        sql`${this.table.id} IN (
          SELECT ${this.table.id} FROM ${this.table}
          ORDER BY ${this.table.importance} ASC,
                   ${this.table.accessCount} ASC,
                   ${this.table.updatedAt} ASC
          LIMIT ${excess}
        )`
      )
      .run();
    return result.changes;
  }

  /* ─── 统计 ─── */

  async getStats(): Promise<MemoryStats> {
    const [totalRow] = this.drizzle.select({ cnt: count() }).from(this.table).all();
    const total = totalRow?.cnt ?? 0;

    const byTypeRows = this.drizzle
      .select({
        type: this.table.type,
        cnt: count(),
      })
      .from(this.table)
      .groupBy(this.table.type)
      .all();

    const bySourceRows = this.drizzle
      .select({
        source: this.table.source,
        cnt: count(),
      })
      .from(this.table)
      .groupBy(this.table.source)
      .all();

    const [avgRow] = this.drizzle
      .select({ avg: avg(this.table.importance) })
      .from(this.table)
      .all();
    const avgImportance = avgRow?.avg ? Math.round(Number(avgRow.avg) * 10) / 10 : 0;

    return {
      total,
      byType: Object.fromEntries(byTypeRows.map((r) => [r.type, r.cnt])),
      bySource: Object.fromEntries(bySourceRows.map((r) => [r.source, r.cnt])),
      avgImportance,
    };
  }

  /** 清除所有 bootstrap 来源的记忆 */
  async clearBootstrapMemories(): Promise<number> {
    const result = this.drizzle.delete(this.table).where(eq(this.table.source, 'bootstrap')).run();
    return result.changes;
  }

  /* ─── 内部辅助 ─── */

  #mapRow(row: typeof semanticMemories.$inferSelect): SemanticMemoryEntity {
    return {
      id: row.id,
      type: row.type,
      content: row.content,
      source: row.source,
      importance: row.importance,
      accessCount: row.accessCount,
      lastAccessedAt: row.lastAccessedAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt ?? null,
      relatedEntities: safeParseJSON(row.relatedEntities, [] as string[]),
      relatedMemories: safeParseJSON(row.relatedMemories, [] as string[]),
      sourceDimension: row.sourceDimension ?? null,
      sourceEvidence: row.sourceEvidence ?? null,
      bootstrapSession: row.bootstrapSession ?? null,
      tags: safeParseJSON(row.tags, [] as string[]),
    };
  }
}

/* ═══ 辅助函数 ═══ */

function safeParseJSON<T>(str: string | null | undefined, fallback: T): T {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch {
    return fallback;
  }
}

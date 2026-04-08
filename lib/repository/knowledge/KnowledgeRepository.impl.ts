import { and, eq, sql } from 'drizzle-orm';
import type { Logger as WinstonLogger } from 'winston';
import { inferKind, KnowledgeEntry } from '../../domain/knowledge/index.js';
import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import { getDrizzle } from '../../infrastructure/database/drizzle/index.js';
import { knowledgeEntries } from '../../infrastructure/database/drizzle/schema.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { safeJsonParse, safeJsonStringify, unixNow } from '../../shared/utils/common.js';
import { BaseRepository } from '../base/BaseRepository.js';

/** Database connection wrapper interface */
interface KnowledgeDatabaseWrapper {
  getDb(): import('better-sqlite3').Database;
}

/** Filters accepted by findWithPagination */
interface KnowledgeFilters {
  _tagLike?: string;
  _search?: string;
  lifecycle?: string;
  kind?: string;
  language?: string;
  category?: string;
  [key: string]: unknown;
}

/** Pagination options for knowledge queries */
interface KnowledgePaginationOptions {
  page?: number;
  pageSize?: number;
  orderBy?: string;
  order?: 'ASC' | 'DESC';
}

/** Stats row shape */
interface KnowledgeStatsRow {
  total: number;
  pending: number;
  active: number;
  deprecated: number;
  rules: number;
  patterns: number;
  facts: number;
}

/** Count row shape */
interface KnowledgeCountRow {
  count: number;
}

/**
 * KnowledgeRepositoryImpl — 统一知识实体仓储实现 (Drizzle ORM)
 *
 * 面向 knowledge_entries 表的 SQLite 持久化。
 * 全链路 camelCase — DB 列名 = 实体属性名。
 *
 * Drizzle 迁移策略：
 * - CRUD (create/findById/update/delete/findActiveRules) → drizzle 类型安全 API
 * - 复杂动态查询 (findWithPagination/getStats) → 保留 raw SQL→渐进迁移
 */
export class KnowledgeRepositoryImpl extends BaseRepository {
  #drizzle: DrizzleDB;

  constructor(database: KnowledgeDatabaseWrapper, drizzle?: DrizzleDB) {
    super(database, 'knowledge_entries');
    this.logger = Logger.getInstance();
    this.#drizzle = drizzle ?? getDrizzle();
  }

  /* ═══ CRUD ═══════════════════════════════════════════ */

  /**
   * 创建 KnowledgeEntry
   * ★ Drizzle 类型安全 INSERT — 列名拼写编译期检查
   */
  async create(entry: KnowledgeEntry) {
    if (!entry || !entry.isValid()) {
      throw new Error('Invalid knowledge entry: title + content required');
    }

    try {
      const row = this._entityToRow(entry);
      this.#drizzle.insert(knowledgeEntries).values(row).run();
      return this.findById(entry.id);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Error creating knowledge entry', {
        entryId: entry.id,
        error: message,
      });
      throw error;
    }
  }

  /**
   * 按标题精确查找（大小写不敏感）
   */
  async findByTitle(title: string): Promise<KnowledgeEntry | null> {
    const rows = this.#drizzle
      .select()
      .from(knowledgeEntries)
      .where(sql`lower(${knowledgeEntries.title}) = lower(${title})`)
      .limit(1)
      .all();
    if (rows.length === 0) {
      return null;
    }
    return this._rowToEntity(rows[0]);
  }

  /**
   * 更新 KnowledgeEntry（接受完整实体或部分数据）
   * ★ Drizzle 类型安全 UPDATE
   */
  async update(id: string, updates: KnowledgeEntry | Record<string, unknown>) {
    try {
      const existing = (await this.findById(id)) as KnowledgeEntry | null;
      if (!existing) {
        throw new Error(`Knowledge entry not found: ${id}`);
      }

      if (updates instanceof KnowledgeEntry) {
        const fullRow = this._entityToRow(updates);
        const { id: _id, createdAt: _ca, ...row } = fullRow;
        row.updatedAt = unixNow();
        this.#drizzle.update(knowledgeEntries).set(row).where(eq(knowledgeEntries.id, id)).run();
        return this.findById(id);
      }

      // 部分更新 — 合并到现有实体
      const merged = KnowledgeEntry.fromJSON({
        ...existing.toJSON(),
        ...updates,
        updatedAt: unixNow(),
      });
      const fullRow2 = this._entityToRow(merged);
      const { id: _id2, createdAt: _ca2, ...row } = fullRow2;
      this.#drizzle.update(knowledgeEntries).set(row).where(eq(knowledgeEntries.id, id)).run();
      return this.findById(id);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Error updating knowledge entry', {
        id,
        error: message,
      });
      throw error;
    }
  }

  /**
   * 删除
   * ★ Drizzle 类型安全 DELETE
   */
  async delete(id: string) {
    try {
      const result = this.#drizzle
        .delete(knowledgeEntries)
        .where(eq(knowledgeEntries.id, id))
        .run();
      return result.changes > 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Error deleting knowledge entry', { id, error: message });
      throw error;
    }
  }

  /* ═══ 查询 ═══════════════════════════════════════════ */

  /**
   * 分页查询
   * @override
   */
  async findWithPagination(
    filters: KnowledgeFilters = {},
    options: KnowledgePaginationOptions = {}
  ) {
    const { page = 1, pageSize = 20, orderBy = 'createdAt', order = 'DESC' } = options;
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: unknown[] = [];

    const { _tagLike, _search, lifecycle: lcFilter, ...normalFilters } = filters;

    if (lcFilter) {
      conditions.push(`lifecycle = ?`);
      params.push(lcFilter);
    }

    for (const [key, value] of Object.entries(normalFilters)) {
      if (value == null) {
        continue;
      }
      this._assertSafeColumn(key);
      conditions.push(`${key} = ?`);
      params.push(value);
    }

    if (_tagLike) {
      conditions.push(`tags LIKE ?`);
      const escaped = _tagLike.replace(/[%_\\]/g, (ch: string) => `\\${ch}`);
      params.push(`%"${escaped}"%`);
    }

    if (_search) {
      const escaped = _search.replace(/[%_\\]/g, (ch: string) => `\\${ch}`);
      const like = `%${escaped}%`;
      conditions.push(
        `(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR trigger LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')`
      );
      params.push(like, like, like, like, like);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    this._assertSafeColumn(orderBy);
    const orderClause = ` ORDER BY ${orderBy} ${order === 'ASC' ? 'ASC' : 'DESC'}`;

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) as count FROM knowledge_entries${where}`)
        .get(...params) as KnowledgeCountRow
    ).count;
    const data = this.db
      .prepare(`SELECT * FROM knowledge_entries${where}${orderClause} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset);

    return {
      data: data.map((row: unknown) => this._rowToEntity(row as Record<string, unknown>)),
      pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    };
  }

  /** 根据生命周期状态查询 */
  async findByLifecycle(lifecycle: string, pagination: KnowledgePaginationOptions = {}) {
    return this.findWithPagination({ lifecycle }, pagination);
  }

  /** 根据 kind 查询 */
  async findByKind(
    kind: string,
    options: KnowledgePaginationOptions & { lifecycle?: string } = {}
  ) {
    const { lifecycle, ...pagination } = options;
    const filters: KnowledgeFilters = { kind };
    if (lifecycle) {
      filters.lifecycle = lifecycle;
    }
    return this.findWithPagination(filters, pagination);
  }

  /**
   * 查询所有 active 的 rule 类型（Guard 消费热路径）
   * ★ Drizzle 类型安全查询
   */
  async findActiveRules() {
    try {
      const rows = this.#drizzle
        .select()
        .from(knowledgeEntries)
        .where(and(eq(knowledgeEntries.kind, 'rule'), eq(knowledgeEntries.lifecycle, 'active')))
        .all();
      return rows.map((row) => this._rowToEntity(row as Record<string, unknown>));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Error finding active rules', { error: message });
      throw error;
    }
  }

  /** 根据语言查询 */
  async findByLanguage(language: string, pagination: KnowledgePaginationOptions = {}) {
    return this.findWithPagination({ language }, pagination);
  }

  /** 根据分类查询 */
  async findByCategory(category: string, pagination: KnowledgePaginationOptions = {}) {
    return this.findWithPagination({ category }, pagination);
  }

  /** 搜索 */
  async search(keyword: string, pagination: KnowledgePaginationOptions = {}) {
    return this.findWithPagination({ _search: keyword }, pagination);
  }

  /** 获取统计信息 */
  async getStats() {
    try {
      return this.db
        .prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN lifecycle = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN lifecycle = 'staging' THEN 1 ELSE 0 END) as staging,
          SUM(CASE WHEN lifecycle = 'active' THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN lifecycle = 'evolving' THEN 1 ELSE 0 END) as evolving,
          SUM(CASE WHEN lifecycle = 'decaying' THEN 1 ELSE 0 END) as decaying,
          SUM(CASE WHEN lifecycle = 'deprecated' THEN 1 ELSE 0 END) as deprecated,
          SUM(CASE WHEN kind = 'rule' THEN 1 ELSE 0 END) as rules,
          SUM(CASE WHEN kind = 'pattern' THEN 1 ELSE 0 END) as patterns,
          SUM(CASE WHEN kind = 'fact' THEN 1 ELSE 0 END) as facts
        FROM knowledge_entries
      `)
        .get();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Error getting knowledge stats', { error: message });
      throw error;
    }
  }

  /* ═══ 行 ↔ 实体 映射 ═══════════════════════════════ */

  /** DB Row → KnowledgeEntry (camelCase 列名 = 属性名，直传) */
  _rowToEntity(row: Record<string, unknown>): KnowledgeEntry | null {
    if (!row) {
      return null;
    }

    return new KnowledgeEntry({
      ...row,
      // JSON 列需要 parse
      lifecycleHistory: safeJsonParse(row.lifecycleHistory),
      tags: safeJsonParse(row.tags),
      content: safeJsonParse(row.content),
      relations: safeJsonParse(row.relations),
      constraints: safeJsonParse(row.constraints),
      reasoning: safeJsonParse(row.reasoning),
      quality: safeJsonParse(row.quality),
      stats: safeJsonParse(row.stats),
      headers: safeJsonParse(row.headers),
      headerPaths: safeJsonParse(row.headerPaths),
      agentNotes: safeJsonParse(row.agentNotes, null),
      // SQLite INTEGER → boolean
      autoApprovable: !!row.autoApprovable,
      includeHeaders: !!row.includeHeaders,
      // Staging support
      stagingDeadline: (row.staging_deadline as number) || null,
    });
  }

  /** KnowledgeEntry → DB Row (camelCase 列名 = 属性名，直传) */
  _entityToRow(e: KnowledgeEntry) {
    const now = unixNow();
    return {
      id: e.id,
      title: e.title,
      description: e.description || '',
      lifecycle: e.lifecycle,
      lifecycleHistory: safeJsonStringify(e.lifecycleHistory || [], '[]'),
      autoApprovable: e.autoApprovable ? 1 : 0,
      language: e.language,
      category: e.category,
      kind: e.kind || inferKind(e.knowledgeType),
      knowledgeType: e.knowledgeType || 'code-pattern',
      complexity: e.complexity || 'intermediate',
      scope: e.scope || null,
      difficulty: e.difficulty || null,
      tags: safeJsonStringify(e.tags || [], '[]'),
      trigger: e.trigger || '',
      topicHint: e.topicHint || '',
      whenClause: e.whenClause || '',
      doClause: e.doClause || '',
      dontClause: e.dontClause || '',
      coreCode: e.coreCode || '',
      content: safeJsonStringify(e.content || {}),
      relations: safeJsonStringify(e.relations || {}),
      constraints: safeJsonStringify(e.constraints || {}),
      reasoning: safeJsonStringify(e.reasoning || {}),
      quality: safeJsonStringify(e.quality || {}),
      stats: safeJsonStringify(e.stats || {}),
      headers: safeJsonStringify(e.headers || [], '[]'),
      headerPaths: safeJsonStringify(e.headerPaths || [], '[]'),
      moduleName: e.moduleName || null,
      includeHeaders: e.includeHeaders ? 1 : 0,
      agentNotes: e.agentNotes ? safeJsonStringify(e.agentNotes) : null,
      aiInsight: e.aiInsight || null,
      reviewedBy: e.reviewedBy || null,
      reviewedAt: e.reviewedAt || null,
      rejectionReason: e.rejectionReason || null,
      source: e.source || 'manual',
      sourceFile: e.sourceFile || null,
      sourceCandidateId: e.sourceCandidateId || null,
      createdBy: e.createdBy || 'system',
      createdAt: e.createdAt || now,
      updatedAt: e.updatedAt || now,
      publishedAt: e.publishedAt || null,
      publishedBy: e.publishedBy || null,
      staging_deadline: e.stagingDeadline || null,
    };
  }

  /**
   * 覆写 BaseRepository 的 _mapRowToEntity
   * @override
   */
  _mapRowToEntity(row: unknown) {
    return this._rowToEntity(row as Record<string, unknown>);
  }
}

export default KnowledgeRepositoryImpl;

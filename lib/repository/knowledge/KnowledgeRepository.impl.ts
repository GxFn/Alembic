import type { Database } from 'better-sqlite3';
import { and, count, desc, eq, gt, inArray, isNotNull, like, ne, or, sql, sum } from 'drizzle-orm';
import type { Logger as WinstonLogger } from 'winston';
import { inferKind, KnowledgeEntry } from '../../domain/knowledge/index.js';
import { COUNTABLE_LIFECYCLES } from '../../domain/knowledge/Lifecycle.js';
import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import { getDrizzle } from '../../infrastructure/database/drizzle/index.js';
import { knowledgeEntries } from '../../infrastructure/database/drizzle/schema.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { safeJsonParse, safeJsonStringify, unixNow } from '../../shared/utils/common.js';

/** Database connection wrapper interface */
interface KnowledgeDatabaseWrapper {
  getDb(): Database;
}

/** Only allow safe SQL identifier characters */
const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Row returned by PRAGMA table_info */
interface PragmaColumnInfo {
  name: string;
}

/** Filters accepted by findWithPagination */
interface KnowledgeFilters {
  _tagLike?: string;
  _search?: string;
  lifecycle?: string | string[];
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
export class KnowledgeRepositoryImpl {
  /** Raw DB for complex dynamic queries (ORM limitation — used within repository layer) */
  db: Database;
  logger: WinstonLogger;
  #drizzle: DrizzleDB;
  /** Lazily-populated column whitelist for SQL-injection prevention */
  #columnWhitelist: Set<string> | null = null;

  constructor(database: KnowledgeDatabaseWrapper, drizzle?: DrizzleDB) {
    this.db = database.getDb();
    this.logger = Logger.getInstance();
    this.#drizzle = drizzle ?? getDrizzle();
  }

  /**
   * Validate column name is safe for SQL interpolation (copied from retired BaseRepository).
   * Rejects anything that doesn't match /^[a-zA-Z_]\w*$/ or is not a real column.
   */
  _assertSafeColumn(key: string) {
    if (!SAFE_IDENTIFIER_RE.test(key)) {
      throw new Error(`Invalid column name: ${key}`);
    }
    if (!this.#columnWhitelist) {
      try {
        const cols = this.db
          .prepare('PRAGMA table_info(knowledge_entries)')
          .all() as PragmaColumnInfo[];
        this.#columnWhitelist = new Set(cols.map((c) => c.name));
      } catch {
        this.#columnWhitelist = new Set();
      }
    }
    if (this.#columnWhitelist.size > 0 && !this.#columnWhitelist.has(key)) {
      throw new Error(`Unknown column "${key}" for table knowledge_entries`);
    }
  }

  /* ═══ CRUD ═══════════════════════════════════════════ */

  /**
   * 按 ID 查找
   * ★ Drizzle 类型安全 SELECT
   */
  async findById(id: string): Promise<KnowledgeEntry | null> {
    try {
      const row = this.#drizzle
        .select()
        .from(knowledgeEntries)
        .where(eq(knowledgeEntries.id, id))
        .limit(1)
        .get();
      return row ? this._rowToEntity(row as Record<string, unknown>) : null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Error finding knowledge entry by id', { id, error: message });
      throw error;
    }
  }

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
   * 更新生命周期状态
   * ★ Drizzle 类型安全 UPDATE — 供 RecipeLifecycleSupervisor / ProposalExecutor 使用
   */
  async updateLifecycle(id: string, lifecycle: string): Promise<boolean> {
    const result = this.#drizzle
      .update(knowledgeEntries)
      .set({ lifecycle, updatedAt: unixNow() })
      .where(eq(knowledgeEntries.id, id))
      .run();
    return result.changes > 0;
  }

  /**
   * 更新 stats JSON 字段
   * ★ Drizzle 类型安全 UPDATE — 供 HitRecorder / RecipeLifecycleSupervisor 使用
   */
  async updateStats(id: string, stats: Record<string, unknown>): Promise<boolean> {
    const result = this.#drizzle
      .update(knowledgeEntries)
      .set({ stats: safeJsonStringify(stats), updatedAt: unixNow() })
      .where(eq(knowledgeEntries.id, id))
      .run();
    return result.changes > 0;
  }

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
      if (Array.isArray(lcFilter)) {
        const placeholders = lcFilter.map(() => '?').join(', ');
        conditions.push(`lifecycle IN (${placeholders})`);
        params.push(...lcFilter);
      } else {
        conditions.push(`lifecycle = ?`);
        params.push(lcFilter);
      }
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

  /**
   * Guard 专用：active 的 rule + boundary-constraint
   * ★ Phase 5b: supply guard.ts _loadRuleRecipes
   */
  async findActiveGuardRecipes(): Promise<KnowledgeEntry[]> {
    const rows = this.#drizzle
      .select()
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.lifecycle, 'active'),
          or(
            eq(knowledgeEntries.kind, 'rule'),
            eq(knowledgeEntries.knowledgeType, 'boundary-constraint')
          )
        )
      )
      .all();
    return rows
      .map((row) => this._rowToEntity(row as Record<string, unknown>))
      .filter(Boolean) as KnowledgeEntry[];
  }

  /**
   * 按 source 字段查询 ID 列表
   * ★ Phase 5b: supply ai.ts mock cleanup
   */
  async findIdsBySource(source: string): Promise<string[]> {
    const rows = this.#drizzle
      .select({ id: knowledgeEntries.id })
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.source, source))
      .all();
    return rows.map((r) => r.id);
  }

  /**
   * 统计指定 lifecycle 集合中的条目数量
   * ★ Phase 5b: supply recipes.ts pre-check
   */
  async countByLifecycles(lifecycles: readonly string[]): Promise<number> {
    const rows = this.#drizzle
      .select({ cnt: count() })
      .from(knowledgeEntries)
      .where(inArray(knowledgeEntries.lifecycle, lifecycles as string[]))
      .all();
    return Number(rows[0]?.cnt ?? 0);
  }

  /**
   * 查询指定 lifecycle 集合中的所有条目（不分页）
   * ★ Phase 5c: supply Evolution domain services (ContradictionDetector, RedundancyAnalyzer, etc.)
   */
  async findAllByLifecycles(lifecycles: readonly string[]): Promise<KnowledgeEntry[]> {
    const rows = this.#drizzle
      .select()
      .from(knowledgeEntries)
      .where(inArray(knowledgeEntries.lifecycle, lifecycles as string[]))
      .all();
    return rows
      .map((row) => this._rowToEntity(row as Record<string, unknown>))
      .filter(Boolean) as KnowledgeEntry[];
  }

  /**
   * 查询指定 lifecycle + category 的条目（带 limit）
   * ★ Phase 5c: supply ConsolidationAdvisor category-filtered query
   */
  async findAllByLifecyclesAndCategory(
    lifecycles: readonly string[],
    category: string,
    limit: number
  ): Promise<KnowledgeEntry[]> {
    const rows = this.#drizzle
      .select()
      .from(knowledgeEntries)
      .where(
        and(
          inArray(knowledgeEntries.lifecycle, lifecycles as string[]),
          eq(knowledgeEntries.category, category)
        )
      )
      .limit(limit)
      .all();
    return rows
      .map((row) => this._rowToEntity(row as Record<string, unknown>))
      .filter(Boolean) as KnowledgeEntry[];
  }

  /**
   * 查询指定 lifecycle 中 trigger 匹配前缀且排除指定 category 的条目
   * ★ Phase 5c: supply ConsolidationAdvisor trigger-prefix fallback
   */
  async findByLifecyclesAndTriggerPrefix(
    lifecycles: readonly string[],
    excludeCategory: string,
    triggerPrefix: string,
    limit: number
  ): Promise<KnowledgeEntry[]> {
    const rows = this.#drizzle
      .select()
      .from(knowledgeEntries)
      .where(
        and(
          inArray(knowledgeEntries.lifecycle, lifecycles as string[]),
          ne(knowledgeEntries.category, excludeCategory),
          like(knowledgeEntries.trigger, `${triggerPrefix}%`)
        )
      )
      .limit(limit)
      .all();
    return rows
      .map((row) => this._rowToEntity(row as Record<string, unknown>))
      .filter(Boolean) as KnowledgeEntry[];
  }

  /**
   * 按 lifecycle 分组统计全部条目数量
   * ★ Phase 5c: supply RecipeLifecycleSupervisor health summary
   */
  async countGroupByLifecycle(): Promise<Record<string, number>> {
    const rows = this.#drizzle
      .select({
        lifecycle: knowledgeEntries.lifecycle,
        cnt: count(),
      })
      .from(knowledgeEntries)
      .groupBy(knowledgeEntries.lifecycle)
      .all();
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.lifecycle ?? ''] = Number(row.cnt);
    }
    return result;
  }

  /**
   * 反向查找 relations JSON 中包含指定 nodeId 的条目
   * ★ Phase 5b: supply structure.ts relation graph
   */
  async findByRelationLike(
    nodeId: string,
    excludeId: string
  ): Promise<Array<{ id: string; title: string; relations: string }>> {
    const rows = this.#drizzle
      .select({
        id: knowledgeEntries.id,
        title: knowledgeEntries.title,
        relations: knowledgeEntries.relations,
      })
      .from(knowledgeEntries)
      .where(
        and(like(knowledgeEntries.relations, `%${nodeId}%`), ne(knowledgeEntries.id, excludeId))
      )
      .all();
    return rows.map((r) => ({ id: r.id, title: r.title ?? '', relations: r.relations ?? '{}' }));
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

  /**
   * Find all entries with non-empty reasoning (for SourceRefReconciler)
   * ★ Drizzle 类型安全 SELECT — 仅返回 id + reasoning
   */
  async findAllIdAndReasoning(): Promise<Array<{ id: string; reasoning: string }>> {
    const rows = this.#drizzle
      .select({
        id: knowledgeEntries.id,
        reasoning: knowledgeEntries.reasoning,
      })
      .from(knowledgeEntries)
      .where(
        and(
          sql`${knowledgeEntries.reasoning} IS NOT NULL`,
          sql`${knowledgeEntries.reasoning} != '{}'`
        )
      )
      .all();
    return rows
      .filter((r) => r.reasoning != null)
      .map((r) => ({ id: r.id, reasoning: r.reasoning as string }));
  }

  /**
   * Find sourceFile and reasoning for a single entry (for SourceRefReconciler.applyRepairs)
   * ★ Drizzle 类型安全 SELECT — 仅返回 sourceFile + reasoning
   */
  async findSourceFileAndReasoning(
    id: string
  ): Promise<{ sourceFile: string | null; reasoning: string | null } | null> {
    const row = this.#drizzle
      .select({
        sourceFile: knowledgeEntries.sourceFile,
        reasoning: knowledgeEntries.reasoning,
      })
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.id, id))
      .limit(1)
      .get();
    if (!row) {
      return null;
    }
    return { sourceFile: row.sourceFile ?? null, reasoning: row.reasoning ?? null };
  }

  /**
   * Update reasoning JSON field directly (for SourceRefReconciler.applyRepairs)
   * ★ Drizzle 类型安全 UPDATE — 精确更新 reasoning + updatedAt
   */
  async updateReasoning(id: string, reasoning: string, updatedAt: number): Promise<boolean> {
    const result = this.#drizzle
      .update(knowledgeEntries)
      .set({ reasoning, updatedAt })
      .where(eq(knowledgeEntries.id, id))
      .run();
    return result.changes > 0;
  }

  /* ─── Panorama 域查询 (Phase 5e) ─── */

  /**
   * 获取活跃 Recipe 的元数据 (title, category, topicHint, kind)
   * 用于 DimensionAnalyzer 维度分类分析
   */
  async findRecipeMetadata(
    lifecycles: readonly string[]
  ): Promise<Array<{ title: string; category: string; topicHint: string; kind: string }>> {
    const rows = this.#drizzle
      .select({
        title: knowledgeEntries.title,
        category: knowledgeEntries.category,
        topicHint: knowledgeEntries.topicHint,
        kind: knowledgeEntries.kind,
      })
      .from(knowledgeEntries)
      .where(inArray(knowledgeEntries.lifecycle, lifecycles as string[]))
      .all();
    return rows.map((r) => ({
      title: r.title ?? '',
      category: r.category ?? '',
      topicHint: r.topicHint ?? '',
      kind: r.kind ?? '',
    }));
  }

  /**
   * 按模块相关关键词搜索 Recipe (PanoramaService.#findModuleRecipes)
   * @param lifecycles - 活跃生命周期
   * @param moduleName - 模块名
   * @param categories - 角色关联的分类列表
   * @param limit - 结果上限
   */
  async findModuleRecipes(
    lifecycles: readonly string[],
    moduleName: string,
    categories: string[],
    limit = 20
  ): Promise<Array<{ id: string; title: string; trigger: string; kind: string }>> {
    const conditions = [
      or(
        like(knowledgeEntries.title, `%${moduleName}%`),
        like(knowledgeEntries.trigger, `%${moduleName}%`),
        ...categories.map((cat) => eq(knowledgeEntries.category, cat))
      ),
    ];

    const rows = this.#drizzle
      .select({
        id: knowledgeEntries.id,
        title: knowledgeEntries.title,
        trigger: knowledgeEntries.trigger,
        kind: knowledgeEntries.kind,
      })
      .from(knowledgeEntries)
      .where(and(inArray(knowledgeEntries.lifecycle, lifecycles as string[]), ...conditions))
      .orderBy(knowledgeEntries.lifecycle)
      .limit(limit)
      .all();
    return rows.map((r) => ({
      id: r.id ?? '',
      title: r.title ?? '',
      trigger: r.trigger ?? '',
      kind: r.kind ?? '',
    }));
  }

  /**
   * 统计 COUNTABLE_LIFECYCLES 范围内的知识条目数 (PanoramaAggregator.#getProjectRecipeCount)
   */
  async countByCountableLifecycles(): Promise<number> {
    const rows = this.#drizzle
      .select({ cnt: count() })
      .from(knowledgeEntries)
      .where(inArray(knowledgeEntries.lifecycle, COUNTABLE_LIFECYCLES as unknown as string[]))
      .all();
    return Number(rows[0]?.cnt ?? 0);
  }

  /* ═══ Guard / Skills 用查询 ═══════════════════════════ */

  /**
   * Guard 规则查询 — kind='rule' OR knowledgeType='boundary-constraint' + lifecycle 过滤
   * (GuardCheckEngine._loadCustomRules)
   */
  findGuardRulesSync(lifecycles: readonly string[]): Array<{
    id: string;
    title: string;
    description: string | null;
    language: string;
    scope: string | null;
    constraints: string | null;
    lifecycle: string;
  }> {
    return this.#drizzle
      .select({
        id: knowledgeEntries.id,
        title: knowledgeEntries.title,
        description: knowledgeEntries.description,
        language: knowledgeEntries.language,
        scope: knowledgeEntries.scope,
        constraints: knowledgeEntries.constraints,
        lifecycle: knowledgeEntries.lifecycle,
      })
      .from(knowledgeEntries)
      .where(
        and(
          or(
            eq(knowledgeEntries.kind, 'rule'),
            eq(knowledgeEntries.knowledgeType, 'boundary-constraint')
          ),
          inArray(knowledgeEntries.lifecycle, lifecycles as string[])
        )
      )
      .all();
  }

  /**
   * Guard 命中次数递增 — stats.guardHits += count
   * (GuardCheckEngine._recordHits)
   */
  incrementGuardHitsSync(id: string, hits: number): void {
    this.#drizzle
      .update(knowledgeEntries)
      .set({
        stats: sql`json_set(COALESCE(${knowledgeEntries.stats}, '{}'), '$.guardHits', COALESCE(json_extract(${knowledgeEntries.stats}, '$.guardHits'), 0) + ${hits})`,
        updatedAt: unixNow(),
      })
      .where(eq(knowledgeEntries.id, id))
      .run();
  }

  /**
   * 活跃规则 + content 中的 coreCode / pattern 字段 + stats
   * (ReverseGuard.#loadActiveRules)
   */
  findActiveRulesWithContentSync(): Array<{
    id: string;
    title: string;
    coreCode: string;
    guardPattern: string;
    stats: string | null;
  }> {
    return this.#drizzle
      .select({
        id: knowledgeEntries.id,
        title: knowledgeEntries.title,
        coreCode: sql<string>`json_extract(${knowledgeEntries.content}, '$.coreCode')`.as(
          'coreCode'
        ),
        guardPattern: sql<string>`json_extract(${knowledgeEntries.content}, '$.pattern')`.as(
          'guardPattern'
        ),
        stats: knowledgeEntries.stats,
      })
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.lifecycle, 'active'), eq(knowledgeEntries.kind, 'rule')))
      .all();
  }

  /**
   * 获取单条记录的 guardHits 数
   * (ReverseGuard.#historicalGuardHits)
   */
  getGuardHitsSync(id: string): number {
    const row = this.#drizzle
      .select({
        hits: sql<number>`json_extract(${knowledgeEntries.stats}, '$.guardHits')`.as('hits'),
      })
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.id, id))
      .get();
    return Number(row?.hits ?? 0);
  }

  /**
   * 活跃规则的 id + language (CoverageAnalyzer.#loadActiveRules) — sync
   */
  findActiveRuleIdsSync(): Array<{ id: string; language: string }> {
    return this.#drizzle
      .select({
        id: knowledgeEntries.id,
        language: knowledgeEntries.language,
      })
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.lifecycle, 'active'), eq(knowledgeEntries.kind, 'rule')))
      .all();
  }

  /**
   * 活跃条目按 category 分布
   * (SkillAdvisor.#getKBDistribution)
   */
  async countGroupByCategory(): Promise<Array<{ category: string; cnt: number }>> {
    return this.#drizzle
      .select({
        category: knowledgeEntries.category,
        cnt: count(),
      })
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.lifecycle, 'active'),
          isNotNull(knowledgeEntries.category),
          ne(knowledgeEntries.category, '')
        )
      )
      .groupBy(knowledgeEntries.category)
      .orderBy(desc(count()))
      .all() as Array<{ category: string; cnt: number }>;
  }

  /**
   * 活跃条目按 language 分布
   * (SkillAdvisor.#getKBDistribution)
   */
  async countGroupByLanguage(): Promise<Array<{ language: string; cnt: number }>> {
    return this.#drizzle
      .select({
        language: knowledgeEntries.language,
        cnt: count(),
      })
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.lifecycle, 'active'),
          isNotNull(knowledgeEntries.language),
          ne(knowledgeEntries.language, '')
        )
      )
      .groupBy(knowledgeEntries.language)
      .orderBy(desc(count()))
      .all() as Array<{ language: string; cnt: number }>;
  }

  /**
   * 高使用率活跃 Recipe (adoptions + applications >= minUsage)
   * (SkillAdvisor.#getKBDistribution)
   */
  async findHotRecipesByUsage(
    minUsage: number,
    limit: number
  ): Promise<Array<{ title: string; category: string; totalUsage: number }>> {
    return this.#drizzle
      .select({
        title: knowledgeEntries.title,
        category: knowledgeEntries.category,
        totalUsage:
          sql<number>`(COALESCE(json_extract(${knowledgeEntries.stats}, '$.adoptions'), 0) + COALESCE(json_extract(${knowledgeEntries.stats}, '$.applications'), 0))`.as(
            'totalUsage'
          ),
      })
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.lifecycle, 'active'),
          sql`(COALESCE(json_extract(${knowledgeEntries.stats}, '$.adoptions'), 0) + COALESCE(json_extract(${knowledgeEntries.stats}, '$.applications'), 0)) >= ${minUsage}`
        )
      )
      .orderBy(
        desc(
          sql`(COALESCE(json_extract(${knowledgeEntries.stats}, '$.adoptions'), 0) + COALESCE(json_extract(${knowledgeEntries.stats}, '$.applications'), 0))`
        )
      )
      .limit(limit)
      .all() as Array<{ title: string; category: string; totalUsage: number }>;
  }

  /**
   * 全库生命周期统计 (total / pending / deprecated)
   * (SkillAdvisor.#getKBDistribution)
   */
  async getLifecycleCounts(): Promise<{
    total: number;
    pending: number;
    deprecated: number;
  }> {
    const row = this.#drizzle
      .select({
        total: count(),
        pending:
          sql<number>`SUM(CASE WHEN ${knowledgeEntries.lifecycle} = 'pending' THEN 1 ELSE 0 END)`.as(
            'pending'
          ),
        deprecated:
          sql<number>`SUM(CASE WHEN ${knowledgeEntries.lifecycle} = 'deprecated' THEN 1 ELSE 0 END)`.as(
            'deprecated'
          ),
      })
      .from(knowledgeEntries)
      .get();
    return {
      total: Number(row?.total ?? 0),
      pending: Number(row?.pending ?? 0),
      deprecated: Number(row?.deprecated ?? 0),
    };
  }

  /**
   * 活跃 Recipe 信号 (SignalCollector.#collectRecipeSignals)
   */
  async findActiveRecipeSignals(limit: number): Promise<
    Array<{
      id: string;
      title: string;
      knowledgeType: string;
      category: string;
      language: string;
      adoptionCount: number;
      applicationCount: number;
      qualityOverall: number;
      updatedAt: number;
    }>
  > {
    return this.#drizzle
      .select({
        id: knowledgeEntries.id,
        title: knowledgeEntries.title,
        knowledgeType: knowledgeEntries.knowledgeType,
        category: knowledgeEntries.category,
        language: knowledgeEntries.language,
        adoptionCount: sql<number>`json_extract(${knowledgeEntries.stats}, '$.adoptions')`.as(
          'adoptionCount'
        ),
        applicationCount: sql<number>`json_extract(${knowledgeEntries.stats}, '$.applications')`.as(
          'applicationCount'
        ),
        qualityOverall: sql<number>`json_extract(${knowledgeEntries.quality}, '$.overall')`.as(
          'qualityOverall'
        ),
        updatedAt: knowledgeEntries.updatedAt,
      })
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.lifecycle, 'active'))
      .orderBy(desc(knowledgeEntries.updatedAt))
      .limit(limit)
      .all() as Array<{
      id: string;
      title: string;
      knowledgeType: string;
      category: string;
      language: string;
      adoptionCount: number;
      applicationCount: number;
      qualityOverall: number;
      updatedAt: number;
    }>;
  }

  /**
   * 待审核 Candidate (SignalCollector.#collectCandidateSignals)
   */
  async findPendingCandidates(limit: number): Promise<
    Array<{
      id: string;
      source: string;
      status: string;
      language: string;
      category: string;
      title: string;
      createdAt: number;
    }>
  > {
    return this.#drizzle
      .select({
        id: knowledgeEntries.id,
        source: knowledgeEntries.source,
        status: knowledgeEntries.lifecycle,
        language: knowledgeEntries.language,
        category: knowledgeEntries.category,
        title: knowledgeEntries.title,
        createdAt: knowledgeEntries.createdAt,
      })
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.lifecycle, 'pending'))
      .orderBy(desc(knowledgeEntries.createdAt))
      .limit(limit)
      .all() as Array<{
      id: string;
      source: string;
      status: string;
      language: string;
      category: string;
      title: string;
      createdAt: number;
    }>;
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
      stagingDeadline: (row.stagingDeadline as number) || null,
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

  /* ═══════════════════════════════════════════════════════
   *  SearchEngine 用同步方法
   * ═══════════════════════════════════════════════════════ */

  /** 查询所有非 deprecated 条目（buildIndex 用） */
  findNonDeprecatedSync() {
    return this.#drizzle
      .select({
        id: knowledgeEntries.id,
        title: knowledgeEntries.title,
        description: knowledgeEntries.description,
        language: knowledgeEntries.language,
        category: knowledgeEntries.category,
        knowledgeType: knowledgeEntries.knowledgeType,
        kind: knowledgeEntries.kind,
        content: knowledgeEntries.content,
        lifecycle: knowledgeEntries.lifecycle,
        tags: knowledgeEntries.tags,
        trigger: knowledgeEntries.trigger,
        difficulty: knowledgeEntries.difficulty,
        quality: knowledgeEntries.quality,
        stats: knowledgeEntries.stats,
        updatedAt: knowledgeEntries.updatedAt,
        createdAt: knowledgeEntries.createdAt,
      })
      .from(knowledgeEntries)
      .where(ne(knowledgeEntries.lifecycle, 'deprecated'))
      .all();
  }

  /** LIKE 关键词搜索（_keywordSearch 用） */
  keywordSearchSync(pattern: string, limit: number) {
    return this.#drizzle
      .select({
        id: knowledgeEntries.id,
        title: knowledgeEntries.title,
        description: knowledgeEntries.description,
        language: knowledgeEntries.language,
        category: knowledgeEntries.category,
        knowledgeType: knowledgeEntries.knowledgeType,
        kind: knowledgeEntries.kind,
        lifecycle: knowledgeEntries.lifecycle,
        content: knowledgeEntries.content,
        trigger: knowledgeEntries.trigger,
        headers: knowledgeEntries.headers,
        moduleName: knowledgeEntries.moduleName,
      })
      .from(knowledgeEntries)
      .where(
        and(
          ne(knowledgeEntries.lifecycle, 'deprecated'),
          or(
            like(knowledgeEntries.title, pattern),
            like(knowledgeEntries.description, pattern),
            like(knowledgeEntries.trigger, pattern),
            like(knowledgeEntries.content, pattern)
          )
        )
      )
      .limit(limit)
      .all();
  }

  /** 按 ID 列表查询详情（_supplementDetails 用） */
  findByIdsDetailSync(ids: string[]) {
    if (ids.length === 0) {
      return [];
    }
    return this.#drizzle
      .select({
        id: knowledgeEntries.id,
        content: knowledgeEntries.content,
        description: knowledgeEntries.description,
        trigger: knowledgeEntries.trigger,
        headers: knowledgeEntries.headers,
        moduleName: knowledgeEntries.moduleName,
        tags: knowledgeEntries.tags,
        language: knowledgeEntries.language,
        category: knowledgeEntries.category,
        updatedAt: knowledgeEntries.updatedAt,
        createdAt: knowledgeEntries.createdAt,
        quality: knowledgeEntries.quality,
        stats: knowledgeEntries.stats,
        difficulty: knowledgeEntries.difficulty,
        whenClause: knowledgeEntries.whenClause,
        doClause: knowledgeEntries.doClause,
      })
      .from(knowledgeEntries)
      .where(inArray(knowledgeEntries.id, ids))
      .all();
  }

  /** 查询指定时间之后更新的条目（refreshIndex 用） */
  findUpdatedSinceSync(sinceIso: string) {
    const sinceEpoch = Math.floor(new Date(sinceIso).getTime() / 1000);
    return this.#drizzle
      .select({
        id: knowledgeEntries.id,
        title: knowledgeEntries.title,
        description: knowledgeEntries.description,
        language: knowledgeEntries.language,
        category: knowledgeEntries.category,
        knowledgeType: knowledgeEntries.knowledgeType,
        kind: knowledgeEntries.kind,
        content: knowledgeEntries.content,
        lifecycle: knowledgeEntries.lifecycle,
        tags: knowledgeEntries.tags,
        trigger: knowledgeEntries.trigger,
        difficulty: knowledgeEntries.difficulty,
        quality: knowledgeEntries.quality,
        stats: knowledgeEntries.stats,
        updatedAt: knowledgeEntries.updatedAt,
        createdAt: knowledgeEntries.createdAt,
      })
      .from(knowledgeEntries)
      .where(gt(knowledgeEntries.updatedAt, sinceEpoch))
      .all();
  }
}

export default KnowledgeRepositoryImpl;

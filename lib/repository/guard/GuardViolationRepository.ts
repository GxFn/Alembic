/**
 * GuardViolationRepository — Guard 违反记录的仓储实现
 *
 * 从 ViolationsStore 提取的数据操作，
 * 使用 Drizzle 类型安全 API 操作 guard_violations 表。
 */

import { and, asc, count, desc, eq, sql, sum } from 'drizzle-orm';
import { guardViolations } from '../../infrastructure/database/drizzle/schema.js';
import { RepositoryBase } from '../base/RepositoryBase.js';

/* ═══ 类型定义 ═══ */

export interface ViolationRecord {
  ruleId?: string;
  severity?: string;
  message?: string;
  line?: number;
  [key: string]: unknown;
}

export interface GuardViolationEntity {
  id: string;
  filePath: string;
  triggeredAt: string;
  violationCount: number;
  summary: string;
  violations: ViolationRecord[];
  createdAt: number;
}

export interface GuardViolationInsert {
  id: string;
  filePath: string;
  triggeredAt: string;
  violationCount: number;
  summary?: string;
  violations: ViolationRecord[];
  createdAt: number;
}

export interface ViolationStats {
  totalRuns: number;
  totalViolations: number;
  averageViolationsPerRun: string | number;
  lastRunAt: string | null;
}

export interface ViolationStatByRule {
  ruleId: string | null;
  severity: string | null;
  count: number;
}

export interface PaginatedViolations {
  data: GuardViolationEntity[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

/* ═══ Repository 实现 ═══ */

export class GuardViolationRepositoryImpl extends RepositoryBase<
  typeof guardViolations,
  GuardViolationEntity
> {
  /** 最大保留条数 */
  static readonly MAX_RUNS = 200;

  constructor(
    drizzle: ConstructorParameters<
      typeof RepositoryBase<typeof guardViolations, GuardViolationEntity>
    >[0]
  ) {
    super(drizzle, guardViolations);
  }

  /* ─── CRUD ─── */

  async findById(id: string): Promise<GuardViolationEntity | null> {
    const row = this.drizzle.select().from(this.table).where(eq(this.table.id, id)).limit(1).get();
    return row ? this.#mapRow(row) : null;
  }

  async create(data: GuardViolationInsert): Promise<GuardViolationEntity> {
    this.drizzle
      .insert(this.table)
      .values({
        id: data.id,
        filePath: data.filePath,
        triggeredAt: data.triggeredAt,
        violationCount: data.violationCount,
        summary: data.summary ?? '',
        violationsJson: JSON.stringify(data.violations),
        createdAt: data.createdAt,
      })
      .run();

    return (await this.findById(data.id))!;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.drizzle.delete(this.table).where(eq(this.table.id, id)).run();
    return result.changes > 0;
  }

  /* ─── 去重查询 ─── */

  /** 获取指定文件的最近一条记录 (用于去重比较) */
  async getLastByFile(filePath: string): Promise<{ id: string; violationsJson: string } | null> {
    const row = this.drizzle
      .select({
        id: this.table.id,
        violationsJson: this.table.violationsJson,
      })
      .from(this.table)
      .where(eq(this.table.filePath, filePath))
      .orderBy(desc(this.table.createdAt))
      .limit(1)
      .get();
    return row ? { id: row.id, violationsJson: row.violationsJson ?? '[]' } : null;
  }

  /** 刷新已有记录的时间戳 (去重命中时) */
  async refreshTimestamp(id: string): Promise<void> {
    this.drizzle
      .update(this.table)
      .set({
        triggeredAt: new Date().toISOString(),
        createdAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(this.table.id, id))
      .run();
  }

  /* ─── 查询 ─── */

  /** 获取所有运行记录 (最旧在前) */
  async getRuns(): Promise<GuardViolationEntity[]> {
    const rows = this.drizzle.select().from(this.table).orderBy(asc(this.table.createdAt)).all();
    return rows.map((r) => this.#mapRow(r));
  }

  /** 按文件路径查询 */
  async getRunsByFile(filePath: string): Promise<GuardViolationEntity[]> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(eq(this.table.filePath, filePath))
      .orderBy(asc(this.table.createdAt))
      .all();
    return rows.map((r) => this.#mapRow(r));
  }

  /** 获取最近 N 条记录 */
  async getRecentRuns(n = 20): Promise<GuardViolationEntity[]> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .orderBy(desc(this.table.createdAt), sql`rowid DESC`)
      .limit(n)
      .all();
    return rows.reverse().map((r) => this.#mapRow(r));
  }

  /** 分页查询 */
  async list(
    filters: { file?: string } = {},
    options: { page?: number; limit?: number } = {}
  ): Promise<PaginatedViolations> {
    const { page = 1, limit = 20 } = options;
    const offset = (page - 1) * limit;

    const condition = filters.file ? eq(this.table.filePath, filters.file) : undefined;

    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(condition)
      .orderBy(desc(this.table.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    const [totalRow] = this.drizzle
      .select({ cnt: count() })
      .from(this.table)
      .where(condition)
      .all();
    const total = totalRow?.cnt ?? 0;

    return {
      data: rows.map((r) => this.#mapRow(r)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /* ─── 统计 ─── */

  /** 获取统计汇总 */
  async getStats(): Promise<ViolationStats> {
    const [row] = this.drizzle
      .select({
        totalRuns: count(),
        totalViolations: sql<number>`COALESCE(SUM(${this.table.violationCount}), 0)`,
        lastRunAt: sql<string | null>`MAX(${this.table.triggeredAt})`,
      })
      .from(this.table)
      .all();

    const totalRuns = row?.totalRuns ?? 0;
    const totalViolations = row?.totalViolations ?? 0;

    return {
      totalRuns,
      totalViolations,
      averageViolationsPerRun: totalRuns > 0 ? (totalViolations / totalRuns).toFixed(2) : 0,
      lastRunAt: row?.lastRunAt ?? null,
    };
  }

  /**
   * 按规则 ID 聚合统计
   * 利用 SQLite json_each 展开 violations_json 数组
   *
   * json_each 是 SQLite 专有函数，Drizzle 无 typed API (ORM limitation)
   */
  async getStatsByRule(): Promise<ViolationStatByRule[]> {
    try {
      const rows = this.drizzle.all<{
        ruleId: string | null;
        severity: string | null;
        count: number;
      }>(sql`
        SELECT
          json_extract(j.value, '$.ruleId') AS ruleId,
          json_extract(j.value, '$.severity') AS severity,
          COUNT(*) AS count
        FROM ${this.table} gv, json_each(gv.violations_json) j
        WHERE json_extract(j.value, '$.ruleId') IS NOT NULL
        GROUP BY ruleId, severity
        ORDER BY count DESC
      `);
      return rows;
    } catch {
      return [];
    }
  }

  /* ─── 容量控制 ─── */

  /** 截断超限记录，保留最新 maxRuns 条 */
  async enforceCapacity(maxRuns = GuardViolationRepositoryImpl.MAX_RUNS): Promise<number> {
    const result = this.drizzle
      .delete(this.table)
      .where(
        sql`${this.table.id} NOT IN (
          SELECT ${this.table.id} FROM ${this.table}
          ORDER BY ${this.table.createdAt} DESC
          LIMIT ${maxRuns}
        )`
      )
      .run();
    return result.changes;
  }

  /** 清空所有记录 */
  async clearAll(): Promise<void> {
    this.drizzle.delete(this.table).run();
  }

  /** 清除指定文件的记录 */
  async clearByFile(filePath: string): Promise<number> {
    const result = this.drizzle.delete(this.table).where(eq(this.table.filePath, filePath)).run();
    return result.changes;
  }

  /**
   * 最近的 violation JSON 列表 (CoverageAnalyzer.#getRecentViolations)
   */
  findRecentViolationsJson(limit: number): Array<{ filePath: string; violationsJson: string }> {
    return this.drizzle
      .select({
        filePath: this.table.filePath,
        violationsJson: this.table.violationsJson,
      })
      .from(this.table)
      .orderBy(desc(this.table.createdAt))
      .limit(limit)
      .all() as Array<{ filePath: string; violationsJson: string }>;
  }

  /* ─── 内部辅助 ─── */

  #mapRow(row: typeof guardViolations.$inferSelect): GuardViolationEntity {
    return {
      id: row.id,
      filePath: row.filePath,
      triggeredAt: row.triggeredAt,
      violationCount: row.violationCount ?? 0,
      summary: row.summary ?? '',
      violations: safeParseJSON(row.violationsJson, [] as ViolationRecord[]),
      createdAt: row.createdAt,
    };
  }
}

function safeParseJSON<T>(str: string | null | undefined, fallback: T): T {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch {
    return fallback;
  }
}

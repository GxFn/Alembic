/**
 * AuditRepository — 审计日志的仓储实现
 *
 * 从 AuditStore 提取的数据操作，
 * 使用 Drizzle 类型安全 API 操作 audit_logs 表。
 */

import { and, avg, count, desc, eq, gt, gte, like, lte, sql } from 'drizzle-orm';
import { auditLogs } from '../../infrastructure/database/drizzle/schema.js';
import { RepositoryBase } from '../base/RepositoryBase.js';

/* ═══ 类型定义 ═══ */

export interface AuditLogEntity {
  id: string;
  timestamp: number;
  actor: string;
  actorContext: Record<string, unknown>;
  action: string;
  resource: string | null;
  operationData: Record<string, unknown>;
  result: string;
  errorMessage: string | null;
  duration: number | null;
}

export interface AuditLogInsert {
  id: string;
  timestamp: number;
  actor: string;
  actorContext?: string;
  action: string;
  resource?: string;
  operationData?: string;
  result: string;
  errorMessage?: string | null;
  duration?: number | null;
}

export interface AuditQueryFilters {
  actor?: string;
  action?: string;
  result?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

export interface AuditStats {
  timeRange: string;
  total: number;
  success: number;
  failure: number;
  successRate: string;
  avgDuration: string;
  byActor: Array<{ actor: string; count: number }>;
  byAction: Array<{ action: string; count: number }>;
}

/* ═══ Repository 实现 ═══ */

export class AuditRepositoryImpl extends RepositoryBase<typeof auditLogs, AuditLogEntity> {
  constructor(
    drizzle: ConstructorParameters<typeof RepositoryBase<typeof auditLogs, AuditLogEntity>>[0]
  ) {
    super(drizzle, auditLogs);
  }

  /* ─── CRUD ─── */

  async findById(id: string): Promise<AuditLogEntity | null> {
    const row = this.drizzle.select().from(this.table).where(eq(this.table.id, id)).limit(1).get();
    return row ? this.#mapRow(row) : null;
  }

  async create(data: AuditLogInsert): Promise<AuditLogEntity> {
    this.drizzle
      .insert(this.table)
      .values({
        id: data.id,
        timestamp: data.timestamp,
        actor: data.actor,
        actorContext: data.actorContext ?? '{}',
        action: data.action,
        resource: data.resource ?? null,
        operationData: data.operationData ?? '{}',
        result: data.result,
        errorMessage: data.errorMessage ?? null,
        duration: data.duration ?? null,
      })
      .run();

    return (await this.findById(data.id))!;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.drizzle.delete(this.table).where(eq(this.table.id, id)).run();
    return result.changes > 0;
  }

  /* ─── 查询 ─── */

  /** 动态多条件查询 */
  async query(filters: AuditQueryFilters = {}): Promise<AuditLogEntity[]> {
    const conditions = [];

    if (filters.actor) {
      conditions.push(eq(this.table.actor, filters.actor));
    }
    if (filters.action) {
      conditions.push(eq(this.table.action, filters.action));
    }
    if (filters.result) {
      conditions.push(eq(this.table.result, filters.result));
    }
    if (filters.startDate) {
      conditions.push(gte(this.table.timestamp, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(this.table.timestamp, filters.endDate));
    }

    const condition = conditions.length > 0 ? and(...conditions) : undefined;

    let query = this.drizzle
      .select()
      .from(this.table)
      .where(condition)
      .orderBy(desc(this.table.timestamp));

    if (filters.limit) {
      query = query.limit(filters.limit) as typeof query;
    }

    return query.all().map((r) => this.#mapRow(r));
  }

  /** 根据请求 ID 查询 */
  async findByRequestId(requestId: string): Promise<AuditLogEntity | null> {
    return this.findById(requestId);
  }

  /** 根据角色查询 */
  async findByActor(actor: string, limit = 100): Promise<AuditLogEntity[]> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(eq(this.table.actor, actor))
      .orderBy(desc(this.table.timestamp))
      .limit(limit)
      .all();
    return rows.map((r) => this.#mapRow(r));
  }

  /** 根据操作查询 */
  async findByAction(action: string, limit = 100): Promise<AuditLogEntity[]> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(eq(this.table.action, action))
      .orderBy(desc(this.table.timestamp))
      .limit(limit)
      .all();
    return rows.map((r) => this.#mapRow(r));
  }

  /** 根据结果查询 */
  async findByResult(result: string, limit = 100): Promise<AuditLogEntity[]> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(eq(this.table.result, result))
      .orderBy(desc(this.table.timestamp))
      .limit(limit)
      .all();
    return rows.map((r) => this.#mapRow(r));
  }

  /* ─── 统计 ─── */

  /** 获取统计数据 */
  async getStats(timeRange = '24h'): Promise<AuditStats> {
    const hours = timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 720; // 30d
    const startTime = Date.now() - hours * 60 * 60 * 1000;

    const startCondition = gte(this.table.timestamp, startTime);

    // 总数
    const [totalRow] = this.drizzle
      .select({ cnt: count() })
      .from(this.table)
      .where(startCondition)
      .all();
    const total = totalRow?.cnt ?? 0;

    // 成功数
    const [successRow] = this.drizzle
      .select({ cnt: count() })
      .from(this.table)
      .where(and(startCondition, eq(this.table.result, 'success')))
      .all();
    const success = successRow?.cnt ?? 0;

    // 失败数
    const [failureRow] = this.drizzle
      .select({ cnt: count() })
      .from(this.table)
      .where(and(startCondition, eq(this.table.result, 'failure')))
      .all();
    const failure = failureRow?.cnt ?? 0;

    // 按角色统计
    const byActor = this.drizzle
      .select({
        actor: this.table.actor,
        count: count(),
      })
      .from(this.table)
      .where(startCondition)
      .groupBy(this.table.actor)
      .orderBy(desc(count()))
      .all();

    // 按操作统计
    const byAction = this.drizzle
      .select({
        action: this.table.action,
        count: count(),
      })
      .from(this.table)
      .where(startCondition)
      .groupBy(this.table.action)
      .orderBy(desc(count()))
      .all();

    // 平均响应时间
    const [avgRow] = this.drizzle
      .select({
        avgDuration: avg(this.table.duration),
      })
      .from(this.table)
      .where(and(startCondition, sql`${this.table.duration} IS NOT NULL`))
      .all();
    const avgDuration = avgRow?.avgDuration ? `${Math.round(Number(avgRow.avgDuration))}ms` : 'N/A';

    return {
      timeRange,
      total,
      success,
      failure,
      successRate: total > 0 ? `${((success / total) * 100).toFixed(2)}%` : '0%',
      avgDuration,
      byActor,
      byAction,
    };
  }

  /* ─── 清理 ─── */

  /**
   * 清理过期审计日志
   * @param maxAgeDays 保留天数
   */
  async cleanup(maxAgeDays = 90): Promise<{ deleted: number }> {
    try {
      const cutoff = Date.now() - maxAgeDays * 86400000;
      const result = this.drizzle
        .delete(this.table)
        .where(sql`${this.table.timestamp} < ${cutoff}`)
        .run();
      return { deleted: result.changes ?? 0 };
    } catch {
      return { deleted: 0 };
    }
  }

  /**
   * Guard 违规规则名 TOP-N (SkillAdvisor.#getGuardPatterns)
   */
  async findTopGuardViolationRules(
    minCount: number,
    limit: number
  ): Promise<Array<{ ruleName: string; cnt: number }>> {
    return this.drizzle
      .select({
        ruleName: sql<string>`json_extract(${this.table.operationData}, '$.ruleName')`.as(
          'ruleName'
        ),
        cnt: count(),
      })
      .from(this.table)
      .where(and(like(this.table.action, 'guard%'), eq(this.table.result, 'violation')))
      .groupBy(sql`json_extract(${this.table.operationData}, '$.ruleName')`)
      .having(sql`count(*) >= ${minCount}`)
      .orderBy(desc(count()))
      .limit(limit)
      .all() as Array<{ ruleName: string; cnt: number }>;
  }

  /**
   * Guard 违规信号 (SignalCollector.#collectGuardSignals)
   */
  async findGuardViolationSignals(
    limit: number
  ): Promise<Array<{ ruleName: string; cnt: number; lastAt: number }>> {
    return this.drizzle
      .select({
        ruleName: sql<string>`json_extract(${this.table.operationData}, '$.ruleName')`.as(
          'ruleName'
        ),
        cnt: count(),
        lastAt: sql<number>`MAX(${this.table.timestamp})`.as('lastAt'),
      })
      .from(this.table)
      .where(and(like(this.table.action, 'guard%'), eq(this.table.result, 'violation')))
      .groupBy(sql`json_extract(${this.table.operationData}, '$.ruleName')`)
      .having(sql`count(*) > 0`)
      .orderBy(desc(count()))
      .limit(limit)
      .all() as Array<{ ruleName: string; cnt: number; lastAt: number }>;
  }

  /**
   * 最近动作日志 (SignalCollector.#collectActionSignals)
   */
  async findRecentActions(
    sinceTs: number,
    limit: number
  ): Promise<
    Array<{
      actor: string;
      action: string;
      resource: string | null;
      result: string;
      timestamp: number;
    }>
  > {
    return this.drizzle
      .select({
        actor: this.table.actor,
        action: this.table.action,
        resource: this.table.resource,
        result: this.table.result,
        timestamp: this.table.timestamp,
      })
      .from(this.table)
      .where(gt(this.table.timestamp, sinceTs))
      .orderBy(desc(this.table.timestamp))
      .limit(limit)
      .all();
  }

  /* ─── 内部辅助 ─── */

  #mapRow(row: typeof auditLogs.$inferSelect): AuditLogEntity {
    return {
      id: row.id,
      timestamp: row.timestamp,
      actor: row.actor,
      actorContext: safeParseJSON(row.actorContext, {} as Record<string, unknown>),
      action: row.action,
      resource: row.resource ?? null,
      operationData: safeParseJSON(row.operationData, {} as Record<string, unknown>),
      result: row.result,
      errorMessage: row.errorMessage ?? null,
      duration: row.duration ?? null,
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

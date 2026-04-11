/** AuditStore - 审计日志存储（全 Drizzle 类型安全） */
import { and, avg, count, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../database/drizzle/index.js';
import { getDrizzle } from '../database/drizzle/index.js';
import { auditLogs } from '../database/drizzle/schema.js';

export class AuditStore {
  #drizzle: DrizzleDB;
  constructor(db: { getDb: () => import('better-sqlite3').Database }, drizzle?: DrizzleDB) {
    this.#drizzle = drizzle ?? getDrizzle();
  }

  /** 保存审计日志 */
  async save(entry: {
    id: string;
    timestamp: number;
    actor: string;
    actor_context: string;
    action: string;
    resource: string;
    operation_data: string;
    result: string;
    error_message: string | null;
    duration: number | null;
  }) {
    this.#drizzle
      .insert(auditLogs)
      .values({
        id: entry.id,
        timestamp: entry.timestamp,
        actor: entry.actor,
        actorContext: entry.actor_context,
        action: entry.action,
        resource: entry.resource,
        operationData: entry.operation_data,
        result: entry.result,
        errorMessage: entry.error_message,
        duration: entry.duration,
      })
      .run();
  }

  /** 查询审计日志（动态多条件，全 Drizzle） */
  query(
    filters: {
      actor?: string;
      action?: string;
      result?: string;
      startDate?: number;
      endDate?: number;
      limit?: number;
    } = {}
  ) {
    const conditions = [];

    if (filters.actor) {
      conditions.push(eq(auditLogs.actor, filters.actor));
    }
    if (filters.action) {
      conditions.push(eq(auditLogs.action, filters.action));
    }
    if (filters.result) {
      conditions.push(eq(auditLogs.result, filters.result));
    }
    if (filters.startDate) {
      conditions.push(gte(auditLogs.timestamp, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(auditLogs.timestamp, filters.endDate));
    }

    const condition = conditions.length > 0 ? and(...conditions) : undefined;

    let query = this.#drizzle
      .select()
      .from(auditLogs)
      .where(condition)
      .orderBy(desc(auditLogs.timestamp));

    if (filters.limit) {
      query = query.limit(filters.limit) as typeof query;
    }

    return query.all();
  }

  /** 根据请求 ID 查询 */
  findByRequestId(requestId: string) {
    return this.#drizzle.select().from(auditLogs).where(eq(auditLogs.id, requestId)).get();
  }

  /** 根据角色查询 */
  findByActor(actor: string, limit = 100) {
    return this.#drizzle
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actor, actor))
      .orderBy(desc(auditLogs.timestamp))
      .limit(limit)
      .all();
  }

  /** 根据操作查询 */
  findByAction(action: string, limit = 100) {
    return this.#drizzle
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, action))
      .orderBy(desc(auditLogs.timestamp))
      .limit(limit)
      .all();
  }

  /** 根据结果查询 */
  findByResult(result: string, limit = 100) {
    return this.#drizzle
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.result, result))
      .orderBy(desc(auditLogs.timestamp))
      .limit(limit)
      .all();
  }

  /** 获取统计数据（全 Drizzle） */
  getStats(timeRange = '24h') {
    const hours = timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 720; // 30d
    const startTime = Date.now() - hours * 60 * 60 * 1000;

    const startCondition = gte(auditLogs.timestamp, startTime);

    // 总数
    const [totalRow] = this.#drizzle
      .select({ count: count() })
      .from(auditLogs)
      .where(startCondition)
      .all();
    const total = totalRow?.count ?? 0;

    // 成功数
    const [successRow] = this.#drizzle
      .select({ count: count() })
      .from(auditLogs)
      .where(and(startCondition, eq(auditLogs.result, 'success')))
      .all();
    const successCount = successRow?.count ?? 0;

    // 失败数
    const [failureRow] = this.#drizzle
      .select({ count: count() })
      .from(auditLogs)
      .where(and(startCondition, eq(auditLogs.result, 'failure')))
      .all();
    const failureCount = failureRow?.count ?? 0;

    // 按角色统计
    const byActor = this.#drizzle
      .select({
        actor: auditLogs.actor,
        count: count(),
      })
      .from(auditLogs)
      .where(startCondition)
      .groupBy(auditLogs.actor)
      .orderBy(desc(count()))
      .all();

    // 按操作统计
    const byAction = this.#drizzle
      .select({
        action: auditLogs.action,
        count: count(),
      })
      .from(auditLogs)
      .where(startCondition)
      .groupBy(auditLogs.action)
      .orderBy(desc(count()))
      .all();

    // 平均响应时间
    const [avgRow] = this.#drizzle
      .select({
        avg_duration: avg(auditLogs.duration),
      })
      .from(auditLogs)
      .where(and(startCondition, sql`${auditLogs.duration} IS NOT NULL`))
      .all();
    const avgDuration = avgRow?.avg_duration
      ? `${Math.round(Number(avgRow.avg_duration))}ms`
      : 'N/A';

    return {
      timeRange,
      total,
      success: successCount,
      failure: failureCount,
      successRate: total > 0 ? `${((successCount / total) * 100).toFixed(2)}%` : '0%',
      avgDuration,
      byActor,
      byAction,
    };
  }

  /**
   * 清理过期审计日志
   * @param [opts.maxAgeDays=90] 保留天数
   */
  cleanup({ maxAgeDays = 90 } = {}) {
    try {
      const cutoff = Date.now() - maxAgeDays * 86400000;
      const result = this.#drizzle
        .delete(auditLogs)
        .where(sql`${auditLogs.timestamp} < ${cutoff}`)
        .run();
      return { deleted: result.changes || 0 };
    } catch {
      return { deleted: 0 };
    }
  }
}

export default AuditStore;

/**
 * ViolationsStore — Guard 违反记录存储（DB 版）
 * 记录每次 as:audit 运行的审计结果，持久化到 SQLite guard_violations 表。
 * 最多保留 200 条。
 *
 * 所有操作使用 Drizzle 类型安全 API（零 raw SQL）。
 */

import { asc, count, desc, eq, sql } from 'drizzle-orm';
import { type DrizzleDB, getDrizzle } from '../../infrastructure/database/drizzle/index.js';
import { guardViolations } from '../../infrastructure/database/drizzle/schema.js';

const MAX_RUNS = 200;

interface ViolationRecord {
  ruleId?: string;
  severity?: string;
  message?: string;
  line?: number;
  [key: string]: unknown;
}

interface RunInput {
  filePath?: string;
  violations?: ViolationRecord[];
  summary?: string;
}

interface RunOutput {
  id: string;
  filePath: string;
  triggeredAt: string;
  violations: ViolationRecord[];
  violationCount: number;
  summary: string;
}

export class ViolationsStore {
  #drizzle: DrizzleDB;

  /** @param _db 保留签名兼容 (不再使用) */
  constructor(_db: unknown, drizzle?: DrizzleDB) {
    this.#drizzle = drizzle ?? getDrizzle();
  }

  // ─── 写入 ─────────────────────────────────────────────

  /**
   * 追加一次 Guard 运行记录
   * ★ 去重：同一文件、同一违规集合不重复入库，仅更新时间戳
   * ★ 全 Drizzle 类型安全
   */
  appendRun(run: RunInput) {
    const filePath = run.filePath || '';
    const violations = run.violations || [];
    const violationsJson = JSON.stringify(violations);

    // ── 去重：查最近一条同文件记录，比较违规指纹 ──
    const fingerprint = this.#violationFingerprint(violations);
    if (filePath) {
      const lastRow = this.#drizzle
        .select({
          id: guardViolations.id,
          violationsJson: guardViolations.violationsJson,
        })
        .from(guardViolations)
        .where(eq(guardViolations.filePath, filePath))
        .orderBy(desc(guardViolations.createdAt))
        .limit(1)
        .get();

      if (lastRow) {
        const lastFingerprint = this.#violationFingerprint(
          JSON.parse(lastRow.violationsJson || '[]')
        );
        if (fingerprint === lastFingerprint) {
          // 违规未变化：仅刷新时间戳，不新增行
          this.#drizzle
            .update(guardViolations)
            .set({
              triggeredAt: new Date().toISOString(),
              createdAt: Math.floor(Date.now() / 1000),
            })
            .where(eq(guardViolations.id, lastRow.id))
            .run();
          return lastRow.id;
        }
      }
    }

    const id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Math.floor(Date.now() / 1000);

    this.#drizzle
      .insert(guardViolations)
      .values({
        id,
        filePath,
        triggeredAt: new Date().toISOString(),
        violationCount: violations.length,
        summary: run.summary || '',
        violationsJson,
        createdAt: now,
      })
      .run();

    // 超限截断：保留最新 MAX_RUNS 条
    this.#drizzle
      .delete(guardViolations)
      .where(
        sql`${guardViolations.id} NOT IN (
          SELECT ${guardViolations.id} FROM ${guardViolations}
          ORDER BY ${guardViolations.createdAt} DESC
          LIMIT ${MAX_RUNS}
        )`
      )
      .run();

    return id;
  }

  /**
   * 违规指纹：按 ruleId+severity+line 排序后拼接，用于去重比较
   */
  #violationFingerprint(violations: ViolationRecord[]): string {
    return violations
      .map((v) => `${v.ruleId || ''}|${v.severity || ''}|${v.line ?? ''}`)
      .sort()
      .join('\n');
  }

  // ─── 查询 ─────────────────────────────────────────────

  /**
   * 获取所有运行记录（最新在后）
   */
  getRuns() {
    const rows = this.#drizzle
      .select()
      .from(guardViolations)
      .orderBy(asc(guardViolations.createdAt))
      .all();
    return rows.map((r) => this.#rowToRun(r));
  }

  /**
   * 按文件路径查询历史
   */
  getRunsByFile(filePath: string) {
    const rows = this.#drizzle
      .select()
      .from(guardViolations)
      .where(eq(guardViolations.filePath, filePath))
      .orderBy(asc(guardViolations.createdAt))
      .all();
    return rows.map((r) => this.#rowToRun(r));
  }

  /**
   * 获取最近 N 条记录
   */
  getRecentRuns(n = 20) {
    const rows = this.#drizzle
      .select()
      .from(guardViolations)
      .orderBy(desc(guardViolations.createdAt), sql`rowid DESC`)
      .limit(n)
      .all();
    return rows.reverse().map((r) => this.#rowToRun(r));
  }

  /** 获取统计汇总 */
  getStats() {
    const [row] = this.#drizzle
      .select({
        totalRuns: count(),
        totalViolations: sql<number>`COALESCE(SUM(${guardViolations.violationCount}), 0)`,
        lastRunAt: sql<string | null>`MAX(${guardViolations.triggeredAt})`,
      })
      .from(guardViolations)
      .all();

    const totalRuns = row?.totalRuns ?? 0;
    const totalViolations = row?.totalViolations ?? 0;

    return {
      totalRuns,
      totalViolations,
      averageViolationsPerRun: totalRuns > 0 ? (totalViolations / totalRuns).toFixed(2) : 0,
      lastRunAt: row?.lastRunAt || null,
    };
  }

  /**
   * 按规则 ID 聚合统计
   * 利用 SQLite json_each 展开 violations_json 数组
   *
   * json_each 是 SQLite 专有函数，Drizzle 无 typed API (ORM limitation)
   */
  getStatsByRule() {
    try {
      return this.#drizzle.all<{
        ruleId: string | null;
        severity: string | null;
        count: number;
      }>(sql`
        SELECT
          json_extract(j.value, '$.ruleId') AS ruleId,
          json_extract(j.value, '$.severity') AS severity,
          COUNT(*) AS count
        FROM ${guardViolations} gv, json_each(gv.violations_json) j
        WHERE json_extract(j.value, '$.ruleId') IS NOT NULL
        GROUP BY ruleId, severity
        ORDER BY count DESC
      `);
    } catch {
      return [];
    }
  }

  /**
   * 获取趋势数据 — 对比最近两次运行
   */
  getTrend() {
    const recent = this.getRecentRuns(2);
    if (recent.length < 2) {
      const latest = recent[0]?.violations || [];
      return {
        errorsChange: 0,
        warningsChange: 0,
        latestErrors: latest.filter((v) => v.severity === 'error').length,
        latestWarnings: latest.filter((v) => v.severity === 'warning').length,
        previousErrors: 0,
        previousWarnings: 0,
        hasHistory: false,
      };
    }

    const [prev, latest] = recent;
    const latestErrors = latest.violations.filter((v) => v.severity === 'error').length;
    const latestWarnings = latest.violations.filter((v) => v.severity === 'warning').length;
    const previousErrors = prev.violations.filter((v) => v.severity === 'error').length;
    const previousWarnings = prev.violations.filter((v) => v.severity === 'warning').length;

    return {
      errorsChange: latestErrors - previousErrors,
      warningsChange: latestWarnings - previousWarnings,
      latestErrors,
      latestWarnings,
      previousErrors,
      previousWarnings,
      hasHistory: true,
    };
  }

  // ─── 清除 ─────────────────────────────────────────────

  /** 清空所有记录 */
  clearRuns() {
    this.#drizzle.delete(guardViolations).run();
  }

  /** 清除指定规则或文件的记录 */
  async clearAll() {
    this.clearRuns();
  }

  async clear({ ruleId, file }: { ruleId?: string; file?: string } = {}) {
    if (file) {
      this.#drizzle.delete(guardViolations).where(eq(guardViolations.filePath, file)).run();
    } else {
      this.clearRuns();
    }
  }

  /** 分页查询 */
  async list(filters: { file?: string } = {}, { page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit;
    const condition = filters.file ? eq(guardViolations.filePath, filters.file) : undefined;

    const rows = this.#drizzle
      .select()
      .from(guardViolations)
      .where(condition)
      .orderBy(desc(guardViolations.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    const [totalRow] = this.#drizzle
      .select({ c: count() })
      .from(guardViolations)
      .where(condition)
      .all();
    const total = totalRow?.c ?? 0;

    return {
      data: rows.map((r) => this.#rowToRun(r)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  // ─── 内部 ─────────────────────────────────────────────

  /** Drizzle camelCase 行 → RunOutput */
  #rowToRun(row: typeof guardViolations.$inferSelect): RunOutput {
    return {
      id: row.id,
      filePath: row.filePath,
      triggeredAt: row.triggeredAt,
      violations: row.violationsJson ? JSON.parse(row.violationsJson) : [],
      violationCount: row.violationCount ?? 0,
      summary: row.summary || '',
    };
  }
}

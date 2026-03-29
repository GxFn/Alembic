/**
 * ViolationsStore — Guard 违反记录存储（DB 版）
 * 记录每次 as:audit 运行的审计结果，持久化到 SQLite guard_violations 表。
 * 最多保留 200 条。
 */

import { asc, desc, eq, sql } from 'drizzle-orm';
import { type DrizzleDB, getDrizzle } from '../../infrastructure/database/drizzle/index.js';
import { guardViolations } from '../../infrastructure/database/drizzle/schema.js';

const MAX_RUNS = 200;

interface DatabaseLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown>;
    all(...params: unknown[]): Record<string, unknown>[];
  };
}

interface ViolationRecord {
  ruleId?: string;
  severity?: string;
  message?: string;
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
  #db: DatabaseLike;
  #drizzle: DrizzleDB;

  /** @param db SQLite 数据库实例 */
  constructor(db: DatabaseLike, drizzle?: DrizzleDB) {
    this.#db = db;
    this.#drizzle = drizzle ?? getDrizzle();
  }

  // ─── 写入 ─────────────────────────────────────────────

  /**
   * 追加一次 Guard 运行记录
   * ★ 去重：同一文件、同一违规集合不重复入库，仅更新时间戳
   * ★ Drizzle 类型安全 INSERT + raw SQL 截断
   */
  appendRun(run: RunInput) {
    const filePath = run.filePath || '';
    const violations = run.violations || [];
    const violationsJson = JSON.stringify(violations);

    // ── 去重：查最近一条同文件记录，比较违规指纹 ──
    const fingerprint = this.#violationFingerprint(violations);
    if (filePath) {
      const lastRow = this.#db
        .prepare(
          `SELECT id, violations_json FROM guard_violations WHERE file_path = ? ORDER BY created_at DESC LIMIT 1`
        )
        .get(filePath) as { id: string; violations_json: string } | undefined;
      if (lastRow) {
        const lastFingerprint = this.#violationFingerprint(
          JSON.parse(lastRow.violations_json || '[]')
        );
        if (fingerprint === lastFingerprint) {
          // 违规未变化：仅刷新时间戳，不新增行
          this.#db
            .prepare(`UPDATE guard_violations SET triggered_at = ?, created_at = ? WHERE id = ?`)
            .run(new Date().toISOString(), Math.floor(Date.now() / 1000), lastRow.id);
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

    // 超限截断：保留最新 MAX_RUNS 条（子查询保留 raw SQL）
    this.#db
      .prepare(`
      DELETE FROM guard_violations WHERE id NOT IN (
        SELECT id FROM guard_violations ORDER BY created_at DESC LIMIT ?
      )
    `)
      .run(MAX_RUNS);

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
   * ★ Drizzle 类型安全 SELECT
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
   * ★ Drizzle 类型安全 SELECT WHERE
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
   * ★ Drizzle 类型安全 SELECT + ORDER + LIMIT
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
    const row = this.#db
      .prepare(`
      SELECT
        COUNT(*)                 AS totalRuns,
        COALESCE(SUM(violation_count), 0) AS totalViolations,
        MAX(triggered_at)        AS lastRunAt
      FROM guard_violations
    `)
      .get() as { totalRuns: number; totalViolations: number; lastRunAt: string | null };

    return {
      totalRuns: row.totalRuns,
      totalViolations: row.totalViolations,
      averageViolationsPerRun:
        row.totalRuns > 0 ? (row.totalViolations / row.totalRuns).toFixed(2) : 0,
      lastRunAt: row.lastRunAt || null,
    };
  }

  /**
   * 按规则 ID 聚合统计
   * 利用 SQLite json_each 展开 violations_json 数组
   * @returns >}
   */
  getStatsByRule() {
    try {
      return this.#db
        .prepare(`
        SELECT
          json_extract(j.value, '$.ruleId') AS ruleId,
          json_extract(j.value, '$.severity') AS severity,
          COUNT(*) AS count
        FROM guard_violations gv, json_each(gv.violations_json) j
        WHERE json_extract(j.value, '$.ruleId') IS NOT NULL
        GROUP BY ruleId, severity
        ORDER BY count DESC
      `)
        .all();
    } catch {
      return [];
    }
  }

  /**
   * 获取趋势数据 — 对比最近两次运行
   * @returns }
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

  /**
   * 清空所有记录
   * ★ Drizzle 类型安全 DELETE
   */
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

  /** 兼容 v2 violations.js 路由的 list() */
  async list(filters: { file?: string } = {}, { page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit;
    let sql = 'SELECT * FROM guard_violations';
    const params: (string | number)[] = [];

    if (filters.file) {
      sql += ' WHERE file_path = ?';
      params.push(filters.file);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.#db.prepare(sql).all(...params);

    const countSql = filters.file
      ? 'SELECT COUNT(*) AS c FROM guard_violations WHERE file_path = ?'
      : 'SELECT COUNT(*) AS c FROM guard_violations';
    const countParams = filters.file ? [filters.file] : [];
    const total = (this.#db.prepare(countSql).get(...countParams) as { c: number }).c;

    return {
      data: rows.map((r) => this.#rowToRun(r)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  // ─── 内部 ─────────────────────────────────────────────

  /** 行转运行记录（兼容 raw SQL snake_case 和 Drizzle camelCase） */
  #rowToRun(row: Record<string, unknown>): RunOutput {
    const violationsRaw = (row.violationsJson ?? row.violations_json) as string | undefined;
    return {
      id: row.id as string,
      filePath: (row.filePath ?? row.file_path) as string,
      triggeredAt: (row.triggeredAt ?? row.triggered_at) as string,
      violations: violationsRaw ? JSON.parse(violationsRaw) : [],
      violationCount: (row.violationCount ?? row.violation_count) as number,
      summary: (row.summary as string) || '',
    };
  }
}

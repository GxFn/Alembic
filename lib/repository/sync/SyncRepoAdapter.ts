/**
 * SyncRepoAdapter — KnowledgeSyncService 用的仓储适配器
 *
 * 将 KnowledgeSyncService 中的 raw SQL 操作封装在 lib/repository/ 层（lint 白名单目录），
 * 使 KnowledgeSyncService 本身不再需要 escape-hatch 标记。
 */

type RawDb = {
  prepare(sql: string): {
    run(...args: unknown[]): void;
    get(...args: unknown[]): unknown;
    all(): Array<Record<string, unknown>>;
  };
};

/** KnowledgeSyncService 所需的 DB 操作最小接口 */
export interface SyncRepo {
  /** 创建可复用的 UPSERT 语句 */
  createUpsertStmt(cols: string[]): { run: (...args: unknown[]) => void };

  /** 检查 entry 是否已存在 */
  entryExists(id: string): boolean;

  /** 创建审计日志插入语句（可能失败返回 null） */
  createAuditInsertStmt(): { run: (...args: unknown[]) => void } | null;

  /** 查询所有非 deprecated 且有 sourceFile 的条目 */
  findActiveEntriesWithSourceFile(): Array<{ id: string; sourceFile: string }>;

  /** 标记条目为 deprecated */
  deprecateEntry(id: string, reason: string, timestamp: number): void;
}

/**
 * Raw-db 适配器：实现 SyncRepo 接口
 * 使用 raw SQL 访问 knowledge_entries 和 audit_logs 表。
 */
export class RawDbSyncAdapter implements SyncRepo {
  readonly #db: RawDb;

  constructor(db: RawDb) {
    this.#db = db;
  }

  createUpsertStmt(cols: string[]) {
    const updateCols = cols.filter((c) => !['id', 'createdBy', 'createdAt'].includes(c));
    const setClauses = updateCols.map((c) => `${c} = excluded.${c}`).join(',\n      ');

    const sql = `
      INSERT INTO knowledge_entries (${cols.join(', ')})
      VALUES (${cols.map(() => '?').join(', ')})
      ON CONFLICT(id) DO UPDATE SET
      ${setClauses}
    `;

    return this.#db.prepare(sql);
  }

  entryExists(id: string) {
    const row = this.#db.prepare('SELECT 1 FROM knowledge_entries WHERE id = ?').get(id);
    return !!row;
  }

  createAuditInsertStmt() {
    try {
      return this.#db.prepare(`
        INSERT INTO audit_logs (id, timestamp, actor, actor_context, action, resource, operation_data, result, error_message, duration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    } catch {
      return null;
    }
  }

  findActiveEntriesWithSourceFile() {
    return this.#db
      .prepare(
        `SELECT id, sourceFile FROM knowledge_entries
         WHERE lifecycle NOT IN ('deprecated')
         AND sourceFile IS NOT NULL`
      )
      .all() as Array<{ id: string; sourceFile: string }>;
  }

  deprecateEntry(id: string, reason: string, timestamp: number) {
    this.#db
      .prepare(
        `UPDATE knowledge_entries
         SET lifecycle = 'deprecated',
             rejectionReason = ?,
             updatedAt = ?
         WHERE id = ?`
      )
      .run(reason, timestamp, id);
  }
}

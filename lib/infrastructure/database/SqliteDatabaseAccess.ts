export interface SqliteStatement {
  run(...params: unknown[]): { changes?: number } | unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface SqliteDatabaseHandle {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close?: () => void;
}

interface SqliteDatabaseWrapper {
  getDb?: () => SqliteDatabaseHandle;
}

export interface RecipeSnapshotSqlRow {
  id: string;
  title: string;
  trigger: string;
  dimensionId: string | null;
  category: string;
  knowledgeType: string | null;
  doClause: string | null;
  sourceFile: string | null;
  lifecycle: string;
  content: string | null;
  sourceRefsJson: string | null;
}

export interface HitStatsUpdateRunner {
  run(field: string, count: number, updatedAt: number, recipeId: string): void;
}

interface SqliteRunStatement {
  run(...params: unknown[]): unknown;
}

interface SqliteRunDatabaseHandle {
  prepare(sql: string): SqliteRunStatement;
}

export function unwrapSqliteDatabase(db: unknown): SqliteDatabaseHandle | null {
  if (!db) {
    return null;
  }
  const wrapper = db as SqliteDatabaseWrapper;
  if (typeof wrapper.getDb === 'function') {
    return wrapper.getDb();
  }
  return db as SqliteDatabaseHandle;
}

export function readLatestSchemaMigrationVersion(db: unknown): string | null {
  try {
    const rawDb = unwrapSqliteDatabase(db);
    const row = rawDb
      ?.prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1')
      .get() as { version?: string } | undefined;
    return row?.version || null;
  } catch {
    return null;
  }
}

export function readKnowledgeEntryColumns(db: SqliteDatabaseHandle): Array<{ name: string }> {
  return db.prepare('PRAGMA table_info(knowledge_entries)').all() as Array<{ name: string }>;
}

export function readRecipeSnapshotRows(
  db: SqliteDatabaseHandle,
  options: { hasDimensionId: boolean; lifecycleFilterSql: string; lifecycleParams: unknown[] }
): RecipeSnapshotSqlRow[] {
  const dimensionProjection = options.hasDimensionId ? 'dimensionId' : "'' AS dimensionId";
  return db
    .prepare(
      // @escape-hatch(permanent) — dynamic lifecycle filter + json_extract
      `SELECT id, title, trigger, ${dimensionProjection},
              category, knowledgeType, doClause,
              sourceFile, lifecycle, content, json_extract(reasoning, '$.sources') AS sourceRefsJson
       FROM knowledge_entries
       WHERE ${options.lifecycleFilterSql}`
    )
    .all(...options.lifecycleParams) as RecipeSnapshotSqlRow[];
}

export function readTableRowsForSnapshot(
  db: SqliteDatabaseHandle,
  table: string
): Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]; // @escape-hatch(permanent) — dynamic table name for backup export
}

export function createHitStatsUpdateRunner(db: SqliteRunDatabaseHandle): HitStatsUpdateRunner {
  const stmt = db.prepare(
    // @escape-hatch(permanent) — json_set() not expressible in Drizzle
    `UPDATE knowledge_entries
     SET stats = json_set(
           COALESCE(stats, '{}'),
           '$.' || ?,
           COALESCE(json_extract(stats, '$.' || ?), 0) + ?
         ),
         updatedAt = ?
     WHERE id = ?`
  );

  return {
    run(field: string, count: number, updatedAt: number, recipeId: string): void {
      stmt.run(field, field, count, updatedAt, recipeId);
    },
  };
}

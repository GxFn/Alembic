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

export interface ActiveRecipeRegionSqlRow {
  id: string;
  title: string | null;
  description: string | null;
  lifecycle: string | null;
  language: string | null;
  dimensionId: string | null;
  category: string | null;
  kind: string | null;
  knowledgeType: string | null;
  tags: string | null;
  trigger: string | null;
  topicHint: string | null;
  whenClause: string | null;
  doClause: string | null;
  dontClause: string | null;
  coreCode: string | null;
  usageGuide: string | null;
  content: string | null;
  reasoning: string | null;
  sourceFile: string | null;
  moduleName: string | null;
  contentHash: string | null;
  updatedAt: number | string | null;
}

export interface RecipeSourceRefSqlRow {
  recipe_id: string;
  source_path: string | null;
  status: string | null;
}

export interface ProjectContextFileSnapshotRow {
  id: string;
  payload: string;
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

export function readActiveRecipeRegionRows(
  db: SqliteDatabaseHandle,
  projectionSql: string
): ActiveRecipeRegionSqlRow[] {
  return db
    .prepare(
      `SELECT ${projectionSql}
       FROM knowledge_entries
       WHERE lower(COALESCE(lifecycle, '')) = 'active'
       ORDER BY id`
    )
    .all() as ActiveRecipeRegionSqlRow[];
}

export function readRecipeSourceRefRows(
  db: SqliteDatabaseHandle,
  recipeIds: string[]
): RecipeSourceRefSqlRow[] {
  if (recipeIds.length === 0 || !sqliteTableExists(db, 'recipe_source_refs')) {
    return [];
  }
  const placeholders = recipeIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT recipe_id, source_path, status
       FROM recipe_source_refs
       WHERE recipe_id IN (${placeholders})
       ORDER BY recipe_id, source_path`
    )
    .all(...recipeIds) as RecipeSourceRefSqlRow[];
}

export function sqliteTableExists(db: SqliteDatabaseHandle, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
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

export function clearProjectContextFileSnapshots(db: unknown, projectRoot: string): boolean {
  const rawDb = unwrapPreparedSqliteDatabase(db);
  if (!rawDb) {
    return false;
  }
  rawDb
    .prepare('DELETE FROM project_context_file_snapshots WHERE project_root = ?')
    .run(projectRoot);
  return true;
}

export function saveProjectContextFileSnapshotRow(
  db: unknown,
  input: { id: string; payload: string; projectRoot: string; sessionId: string; createdAt: number }
): boolean {
  const rawDb = unwrapPreparedSqliteDatabase(db);
  if (!rawDb) {
    return false;
  }
  rawDb
    .prepare(
      'CREATE TABLE IF NOT EXISTS project_context_file_snapshots (id TEXT PRIMARY KEY, project_root TEXT NOT NULL, session_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL)'
    )
    .run();
  rawDb
    .prepare(
      'INSERT INTO project_context_file_snapshots (id, project_root, session_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(input.id, input.projectRoot, input.sessionId, input.payload, input.createdAt);
  return true;
}

export function readLatestProjectContextFileSnapshotRow(
  db: unknown,
  projectRoot: string
): ProjectContextFileSnapshotRow | null {
  const rawDb = unwrapPreparedSqliteDatabase(db);
  if (!rawDb) {
    return null;
  }
  const row = rawDb
    .prepare(
      'SELECT id, payload FROM project_context_file_snapshots WHERE project_root = ? ORDER BY created_at DESC LIMIT 1'
    )
    .get(projectRoot);
  if (!row || typeof row !== 'object') {
    return null;
  }
  const record = row as { id?: unknown; payload?: unknown };
  if (typeof record.id !== 'string' || typeof record.payload !== 'string') {
    return null;
  }
  return { id: record.id, payload: record.payload };
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

function unwrapPreparedSqliteDatabase(db: unknown): SqliteDatabaseHandle | null {
  const rawDb = unwrapSqliteDatabase(db);
  if (!rawDb || typeof (rawDb as { prepare?: unknown }).prepare !== 'function') {
    return null;
  }
  return rawDb;
}

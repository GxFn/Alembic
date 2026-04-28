/**
 * Migration 009: scan_runs 表
 *
 * 记录冷启动、深度挖掘、增量修正和日常维护扫描的运行状态与摘要。
 */
export default function migrate(db: import('better-sqlite3').Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_runs (
      id                     TEXT PRIMARY KEY,
      project_root           TEXT NOT NULL,
      mode                   TEXT NOT NULL,
      depth                  TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'running',
      reason                 TEXT NOT NULL DEFAULT '',
      active_dimensions_json TEXT NOT NULL DEFAULT '[]',
      scope_json             TEXT NOT NULL DEFAULT '{}',
      change_set_json        TEXT,
      budgets_json           TEXT NOT NULL DEFAULT '{}',
      summary_json           TEXT NOT NULL DEFAULT '{}',
      error_message          TEXT,
      parent_snapshot_id     TEXT,
      baseline_snapshot_id   TEXT,
      started_at             INTEGER NOT NULL,
      completed_at           INTEGER,
      duration_ms            INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_scan_runs_project_started ON scan_runs(project_root, started_at);
    CREATE INDEX IF NOT EXISTS idx_scan_runs_mode ON scan_runs(mode);
    CREATE INDEX IF NOT EXISTS idx_scan_runs_status ON scan_runs(status);
    CREATE INDEX IF NOT EXISTS idx_scan_runs_completed ON scan_runs(completed_at);
  `);
}

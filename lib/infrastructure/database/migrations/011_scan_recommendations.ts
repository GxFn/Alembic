/**
 * Migration 011: scan_recommendations 表
 *
 * 将 maintenance 输出的 recommendedRuns 固化为可追踪状态：pending、queued、dismissed、executed。
 */
export default function migrate(db: import('better-sqlite3').Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_recommendations (
      id                TEXT PRIMARY KEY,
      project_root      TEXT NOT NULL,
      source_run_id     TEXT,
      target_mode       TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      reason            TEXT NOT NULL DEFAULT '',
      scope_json        TEXT NOT NULL DEFAULT '{}',
      priority          TEXT NOT NULL DEFAULT 'medium',
      queued_job_id     TEXT,
      executed_run_id   TEXT,
      dismissed_reason  TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,

      FOREIGN KEY (source_run_id) REFERENCES scan_runs(id) ON DELETE SET NULL,
      FOREIGN KEY (executed_run_id) REFERENCES scan_runs(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scan_recommendations_project_status
      ON scan_recommendations(project_root, status);
    CREATE INDEX IF NOT EXISTS idx_scan_recommendations_source_run
      ON scan_recommendations(source_run_id);
    CREATE INDEX IF NOT EXISTS idx_scan_recommendations_mode
      ON scan_recommendations(target_mode);
    CREATE INDEX IF NOT EXISTS idx_scan_recommendations_created
      ON scan_recommendations(created_at);
  `);
}

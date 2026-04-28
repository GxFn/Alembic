/**
 * Migration 010: scan_evidence_packs 表
 *
 * 保存扫描运行产生的 evidence pack，便于调试 Agent 输入和检索上下文。
 */
export default function migrate(db: import('better-sqlite3').Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_evidence_packs (
      id           TEXT PRIMARY KEY,
      run_id       TEXT NOT NULL,
      pack_kind    TEXT NOT NULL DEFAULT 'retrieval',
      pack_json    TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      char_count   INTEGER NOT NULL DEFAULT 0,
      truncated    INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,

      FOREIGN KEY (run_id) REFERENCES scan_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_scan_evidence_run ON scan_evidence_packs(run_id);
    CREATE INDEX IF NOT EXISTS idx_scan_evidence_kind ON scan_evidence_packs(pack_kind);
    CREATE INDEX IF NOT EXISTS idx_scan_evidence_created ON scan_evidence_packs(created_at);
  `);
}

/**
 * Migration 006 — Lifecycle Transition Events
 *
 * Recipe 生命周期状态转移事件日志表（Event Sourcing 模式）。
 * 记录每次状态转移的完整审计信息，支持回溯与监控。
 */
export default function migrate(db: import('better-sqlite3').Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_transition_events (
      id            TEXT PRIMARY KEY,
      recipe_id     TEXT NOT NULL,
      from_state    TEXT NOT NULL,
      to_state      TEXT NOT NULL,
      trigger       TEXT NOT NULL,
      operator_id   TEXT NOT NULL DEFAULT 'system',
      evidence_json TEXT,
      proposal_id   TEXT,
      created_at    INTEGER NOT NULL,

      FOREIGN KEY (recipe_id)   REFERENCES knowledge_entries(id),
      FOREIGN KEY (proposal_id) REFERENCES evolution_proposals(id)
    );

    CREATE INDEX IF NOT EXISTS idx_lte_recipe_id  ON lifecycle_transition_events(recipe_id);
    CREATE INDEX IF NOT EXISTS idx_lte_created_at ON lifecycle_transition_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_lte_trigger    ON lifecycle_transition_events(trigger);
  `);
}

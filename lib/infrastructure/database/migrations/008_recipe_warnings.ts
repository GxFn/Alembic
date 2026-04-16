/**
 * Migration 008: recipe_warnings 表
 *
 * 持久化 KnowledgeMetabolism 产出的 RecipeWarning（contradiction / redundancy）。
 * 原先 warning 仅存在于内存中的 MetabolismReport，Database 中无持久化。
 */
export default function migrate(db: import('better-sqlite3').Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipe_warnings (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL,
      target_recipe_id TEXT NOT NULL,
      related_recipe_ids TEXT NOT NULL DEFAULT '[]',
      confidence      REAL NOT NULL DEFAULT 0,
      description     TEXT NOT NULL DEFAULT '',
      evidence        TEXT NOT NULL DEFAULT '[]',
      status          TEXT NOT NULL DEFAULT 'open',
      detected_at     INTEGER NOT NULL,
      resolved_at     INTEGER,
      resolved_by     TEXT,
      resolution      TEXT,
      FOREIGN KEY (target_recipe_id) REFERENCES knowledge_entries(id)
    );

    CREATE INDEX IF NOT EXISTS idx_rw_target ON recipe_warnings(target_recipe_id);
    CREATE INDEX IF NOT EXISTS idx_rw_type ON recipe_warnings(type);
    CREATE INDEX IF NOT EXISTS idx_rw_status ON recipe_warnings(status);
    CREATE INDEX IF NOT EXISTS idx_rw_detected ON recipe_warnings(detected_at);
  `);
}

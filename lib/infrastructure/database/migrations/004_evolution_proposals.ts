/**
 * Migration 004 — Evolution Proposals + Staging Support
 *
 * M2 Recipe 治理所需的 schema 扩展：
 *   1. evolution_proposals 表 — 存储进化提案（矛盾/冗余/衰退/增强）
 *   2. knowledge_entries 添加 staging_deadline 列
 */
export default function migrate(db: import('better-sqlite3').Database) {
  db.exec(`
    -- 进化提案表
    CREATE TABLE IF NOT EXISTS evolution_proposals (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL,
      target_recipe_id TEXT NOT NULL,
      related_recipe_ids TEXT DEFAULT '[]',
      confidence      REAL NOT NULL DEFAULT 0,
      source          TEXT NOT NULL,
      description     TEXT DEFAULT '',
      evidence        TEXT DEFAULT '[]',
      status          TEXT NOT NULL DEFAULT 'pending',
      proposed_at     INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      resolved_at     INTEGER,
      resolved_by     TEXT,
      resolution      TEXT,

      FOREIGN KEY (target_recipe_id) REFERENCES knowledge_entries(id)
    );

    CREATE INDEX IF NOT EXISTS idx_ep_status ON evolution_proposals(status);
    CREATE INDEX IF NOT EXISTS idx_ep_target ON evolution_proposals(target_recipe_id);
    CREATE INDEX IF NOT EXISTS idx_ep_expires ON evolution_proposals(expires_at);
    CREATE INDEX IF NOT EXISTS idx_ep_source ON evolution_proposals(source);
  `);

  // knowledge_entries 添加 staging_deadline 列（兼容已有数据）
  // 使用 ALTER TABLE — SQLite 不支持 IF NOT EXISTS for columns，需要 try/catch
  try {
    db.exec(`ALTER TABLE knowledge_entries ADD COLUMN staging_deadline INTEGER`);
  } catch {
    // 列已存在，忽略
  }
}

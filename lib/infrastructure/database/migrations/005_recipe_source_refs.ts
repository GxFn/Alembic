/**
 * Migration 005 — Recipe Source References 桥接表
 *
 * 存储 Recipe 的 reasoning.sources 路径引用及其健康状态：
 *   - active:  文件存在，路径有效
 *   - renamed: 文件已移动到 new_path，等待修复
 *   - stale:   路径失效，无法自动修复
 */
export default function migrate(db: import('better-sqlite3').Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipe_source_refs (
      recipe_id    TEXT    NOT NULL,
      source_path  TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'active',
      new_path     TEXT,
      verified_at  INTEGER NOT NULL,
      PRIMARY KEY (recipe_id, source_path),
      FOREIGN KEY (recipe_id) REFERENCES knowledge_entries(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_rsr_path   ON recipe_source_refs(source_path);
    CREATE INDEX IF NOT EXISTS idx_rsr_status ON recipe_source_refs(status);
  `);
}

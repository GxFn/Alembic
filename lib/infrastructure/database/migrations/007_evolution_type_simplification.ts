/**
 * Migration 007 — Evolution Type Simplification
 *
 * 将 evolution_proposals.type 从 7 种值收敛为 2 种：
 *   - merge, enhance, correction → update
 *   - supersede → deprecate (已有 deprecate 保持不变)
 *   - contradiction, reorganize → 删除（转为 RecipeWarning 信号层）
 */
export default function migrate(db: import('better-sqlite3').Database) {
  // 将旧类型映射到新类型
  db.exec(`
    UPDATE evolution_proposals SET type = 'update'
    WHERE type IN ('merge', 'enhance', 'correction');
  `);

  db.exec(`
    UPDATE evolution_proposals SET type = 'deprecate'
    WHERE type = 'supersede';
  `);

  // 删除不再支持的类型（矛盾和重组现在走 RecipeWarning 信号层）
  db.exec(`
    DELETE FROM evolution_proposals
    WHERE type IN ('contradiction', 'reorganize');
  `);
}

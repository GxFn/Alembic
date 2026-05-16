/**
 * Migration 003 — Remote Command Queue
 *
 * 飞书/Telegram 等 IM 远程指令队列表
 * VSCode 扩展轮询 pending → 注入 Copilot Chat → 回写结果
 */
export default function migrate(db: import('better-sqlite3').Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_commands (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL DEFAULT 'lark',
      chat_id         TEXT,
      message_id      TEXT,
      user_id         TEXT,
      user_name       TEXT,
      command         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      result          TEXT,
      created_at      INTEGER NOT NULL,
      claimed_at      INTEGER,
      completed_at    INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_remote_commands_status ON remote_commands(status);
    CREATE INDEX IF NOT EXISTS idx_remote_commands_created ON remote_commands(created_at);
  `);
}

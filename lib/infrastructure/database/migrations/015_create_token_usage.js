/**
 * Migration 015: Create token_usage table
 *
 * 持久化 AI 调用的 Token 消耗记录，支持近 7 日消耗趋势查询。
 * 每次 ChatAgent.execute() 完成后写入一条记录。
 */
export default function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   INTEGER NOT NULL,
      source      TEXT NOT NULL DEFAULT 'unknown',
      dimension   TEXT,
      provider    TEXT,
      model       TEXT,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens  INTEGER NOT NULL DEFAULT 0,
      duration_ms   INTEGER,
      tool_calls    INTEGER DEFAULT 0,
      session_id    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_usage_source    ON token_usage(source);
  `);
}

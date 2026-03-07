/**
 * Migration 002: TaskGraph 任务表
 *
 * 新增 tasks 表 + task_dependencies 表 + task_events 表。
 *
 * 设计决策 D1: 独立 task_dependencies 表（不复用 knowledge_edges）
 *   - 语义不同（任务依赖 vs 知识关系）
 *   - 需要专门的索引优化就绪检测查询
 *   - 避免与知识图谱互相污染
 */
export default function migrate(db: import('better-sqlite3').Database) {
  // ── tasks 表 ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id              TEXT PRIMARY KEY,
      parent_id       TEXT,
      child_seq       INTEGER DEFAULT 0,

      title           TEXT NOT NULL,
      description     TEXT DEFAULT '',
      design          TEXT DEFAULT '',
      acceptance      TEXT DEFAULT '',
      notes           TEXT DEFAULT '',

      status          TEXT NOT NULL DEFAULT 'open',
      priority        INTEGER NOT NULL DEFAULT 2,
      task_type       TEXT NOT NULL DEFAULT 'task',
      close_reason    TEXT DEFAULT '',
      content_hash    TEXT DEFAULT '',
      fail_count      INTEGER DEFAULT 0,
      last_fail_reason TEXT DEFAULT '',

      assignee        TEXT DEFAULT '',
      created_by      TEXT DEFAULT 'agent',

      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      closed_at       INTEGER,

      metadata        TEXT DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority   ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent     ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_type       ON tasks(task_type);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee   ON tasks(assignee);
    CREATE INDEX IF NOT EXISTS idx_tasks_created    ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_hash       ON tasks(content_hash);
  `);

  // ── task_dependencies 表 ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id         TEXT NOT NULL,
      depends_on_id   TEXT NOT NULL,
      dep_type        TEXT NOT NULL DEFAULT 'blocks',
      metadata        TEXT DEFAULT '{}',
      created_at      INTEGER NOT NULL,
      created_by      TEXT DEFAULT 'agent',

      UNIQUE (task_id, depends_on_id, dep_type)
    );

    CREATE INDEX IF NOT EXISTS idx_td_task       ON task_dependencies(task_id);
    CREATE INDEX IF NOT EXISTS idx_td_depends_on ON task_dependencies(depends_on_id);
    CREATE INDEX IF NOT EXISTS idx_td_type       ON task_dependencies(dep_type);
  `);

  // ── task_events 审计表 ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id         TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      actor           TEXT DEFAULT 'agent',
      old_value       TEXT,
      new_value       TEXT,
      comment         TEXT,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_te_task    ON task_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_te_type    ON task_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_te_created ON task_events(created_at);
  `);
}

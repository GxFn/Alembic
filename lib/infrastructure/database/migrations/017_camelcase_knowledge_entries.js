/**
 * Migration 017: Recreate knowledge_entries with camelCase columns
 *
 * 全链路统一 camelCase — DB 列名 = 实体属性名。
 * 新增 Cursor 交付字段列（topicHint, whenClause, doClause, dontClause, coreCode）。
 * 清除旧 snake_case 列名和冗余字段。
 *
 * ⚠️ 破坏性迁移 — 需配合清库重跑 bootstrap 使用。
 */
export default function migrate(db) {
  // 检查旧表是否存在
  const oldTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_entries'"
  ).get();

  if (oldTable) {
    // 检查是否已是新 schema（有 topicHint 列）
    const cols = db.prepare('PRAGMA table_info(knowledge_entries)').all();
    const hasTopicHint = cols.some(c => c.name === 'topicHint');
    if (hasTopicHint) {
      process.stderr.write('  ℹ️  017: knowledge_entries already has camelCase schema, skipping\n');
      return;
    }

    // 备份旧表
    db.exec(`ALTER TABLE knowledge_entries RENAME TO _legacy_knowledge_entries_v2;`);
    process.stderr.write('  ℹ️  017: renamed old knowledge_entries → _legacy_knowledge_entries_v2\n');
  }

  // 创建新 camelCase schema
  db.exec(`
    CREATE TABLE knowledge_entries (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL DEFAULT '',
      description       TEXT DEFAULT '',

      lifecycle         TEXT NOT NULL DEFAULT 'pending',
      lifecycleHistory  TEXT DEFAULT '[]',
      autoApprovable    INTEGER DEFAULT 0,

      language          TEXT NOT NULL DEFAULT '',
      category          TEXT NOT NULL DEFAULT 'general',
      kind              TEXT DEFAULT 'pattern',
      knowledgeType     TEXT DEFAULT 'code-pattern',
      complexity        TEXT DEFAULT 'intermediate',
      scope             TEXT DEFAULT 'universal',
      difficulty        TEXT,
      tags              TEXT DEFAULT '[]',

      -- Cursor 交付字段
      trigger           TEXT DEFAULT '',
      topicHint         TEXT DEFAULT '',
      whenClause        TEXT DEFAULT '',
      doClause          TEXT DEFAULT '',
      dontClause        TEXT DEFAULT '',
      coreCode          TEXT DEFAULT '',

      -- 值对象 (JSON)
      content           TEXT DEFAULT '{}',
      relations         TEXT DEFAULT '{}',
      constraints       TEXT DEFAULT '{}',
      reasoning         TEXT DEFAULT '{}',
      quality           TEXT DEFAULT '{}',
      stats             TEXT DEFAULT '{}',

      -- ObjC/Swift headers
      headers           TEXT DEFAULT '[]',
      headerPaths       TEXT DEFAULT '[]',
      moduleName        TEXT DEFAULT '',
      includeHeaders    INTEGER DEFAULT 0,

      -- AI notes
      agentNotes        TEXT,
      aiInsight         TEXT,

      -- Review
      reviewedBy        TEXT,
      reviewedAt        INTEGER,
      rejectionReason   TEXT,

      -- Source
      source            TEXT DEFAULT 'agent',
      sourceFile        TEXT,
      sourceCandidateId TEXT,

      -- Timestamps
      createdBy         TEXT DEFAULT 'agent',
      createdAt         INTEGER NOT NULL,
      updatedAt         INTEGER NOT NULL,
      publishedAt       INTEGER,
      publishedBy       TEXT
    );

    CREATE INDEX idx_ke3_lifecycle    ON knowledge_entries(lifecycle);
    CREATE INDEX idx_ke3_language     ON knowledge_entries(language);
    CREATE INDEX idx_ke3_category     ON knowledge_entries(category);
    CREATE INDEX idx_ke3_kind         ON knowledge_entries(kind);
    CREATE INDEX idx_ke3_createdAt    ON knowledge_entries(createdAt);
    CREATE INDEX idx_ke3_trigger      ON knowledge_entries(trigger);
    CREATE INDEX idx_ke3_title        ON knowledge_entries(title);
    CREATE INDEX idx_ke3_source       ON knowledge_entries(source);
    CREATE INDEX idx_ke3_guard_active ON knowledge_entries(kind, lifecycle);
    CREATE INDEX idx_ke3_topicHint    ON knowledge_entries(topicHint);
  `);

  process.stderr.write('  ✅ 017: created knowledge_entries with camelCase schema\n');
}

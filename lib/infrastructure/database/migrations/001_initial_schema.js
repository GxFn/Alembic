/**
 * Migration 001: Initial Schema (V3)
 *
 * 全新数据库初始化 — 一次性创建所有表。
 * 10 张表、统一 camelCase 命名（knowledge_entries 主表）。
 *
 * 表清单:
 *   1. knowledge_entries      — 核心知识条目 (Skills/Candidates/Guards)
 *   2. knowledge_edges        — 知识关系图谱边
 *   3. guard_violations       — Guard 违反记录
 *   4. audit_logs             — 审计日志
 *   5. sessions               — 会话管理
 *   6. token_usage            — AI Token 消耗记录
 *   7. semantic_memories      — 项目级语义记忆 (Agent Memory Tier 3)
 *   8. bootstrap_snapshots    — Bootstrap 快照主表
 *   9. bootstrap_dim_files    — 维度-文件关联表
 *  10. code_entities          — 代码实体节点 (AST 解析)
 */
export default function migrate(db) {

  // ═══════════════════════════════════════════════════════════════
  // 1. knowledge_entries — 核心知识条目
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_entries (
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
      publishedBy       TEXT,

      -- Content hash (file-sync integrity)
      contentHash       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ke3_lifecycle    ON knowledge_entries(lifecycle);
    CREATE INDEX IF NOT EXISTS idx_ke3_language     ON knowledge_entries(language);
    CREATE INDEX IF NOT EXISTS idx_ke3_category     ON knowledge_entries(category);
    CREATE INDEX IF NOT EXISTS idx_ke3_kind         ON knowledge_entries(kind);
    CREATE INDEX IF NOT EXISTS idx_ke3_createdAt    ON knowledge_entries(createdAt);
    CREATE INDEX IF NOT EXISTS idx_ke3_trigger      ON knowledge_entries(trigger);
    CREATE INDEX IF NOT EXISTS idx_ke3_title        ON knowledge_entries(title);
    CREATE INDEX IF NOT EXISTS idx_ke3_source       ON knowledge_entries(source);
    CREATE INDEX IF NOT EXISTS idx_ke3_guard_active ON knowledge_entries(kind, lifecycle);
    CREATE INDEX IF NOT EXISTS idx_ke3_topicHint    ON knowledge_entries(topicHint);
  `);

  // ═══════════════════════════════════════════════════════════════
  // 2. knowledge_edges — 知识关系图谱边
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_edges (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id       TEXT NOT NULL,
      from_type     TEXT NOT NULL DEFAULT 'recipe',
      to_id         TEXT NOT NULL,
      to_type       TEXT NOT NULL DEFAULT 'recipe',
      relation      TEXT NOT NULL,
      weight        REAL DEFAULT 1.0,
      metadata_json TEXT DEFAULT '{}',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,

      UNIQUE (from_id, from_type, to_id, to_type, relation)
    );

    CREATE INDEX IF NOT EXISTS idx_ke_from      ON knowledge_edges(from_id, from_type);
    CREATE INDEX IF NOT EXISTS idx_ke_to        ON knowledge_edges(to_id, to_type);
    CREATE INDEX IF NOT EXISTS idx_ke_relation  ON knowledge_edges(relation);
  `);

  // ═══════════════════════════════════════════════════════════════
  // 3. guard_violations — Guard 违反记录
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS guard_violations (
      id              TEXT PRIMARY KEY,
      file_path       TEXT NOT NULL,
      triggered_at    TEXT NOT NULL,
      violation_count INTEGER DEFAULT 0,
      summary         TEXT,
      violations_json TEXT DEFAULT '[]',
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_guard_violations_file ON guard_violations(file_path);
    CREATE INDEX IF NOT EXISTS idx_guard_violations_time ON guard_violations(triggered_at);
  `);

  // ═══════════════════════════════════════════════════════════════
  // 4. audit_logs — 审计日志
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id              TEXT PRIMARY KEY,
      timestamp       INTEGER NOT NULL,
      actor           TEXT NOT NULL,
      actor_context   TEXT DEFAULT '{}',
      action          TEXT NOT NULL,
      resource        TEXT,
      operation_data  TEXT DEFAULT '{}',
      result          TEXT NOT NULL,
      error_message   TEXT,
      duration        INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_audit_actor     ON audit_logs(actor);
    CREATE INDEX IF NOT EXISTS idx_audit_action    ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_result    ON audit_logs(result);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
  `);

  // ═══════════════════════════════════════════════════════════════
  // 5. sessions — 会话管理
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      scope           TEXT NOT NULL,
      scope_id        TEXT,
      context         TEXT DEFAULT '{}',
      metadata        TEXT DEFAULT '{}',
      actor           TEXT,
      created_at      INTEGER NOT NULL,
      last_active_at  INTEGER,
      expired_at      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_scope    ON sessions(scope);
    CREATE INDEX IF NOT EXISTS idx_sessions_actor    ON sessions(actor);
    CREATE INDEX IF NOT EXISTS idx_sessions_expired  ON sessions(expired_at);
  `);

  // ═══════════════════════════════════════════════════════════════
  // 6. token_usage — AI Token 消耗记录
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       INTEGER NOT NULL,
      source          TEXT NOT NULL DEFAULT 'unknown',
      dimension       TEXT,
      provider        TEXT,
      model           TEXT,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      total_tokens    INTEGER NOT NULL DEFAULT 0,
      duration_ms     INTEGER,
      tool_calls      INTEGER DEFAULT 0,
      session_id      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_usage_source    ON token_usage(source);
  `);

  // ═══════════════════════════════════════════════════════════════
  // 7. semantic_memories — 项目级语义记忆
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_memories (
      id                TEXT PRIMARY KEY,
      type              TEXT NOT NULL DEFAULT 'fact',
      content           TEXT NOT NULL DEFAULT '',
      source            TEXT NOT NULL DEFAULT 'bootstrap',
      importance        REAL NOT NULL DEFAULT 5.0,
      access_count      INTEGER NOT NULL DEFAULT 0,
      last_accessed_at  TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      expires_at        TEXT,

      related_entities  TEXT DEFAULT '[]',
      related_memories  TEXT DEFAULT '[]',

      source_dimension  TEXT,
      source_evidence   TEXT,

      bootstrap_session TEXT,
      tags              TEXT DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_semantic_memories_type ON semantic_memories(type);
    CREATE INDEX IF NOT EXISTS idx_semantic_memories_source ON semantic_memories(source);
    CREATE INDEX IF NOT EXISTS idx_semantic_memories_importance ON semantic_memories(importance DESC);
    CREATE INDEX IF NOT EXISTS idx_semantic_memories_updated_at ON semantic_memories(updated_at);
    CREATE INDEX IF NOT EXISTS idx_semantic_memories_source_dimension ON semantic_memories(source_dimension);
  `);

  // ═══════════════════════════════════════════════════════════════
  // 8. bootstrap_snapshots + bootstrap_dim_files
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS bootstrap_snapshots (
      id               TEXT PRIMARY KEY,
      session_id       TEXT,
      project_root     TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      duration_ms      INTEGER DEFAULT 0,
      file_count       INTEGER DEFAULT 0,
      dimension_count  INTEGER DEFAULT 0,
      candidate_count  INTEGER DEFAULT 0,
      primary_lang     TEXT,

      file_hashes      TEXT NOT NULL DEFAULT '{}',
      dimension_meta   TEXT NOT NULL DEFAULT '{}',
      episodic_data    TEXT,

      is_incremental   INTEGER DEFAULT 0,
      parent_id        TEXT,
      changed_files    TEXT DEFAULT '[]',
      affected_dims    TEXT DEFAULT '[]',

      status           TEXT DEFAULT 'complete'
    );

    CREATE TABLE IF NOT EXISTS bootstrap_dim_files (
      snapshot_id      TEXT NOT NULL,
      dim_id           TEXT NOT NULL,
      file_path        TEXT NOT NULL,
      role             TEXT DEFAULT 'referenced',

      PRIMARY KEY (snapshot_id, dim_id, file_path),
      FOREIGN KEY (snapshot_id) REFERENCES bootstrap_snapshots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_project  ON bootstrap_snapshots(project_root, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshots_status    ON bootstrap_snapshots(status);
    CREATE INDEX IF NOT EXISTS idx_dim_files_file      ON bootstrap_dim_files(file_path);
    CREATE INDEX IF NOT EXISTS idx_dim_files_dim       ON bootstrap_dim_files(dim_id);
  `);

  // ═══════════════════════════════════════════════════════════════
  // 9. code_entities — 代码实体节点 (AST)
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_entities (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id     TEXT NOT NULL,
      entity_type   TEXT NOT NULL,
      project_root  TEXT NOT NULL,
      name          TEXT NOT NULL,
      file_path     TEXT,
      line_number   INTEGER,
      superclass    TEXT,
      protocols     TEXT DEFAULT '[]',
      metadata_json TEXT DEFAULT '{}',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      UNIQUE (entity_id, entity_type, project_root)
    );

    CREATE INDEX IF NOT EXISTS idx_ce_project    ON code_entities(project_root);
    CREATE INDEX IF NOT EXISTS idx_ce_type       ON code_entities(entity_type);
    CREATE INDEX IF NOT EXISTS idx_ce_name       ON code_entities(name);
    CREATE INDEX IF NOT EXISTS idx_ce_file       ON code_entities(file_path);
    CREATE INDEX IF NOT EXISTS idx_ce_superclass ON code_entities(superclass);
  `);

  process.stderr.write('  ✅ 001: Initial V3 schema created (10 tables)\n');
}

/**
 * Drizzle ORM Schema — Single Source of Truth
 *
 * 所有表定义从 migration 001-003 忠实翻译。
 * DB 列名与 migration 保持一致；实体映射由 repository 层处理。
 *
 * 表清单 (16):
 *   001: knowledge_entries, knowledge_edges, guard_violations, audit_logs,
 *        sessions, token_usage, semantic_memories, bootstrap_snapshots,
 *        bootstrap_dim_files, code_entities
 *   002: tasks, task_dependencies, task_events
 *   003: remote_commands
 *   内联: remote_state
 *   内部: schema_migrations
 */

import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ═══════════════════════════════════════════════════════════════
// 内部 — schema_migrations
// ═══════════════════════════════════════════════════════════════

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: text('version').primaryKey(),
  appliedAt: text('applied_at').notNull(),
});

// ═══════════════════════════════════════════════════════════════
// 1. knowledge_entries — 核心知识条目
// ═══════════════════════════════════════════════════════════════

export const knowledgeEntries = sqliteTable(
  'knowledge_entries',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default(''),
    description: text('description').default(''),

    lifecycle: text('lifecycle').notNull().default('pending'),
    lifecycleHistory: text('lifecycleHistory').default('[]'),
    autoApprovable: integer('autoApprovable').default(0),

    language: text('language').notNull().default(''),
    category: text('category').notNull().default('general'),
    kind: text('kind').default('pattern'),
    knowledgeType: text('knowledgeType').default('code-pattern'),
    complexity: text('complexity').default('intermediate'),
    scope: text('scope').default('universal'),
    difficulty: text('difficulty'),
    tags: text('tags').default('[]'),

    // Cursor 交付字段
    trigger: text('trigger').default(''),
    topicHint: text('topicHint').default(''),
    whenClause: text('whenClause').default(''),
    doClause: text('doClause').default(''),
    dontClause: text('dontClause').default(''),
    coreCode: text('coreCode').default(''),

    // 值对象 (JSON)
    content: text('content').default('{}'),
    relations: text('relations').default('{}'),
    constraints: text('constraints').default('{}'),
    reasoning: text('reasoning').default('{}'),
    quality: text('quality').default('{}'),
    stats: text('stats').default('{}'),

    // ObjC/Swift headers
    headers: text('headers').default('[]'),
    headerPaths: text('headerPaths').default('[]'),
    moduleName: text('moduleName').default(''),
    includeHeaders: integer('includeHeaders').default(0),

    // AI notes
    agentNotes: text('agentNotes'),
    aiInsight: text('aiInsight'),

    // Review
    reviewedBy: text('reviewedBy'),
    reviewedAt: integer('reviewedAt'),
    rejectionReason: text('rejectionReason'),

    // Source
    source: text('source').default('agent'),
    sourceFile: text('sourceFile'),
    sourceCandidateId: text('sourceCandidateId'),

    // Timestamps
    createdBy: text('createdBy').default('agent'),
    createdAt: integer('createdAt').notNull(),
    updatedAt: integer('updatedAt').notNull(),
    publishedAt: integer('publishedAt'),
    publishedBy: text('publishedBy'),

    // Content hash
    contentHash: text('contentHash'),
  },
  (table) => [
    index('idx_ke3_lifecycle').on(table.lifecycle),
    index('idx_ke3_language').on(table.language),
    index('idx_ke3_category').on(table.category),
    index('idx_ke3_kind').on(table.kind),
    index('idx_ke3_createdAt').on(table.createdAt),
    index('idx_ke3_trigger').on(table.trigger),
    index('idx_ke3_title').on(table.title),
    index('idx_ke3_source').on(table.source),
    index('idx_ke3_guard_active').on(table.kind, table.lifecycle),
    index('idx_ke3_topicHint').on(table.topicHint),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 2. knowledge_edges — 知识关系图谱边
// ═══════════════════════════════════════════════════════════════

export const knowledgeEdges = sqliteTable(
  'knowledge_edges',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fromId: text('from_id').notNull(),
    fromType: text('from_type').notNull().default('recipe'),
    toId: text('to_id').notNull(),
    toType: text('to_type').notNull().default('recipe'),
    relation: text('relation').notNull(),
    weight: real('weight').default(1.0),
    metadataJson: text('metadata_json').default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('knowledge_edges_unique').on(
      table.fromId,
      table.fromType,
      table.toId,
      table.toType,
      table.relation
    ),
    index('idx_ke_from').on(table.fromId, table.fromType),
    index('idx_ke_to').on(table.toId, table.toType),
    index('idx_ke_relation').on(table.relation),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 3. guard_violations — Guard 违反记录
// ═══════════════════════════════════════════════════════════════

export const guardViolations = sqliteTable(
  'guard_violations',
  {
    id: text('id').primaryKey(),
    filePath: text('file_path').notNull(),
    triggeredAt: text('triggered_at').notNull(),
    violationCount: integer('violation_count').default(0),
    summary: text('summary'),
    violationsJson: text('violations_json').default('[]'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_guard_violations_file').on(table.filePath),
    index('idx_guard_violations_time').on(table.triggeredAt),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 4. audit_logs — 审计日志
// ═══════════════════════════════════════════════════════════════

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    timestamp: integer('timestamp').notNull(),
    actor: text('actor').notNull(),
    actorContext: text('actor_context').default('{}'),
    action: text('action').notNull(),
    resource: text('resource'),
    operationData: text('operation_data').default('{}'),
    result: text('result').notNull(),
    errorMessage: text('error_message'),
    duration: integer('duration'),
  },
  (table) => [
    index('idx_audit_actor').on(table.actor),
    index('idx_audit_action').on(table.action),
    index('idx_audit_result').on(table.result),
    index('idx_audit_timestamp').on(table.timestamp),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 5. sessions — 会话管理
// ═══════════════════════════════════════════════════════════════

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    scopeId: text('scope_id'),
    context: text('context').default('{}'),
    metadata: text('metadata').default('{}'),
    actor: text('actor'),
    createdAt: integer('created_at').notNull(),
    lastActiveAt: integer('last_active_at'),
    expiredAt: integer('expired_at'),
  },
  (table) => [
    index('idx_sessions_scope').on(table.scope),
    index('idx_sessions_actor').on(table.actor),
    index('idx_sessions_expired').on(table.expiredAt),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 6. token_usage — AI Token 消耗记录
// ═══════════════════════════════════════════════════════════════

export const tokenUsage = sqliteTable(
  'token_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    timestamp: integer('timestamp').notNull(),
    source: text('source').notNull().default('unknown'),
    dimension: text('dimension'),
    provider: text('provider'),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    durationMs: integer('duration_ms'),
    toolCalls: integer('tool_calls').default(0),
    sessionId: text('session_id'),
  },
  (table) => [
    index('idx_token_usage_timestamp').on(table.timestamp),
    index('idx_token_usage_source').on(table.source),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 7. semantic_memories — 项目级语义记忆
// ═══════════════════════════════════════════════════════════════

export const semanticMemories = sqliteTable(
  'semantic_memories',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull().default('fact'),
    content: text('content').notNull().default(''),
    source: text('source').notNull().default('bootstrap'),
    importance: real('importance').notNull().default(5.0),
    accessCount: integer('access_count').notNull().default(0),
    lastAccessedAt: text('last_accessed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    expiresAt: text('expires_at'),
    relatedEntities: text('related_entities').default('[]'),
    relatedMemories: text('related_memories').default('[]'),
    sourceDimension: text('source_dimension'),
    sourceEvidence: text('source_evidence'),
    bootstrapSession: text('bootstrap_session'),
    tags: text('tags').default('[]'),
  },
  (table) => [
    index('idx_semantic_memories_type').on(table.type),
    index('idx_semantic_memories_source').on(table.source),
    index('idx_semantic_memories_importance').on(table.importance),
    index('idx_semantic_memories_updated_at').on(table.updatedAt),
    index('idx_semantic_memories_source_dimension').on(table.sourceDimension),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 8. bootstrap_snapshots — Bootstrap 快照主表
// ═══════════════════════════════════════════════════════════════

export const bootstrapSnapshots = sqliteTable(
  'bootstrap_snapshots',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id'),
    projectRoot: text('project_root').notNull(),
    createdAt: text('created_at').notNull(),
    durationMs: integer('duration_ms').default(0),
    fileCount: integer('file_count').default(0),
    dimensionCount: integer('dimension_count').default(0),
    candidateCount: integer('candidate_count').default(0),
    primaryLang: text('primary_lang'),
    fileHashes: text('file_hashes').notNull().default('{}'),
    dimensionMeta: text('dimension_meta').notNull().default('{}'),
    episodicData: text('episodic_data'),
    isIncremental: integer('is_incremental').default(0),
    parentId: text('parent_id'),
    changedFiles: text('changed_files').default('[]'),
    affectedDims: text('affected_dims').default('[]'),
    status: text('status').default('complete'),
  },
  (table) => [
    index('idx_snapshots_project').on(table.projectRoot, table.createdAt),
    index('idx_snapshots_status').on(table.status),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 9. bootstrap_dim_files — 维度-文件关联表
// ═══════════════════════════════════════════════════════════════

export const bootstrapDimFiles = sqliteTable(
  'bootstrap_dim_files',
  {
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => bootstrapSnapshots.id, { onDelete: 'cascade' }),
    dimId: text('dim_id').notNull(),
    filePath: text('file_path').notNull(),
    role: text('role').default('referenced'),
  },
  (table) => [
    // composite primary key emulated via unique index
    uniqueIndex('bootstrap_dim_files_pk').on(table.snapshotId, table.dimId, table.filePath),
    index('idx_dim_files_file').on(table.filePath),
    index('idx_dim_files_dim').on(table.dimId),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 10. code_entities — 代码实体节点 (AST)
// ═══════════════════════════════════════════════════════════════

export const codeEntities = sqliteTable(
  'code_entities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entityId: text('entity_id').notNull(),
    entityType: text('entity_type').notNull(),
    projectRoot: text('project_root').notNull(),
    name: text('name').notNull(),
    filePath: text('file_path'),
    lineNumber: integer('line_number'),
    superclass: text('superclass'),
    protocols: text('protocols').default('[]'),
    metadataJson: text('metadata_json').default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('code_entities_unique').on(table.entityId, table.entityType, table.projectRoot),
    index('idx_ce_project').on(table.projectRoot),
    index('idx_ce_type').on(table.entityType),
    index('idx_ce_name').on(table.name),
    index('idx_ce_file').on(table.filePath),
    index('idx_ce_superclass').on(table.superclass),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 11. tasks — 任务表 (migration 002)
// ═══════════════════════════════════════════════════════════════

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id'),
    childSeq: integer('child_seq').default(0),

    title: text('title').notNull(),
    description: text('description').default(''),
    design: text('design').default(''),
    acceptance: text('acceptance').default(''),
    notes: text('notes').default(''),

    status: text('status').notNull().default('open'),
    priority: integer('priority').notNull().default(2),
    taskType: text('task_type').notNull().default('task'),
    closeReason: text('close_reason').default(''),
    contentHash: text('content_hash').default(''),
    failCount: integer('fail_count').default(0),
    lastFailReason: text('last_fail_reason').default(''),

    assignee: text('assignee').default(''),
    createdBy: text('created_by').default('agent'),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    closedAt: integer('closed_at'),

    metadata: text('metadata').default('{}'),
  },
  (table) => [
    index('idx_tasks_status').on(table.status),
    index('idx_tasks_priority').on(table.priority),
    index('idx_tasks_parent').on(table.parentId),
    index('idx_tasks_type').on(table.taskType),
    index('idx_tasks_assignee').on(table.assignee),
    index('idx_tasks_created').on(table.createdAt),
    index('idx_tasks_hash').on(table.contentHash),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 12. task_dependencies — 任务依赖表 (migration 002)
// ═══════════════════════════════════════════════════════════════

export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: text('task_id').notNull(),
    dependsOnId: text('depends_on_id').notNull(),
    depType: text('dep_type').notNull().default('blocks'),
    metadata: text('metadata').default('{}'),
    createdAt: integer('created_at').notNull(),
    createdBy: text('created_by').default('agent'),
  },
  (table) => [
    uniqueIndex('task_dependencies_unique').on(table.taskId, table.dependsOnId, table.depType),
    index('idx_td_task').on(table.taskId),
    index('idx_td_depends_on').on(table.dependsOnId),
    index('idx_td_type').on(table.depType),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 13. task_events — 任务事件审计表 (migration 002)
// ═══════════════════════════════════════════════════════════════

export const taskEvents = sqliteTable(
  'task_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: text('task_id').notNull(),
    eventType: text('event_type').notNull(),
    actor: text('actor').default('agent'),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    comment: text('comment'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_te_task').on(table.taskId),
    index('idx_te_type').on(table.eventType),
    index('idx_te_created').on(table.createdAt),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 14. remote_commands — 远程指令队列 (migration 003)
// ═══════════════════════════════════════════════════════════════

export const remoteCommands = sqliteTable(
  'remote_commands',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull().default('lark'),
    chatId: text('chat_id'),
    messageId: text('message_id'),
    userId: text('user_id'),
    userName: text('user_name'),
    command: text('command').notNull(),
    status: text('status').notNull().default('pending'),
    result: text('result'),
    createdAt: integer('created_at').notNull(),
    claimedAt: integer('claimed_at'),
    completedAt: integer('completed_at'),
  },
  (table) => [
    index('idx_remote_commands_status').on(table.status),
    index('idx_remote_commands_created').on(table.createdAt),
  ]
);

// ═══════════════════════════════════════════════════════════════
// 15. remote_state — 远程状态 (路由内联创建)
// ═══════════════════════════════════════════════════════════════

export const remoteState = sqliteTable('remote_state', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: integer('updated_at'),
});

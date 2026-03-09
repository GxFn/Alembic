/**
 * MemoryStore — 持久化记忆 SQLite 存储层
 *
 * 从 PersistentMemory.js 提取的 CRUD + SQL 基础设施。
 * 负责:
 *   - 表结构确保 (#ensureTable)
 *   - SQL 预编译 (#prepareStatements)
 *   - 基本 CRUD: add, update, delete, get
 *   - 批量查询: getAllActive, size, getStats
 *   - 访问计数: touchAccess
 *   - 容量控制: enforceCapacity
 *   - 维护: compact
 *   - 统计: getStats, clearBootstrapMemories
 *
 * 设计原则:
 *   - 拥有 #db 和 #stmts，其他组件通过 MemoryStore 访问数据
 *   - update() 使用动态 SQL 但通过 named parameters 防注入
 *   - 数据序列化/反序列化统一在此层处理
 *
 * @module MemoryStore
 */

import { randomUUID } from 'node:crypto';
import { jaccardSimilarity, tokenizeForSimilarity } from '#shared/similarity.js';

// ─── 类型定义 ──────────────────────────────────────────

/** better-sqlite3 Database 结构接口 */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
}

/** better-sqlite3 Statement 结构接口 */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** 数据库行 (raw row from SQLite) */
export interface MemoryRow {
  id: string;
  type: string;
  content: string;
  source: string;
  importance: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  related_entities: string;
  related_memories: string;
  source_dimension: string | null;
  source_evidence: string | null;
  bootstrap_session: string | null;
  tags: string;
  /** 向量嵌入 (Float32Array BLOB) */
  embedding: Buffer | null;
  /** findSimilar 附加字段 */
  similarity?: number;
  related_memories_raw?: string;
}

/** 反序列化后的记忆对象 */
export interface DeserializedMemory {
  id: string;
  type: string;
  content: string;
  source: string;
  importance: number;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  relatedEntities: string[];
  relatedMemories: string[];
  sourceDimension: string | null;
  sourceEvidence: string | null;
  bootstrapSession: string | null;
  tags: string[];
  /** 向量嵌入 (Float32Array) */
  embedding: number[] | null;
}

/** 添加记忆时的输入 */
export interface MemoryInput {
  type?: string;
  content: string;
  source?: string;
  importance?: number;
  ttlDays?: number | null;
  relatedEntities?: string[];
  sourceDimension?: string | null;
  sourceEvidence?: string | null;
  bootstrapSession?: string | null;
  tags?: string[];
  /** 向量嵌入 */
  embedding?: number[] | null;
}

/** 更新记忆时的字段 */
export interface MemoryUpdates {
  content?: string;
  importance?: number;
  accessCount?: number;
  relatedEntities?: string[];
  relatedMemories?: string[];
  tags?: string[];
  /** 向量嵌入 */
  embedding?: number[] | null;
}

/** 预编译语句集合 */
interface PreparedStatements {
  insert: SqliteStatement;
  getById: SqliteStatement;
  deleteById: SqliteStatement;
  touchAccess: SqliteStatement;
  getAllActive: SqliteStatement;
  getAllActiveBySource: SqliteStatement;
  getAllActiveByType: SqliteStatement;
  getAllActiveBySourceAndType: SqliteStatement;
  getByContent: SqliteStatement;
  getAll: SqliteStatement;
}

// ─── 常量 ──────────────────────────────────────────────

/** 最大记忆条数 (防止无限膨胀) */
const MAX_MEMORIES = 500;

/** 自然遗忘阈值 */
const ARCHIVE_DAYS = 30;
const FORGET_DAYS = 90;

export class MemoryStore {
  /** @type {import('better-sqlite3').Database} */
  #db: SqliteDatabase;

  /** @type {object} 预编译 SQL Statements */
  #stmts: PreparedStatements = null!;

  /** @type {Map<string, SqliteStatement>} 动态 update SQL 缓存 */
  #updateStmtCache = new Map<string, SqliteStatement>();

  /**
   * @param {import('better-sqlite3').Database} db - better-sqlite3 实例 (raw)
   */
  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#ensureTable();
    this.#prepareStatements();
  }

  /** 获取原始 db 引用 (for transaction) */
  get db() {
    return this.#db;
  }

  // ═══════════════════════════════════════════════════════════
  // 基本 CRUD
  // ═══════════════════════════════════════════════════════════

  /**
   * 添加一条记忆
   * @param {object} memory
   * @returns {{ id: string, action: string }}
   */
  add(memory: MemoryInput) {
    const id = `smem_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
    const now = new Date().toISOString();
    const content = (memory.content || '').trim().substring(0, 500);
    const importance = Math.max(1, Math.min(10, memory.importance || 5));
    const expiresAt = memory.ttlDays
      ? new Date(Date.now() + memory.ttlDays * 86400_000).toISOString()
      : null;

    this.#stmts.insert.run({
      id,
      type: memory.type || 'fact',
      content,
      source: memory.source || 'bootstrap',
      importance,
      access_count: 0,
      last_accessed_at: now,
      created_at: now,
      updated_at: now,
      expires_at: expiresAt,
      related_entities: JSON.stringify(memory.relatedEntities || []),
      related_memories: JSON.stringify([]),
      source_dimension: memory.sourceDimension || null,
      source_evidence: memory.sourceEvidence || null,
      bootstrap_session: memory.bootstrapSession || null,
      tags: JSON.stringify(memory.tags || []),
      embedding: memory.embedding ? MemoryStore.serializeEmbedding(memory.embedding) : null,
    });

    return { id, action: 'ADD' };
  }

  /**
   * 更新已有记忆
   * @param {string} id
   * @param {object} updates
   * @returns {boolean}
   */
  update(id: string, updates: MemoryUpdates) {
    const existing = this.#stmts.getById.get(id) as MemoryRow | undefined;
    if (!existing) {
      return false;
    }

    const now = new Date().toISOString();
    const fields: string[] = [];
    const params: Record<string, unknown> = { id };

    if (updates.content !== undefined) {
      fields.push('content = @content');
      params.content = updates.content.substring(0, 500);
    }
    if (updates.importance !== undefined) {
      fields.push('importance = @importance');
      params.importance = Math.max(1, Math.min(10, updates.importance));
    }
    if (updates.accessCount !== undefined) {
      fields.push('access_count = @access_count');
      params.access_count = updates.accessCount;
    }
    if (updates.relatedEntities !== undefined) {
      fields.push('related_entities = @related_entities');
      params.related_entities = JSON.stringify(updates.relatedEntities);
    }
    if (updates.relatedMemories !== undefined) {
      fields.push('related_memories = @related_memories');
      params.related_memories = JSON.stringify(updates.relatedMemories);
    }
    if (updates.tags !== undefined) {
      fields.push('tags = @tags');
      params.tags = JSON.stringify(updates.tags);
    }

    if (fields.length === 0) {
      return false;
    }

    fields.push('updated_at = @updated_at');
    params.updated_at = now;

    // 使用缓存的 prepared statement，避免每次 update 都 prepare 新 SQL
    const cacheKey = fields.join(',');
    let stmt = this.#updateStmtCache.get(cacheKey);
    if (!stmt) {
      const sql = `UPDATE semantic_memories SET ${fields.join(', ')} WHERE id = @id`;
      stmt = this.#db.prepare(sql);
      this.#updateStmtCache.set(cacheKey, stmt);
    }
    stmt.run(params);
    return true;
  }

  /**
   * 删除一条记忆
   * @param {string} id
   * @returns {boolean}
   */
  delete(id: string) {
    const result = this.#stmts.deleteById.run(id);
    return result.changes > 0;
  }

  /**
   * 按 ID 获取
   * @param {string} id
   * @returns {object|null}
   */
  get(id: string): DeserializedMemory | null {
    const row = this.#stmts.getById.get(id) as MemoryRow | undefined;
    return row ? MemoryStore.deserialize(row) : null;
  }

  // ═══════════════════════════════════════════════════════════
  // 批量查询
  // ═══════════════════════════════════════════════════════════

  /**
   * 获取所有活跃记忆 (未过期)
   * @param {object} [opts]
   * @param {string} [opts.source]
   * @param {string} [opts.type]
   * @returns {Array<object>} raw rows
   */
  getAllActive({ source, type }: { source?: string; type?: string } = {}): MemoryRow[] {
    const now = new Date().toISOString();
    if (source && type) {
      return this.#stmts.getAllActiveBySourceAndType.all({
        now,
        source,
        type,
      }) as unknown as MemoryRow[];
    }
    if (source) {
      return this.#stmts.getAllActiveBySource.all({ now, source }) as unknown as MemoryRow[];
    }
    if (type) {
      return this.#stmts.getAllActiveByType.all({ now, type }) as unknown as MemoryRow[];
    }
    return this.#stmts.getAllActive.all({ now }) as unknown as MemoryRow[];
  }

  /**
   * 获取候选记忆 (用于相似度搜索)
   * @param {string|null} type
   * @returns {Array<object>}
   */
  getCandidates(type: string | null): MemoryRow[] {
    const now = new Date().toISOString();
    return (type
      ? this.#stmts.getByContent.all({ type, now })
      : this.#stmts.getAll.all({ now })) as unknown as MemoryRow[];
  }

  /**
   * 更新访问计数
   * @param {string} id
   */
  touchAccess(id: string) {
    try {
      this.#stmts.touchAccess.run({ id, now: new Date().toISOString() });
    } catch {
      /* non-critical */
    }
  }

  /**
   * 记忆总数
   * @param {object} [opts]
   * @param {string} [opts.source]
   * @returns {number}
   */
  size({ source }: { source?: string } = {}) {
    if (source) {
      return (
        (
          this.#db
            .prepare('SELECT COUNT(*) as cnt FROM semantic_memories WHERE source = ?')
            .get(source) as { cnt: number } | undefined
        )?.cnt || 0
      );
    }
    return (
      (
        this.#db.prepare('SELECT COUNT(*) as cnt FROM semantic_memories').get() as
          | { cnt: number }
          | undefined
      )?.cnt || 0
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 维护
  // ═══════════════════════════════════════════════════════════

  /**
   * 执行维护: 清理过期记忆 + 容量控制
   * @returns {{ expired: number, forgotten: number, archived: number, remaining: number }}
   */
  compact() {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const stats = { expired: 0, forgotten: 0, archived: 0, remaining: 0 };

    const runCompact = this.#db.transaction(() => {
      const expiredResult = this.#db
        .prepare('DELETE FROM semantic_memories WHERE expires_at IS NOT NULL AND expires_at < ?')
        .run(now);
      stats.expired = expiredResult.changes;

      const forgetThreshold = new Date(nowMs - FORGET_DAYS * 86400_000).toISOString();
      const forgottenResult = this.#db
        .prepare('DELETE FROM semantic_memories WHERE last_accessed_at < ? AND importance < 7')
        .run(forgetThreshold);
      stats.forgotten = forgottenResult.changes;

      const archiveThreshold = new Date(nowMs - ARCHIVE_DAYS * 86400_000).toISOString();
      const archiveResult = this.#db
        .prepare(
          'UPDATE semantic_memories SET importance = MAX(1, importance - 1) WHERE last_accessed_at < ? AND importance < 3'
        )
        .run(archiveThreshold);
      stats.archived = archiveResult.changes;

      stats.remaining =
        (
          this.#db.prepare('SELECT COUNT(*) as cnt FROM semantic_memories').get() as
            | { cnt: number }
            | undefined
        )?.cnt || 0;
    });

    runCompact();
    return stats;
  }

  /**
   * 容量控制
   */
  enforceCapacity() {
    const count =
      (
        this.#db.prepare('SELECT COUNT(*) as cnt FROM semantic_memories').get() as
          | { cnt: number }
          | undefined
      )?.cnt || 0;
    if (count <= MAX_MEMORIES) {
      return;
    }

    const excess = count - MAX_MEMORIES;
    this.#db
      .prepare(`
      DELETE FROM semantic_memories WHERE id IN (
        SELECT id FROM semantic_memories
        ORDER BY importance ASC, access_count ASC, updated_at ASC
        LIMIT ?
      )
    `)
      .run(excess);
  }

  /**
   * 获取统计信息
   * @returns {object}
   */
  getStats() {
    const total =
      (
        this.#db.prepare('SELECT COUNT(*) as cnt FROM semantic_memories').get() as
          | { cnt: number }
          | undefined
      )?.cnt || 0;
    const byType = this.#db
      .prepare('SELECT type, COUNT(*) as cnt FROM semantic_memories GROUP BY type')
      .all() as Array<{ type: string; cnt: number }>;
    const bySource = this.#db
      .prepare('SELECT source, COUNT(*) as cnt FROM semantic_memories GROUP BY source')
      .all() as Array<{ source: string; cnt: number }>;
    const avgImportance =
      (
        this.#db.prepare('SELECT AVG(importance) as avg FROM semantic_memories').get() as
          | { avg: number }
          | undefined
      )?.avg || 0;

    return {
      total,
      byType: Object.fromEntries(byType.map((r) => [r.type, r.cnt])),
      bySource: Object.fromEntries(bySource.map((r) => [r.source, r.cnt])),
      avgImportance: Math.round(avgImportance * 10) / 10,
    };
  }

  /**
   * 清除所有 bootstrap 来源的记忆
   * @returns {number}
   */
  clearBootstrapMemories() {
    const result = this.#db
      .prepare("DELETE FROM semantic_memories WHERE source = 'bootstrap'")
      .run();
    return result.changes;
  }

  // ═══════════════════════════════════════════════════════════
  // 相似度搜索
  // ═══════════════════════════════════════════════════════════

  /**
   * 查找相似记忆 (基于 token overlap)
   * @param {string} content 搜索文本
   * @param {string|null} type 过滤 type (null=全部)
   * @param {number} limit 返回条数
   * @returns {Array<object>} 带 similarity 和 related_memories_raw 字段的 raw rows
   */
  findSimilar(content: string, type: string | null, limit: number): MemoryRow[] {
    const candidates = this.getCandidates(type);
    const lowerContent = content.toLowerCase();
    const contentTokens = tokenizeForSimilarity(lowerContent) as Set<string>;

    const scored = candidates
      .map((row) => {
        const similarity = MemoryStore.computeSimilarity(contentTokens, lowerContent, row.content);
        return { ...row, similarity, related_memories_raw: row.related_memories };
      })
      .filter((r) => r.similarity > 0.1)
      .sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, limit);
  }

  /**
   * 计算两段文本的相似度 (Jaccard + 子串匹配)
   * @param {Set<string>} tokensA
   * @param {string} lowerA
   * @param {string} contentB
   * @returns {number} 0.0-1.0
   */
  static computeSimilarity(tokensA: Set<string>, lowerA: string, contentB: string): number {
    const lowerB = (contentB || '').toLowerCase();
    const tokensB = tokenizeForSimilarity(lowerB);

    if (tokensA.size === 0 && tokensB.size === 0) {
      return 1.0;
    }
    if (tokensA.size === 0 || tokensB.size === 0) {
      return 0.0;
    }

    const jaccard = jaccardSimilarity(tokensA, tokensB);
    const containsBonus = lowerA.includes(lowerB) || lowerB.includes(lowerA) ? 0.3 : 0;
    return Math.min(1.0, jaccard + containsBonus);
  }

  /**
   * 创建 transaction wrapper
   * @param {Function} fn
   * @returns {Function}
   */
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    return this.#db.transaction(fn);
  }

  // ═══════════════════════════════════════════════════════════
  // 序列化
  // ═══════════════════════════════════════════════════════════

  /**
   * 反序列化数据库行为域对象
   * @param {object} row
   * @returns {object}
   */
  static deserialize(row: MemoryRow): DeserializedMemory {
    return {
      id: row.id,
      type: row.type,
      content: row.content,
      source: row.source,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      relatedEntities: MemoryStore.safeParseJSON(row.related_entities, []),
      relatedMemories: MemoryStore.safeParseJSON(row.related_memories, []),
      sourceDimension: row.source_dimension,
      sourceEvidence: row.source_evidence,
      bootstrapSession: row.bootstrap_session,
      tags: MemoryStore.safeParseJSON(row.tags, []),
      embedding: row.embedding ? MemoryStore.deserializeEmbedding(row.embedding) : null,
    };
  }

  static safeParseJSON<T>(str: string | null | undefined, fallback: T): T {
    try {
      return str ? JSON.parse(str) : fallback;
    } catch {
      return fallback;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 向量嵌入存储
  // ═══════════════════════════════════════════════════════════

  /**
   * 更新单条记忆的向量嵌入
   * @param id 记忆 ID
   * @param embedding 向量数组
   */
  updateEmbedding(id: string, embedding: number[]): boolean {
    const blob = MemoryStore.serializeEmbedding(embedding);
    const result = this.#db
      .prepare('UPDATE semantic_memories SET embedding = ? WHERE id = ?')
      .run(blob, id);
    return result.changes > 0;
  }

  /**
   * 批量更新向量嵌入
   * @param entries Array of { id, embedding }
   */
  batchUpdateEmbeddings(entries: Array<{ id: string; embedding: number[] }>): number {
    let updated = 0;
    const stmt = this.#db.prepare('UPDATE semantic_memories SET embedding = ? WHERE id = ?');
    const runBatch = this.#db.transaction(() => {
      for (const entry of entries) {
        const blob = MemoryStore.serializeEmbedding(entry.embedding);
        const result = stmt.run(blob, entry.id);
        updated += result.changes;
      }
    });
    runBatch();
    return updated;
  }

  /**
   * 获取缺少向量嵌入的记忆 ID 和内容
   * @param limit 最大返回数
   */
  getWithoutEmbedding(limit = 50): Array<{ id: string; content: string }> {
    return this.#db
      .prepare(
        'SELECT id, content FROM semantic_memories WHERE embedding IS NULL ORDER BY updated_at DESC LIMIT ?'
      )
      .all(limit) as Array<{ id: string; content: string }>;
  }

  /**
   * 将 number[] 序列化为 Buffer (Float32Array → BLOB)
   */
  static serializeEmbedding(embedding: number[]): Buffer {
    const float32 = new Float32Array(embedding);
    return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
  }

  /**
   * 将 Buffer (BLOB) 反序列化为 number[]
   */
  static deserializeEmbedding(blob: Buffer): number[] {
    const float32 = new Float32Array(
      blob.buffer,
      blob.byteOffset,
      blob.byteLength / Float32Array.BYTES_PER_ELEMENT
    );
    return Array.from(float32);
  }

  // ═══════════════════════════════════════════════════════════
  // Private: DB 基础设施
  // ═══════════════════════════════════════════════════════════

  #ensureTable() {
    const exists = this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='semantic_memories'")
      .get();

    if (!exists) {
      this.#db.exec(`
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
          tags              TEXT DEFAULT '[]',
          embedding         BLOB
        )
      `);
    } else {
      // 迁移: 为已有表添加 embedding 列
      try {
        this.#db.prepare('SELECT embedding FROM semantic_memories LIMIT 1').get();
      } catch {
        this.#db.exec('ALTER TABLE semantic_memories ADD COLUMN embedding BLOB');
      }
    }
  }

  #prepareStatements() {
    this.#stmts = {
      insert: this.#db.prepare(`
        INSERT INTO semantic_memories
          (id, type, content, source, importance, access_count,
           last_accessed_at, created_at, updated_at, expires_at,
           related_entities, related_memories,
           source_dimension, source_evidence, bootstrap_session, tags, embedding)
        VALUES
          (@id, @type, @content, @source, @importance, @access_count,
           @last_accessed_at, @created_at, @updated_at, @expires_at,
           @related_entities, @related_memories,
           @source_dimension, @source_evidence, @bootstrap_session, @tags, @embedding)
      `),

      getById: this.#db.prepare('SELECT * FROM semantic_memories WHERE id = ?'),
      deleteById: this.#db.prepare('DELETE FROM semantic_memories WHERE id = ?'),

      touchAccess: this.#db.prepare(`
        UPDATE semantic_memories
        SET access_count = access_count + 1,
            last_accessed_at = @now
        WHERE id = @id
      `),

      getAllActive: this.#db.prepare(`
        SELECT * FROM semantic_memories
        WHERE (expires_at IS NULL OR expires_at > @now)
        ORDER BY updated_at DESC
      `),
      getAllActiveBySource: this.#db.prepare(`
        SELECT * FROM semantic_memories
        WHERE (expires_at IS NULL OR expires_at > @now)
          AND source = @source
        ORDER BY updated_at DESC
      `),
      getAllActiveByType: this.#db.prepare(`
        SELECT * FROM semantic_memories
        WHERE (expires_at IS NULL OR expires_at > @now)
          AND type = @type
        ORDER BY updated_at DESC
      `),
      getAllActiveBySourceAndType: this.#db.prepare(`
        SELECT * FROM semantic_memories
        WHERE (expires_at IS NULL OR expires_at > @now)
          AND source = @source
          AND type = @type
        ORDER BY updated_at DESC
      `),
      getByContent: this.#db.prepare(`
        SELECT * FROM semantic_memories
        WHERE type = @type
          AND (expires_at IS NULL OR expires_at > @now)
        ORDER BY updated_at DESC
        LIMIT 50
      `),
      getAll: this.#db.prepare(`
        SELECT * FROM semantic_memories
        WHERE (expires_at IS NULL OR expires_at > @now)
        ORDER BY updated_at DESC
        LIMIT 50
      `),
    };
  }
}

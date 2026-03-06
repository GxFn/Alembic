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
import { jaccardSimilarity, tokenizeForSimilarity } from '../../../shared/similarity.js';

// ─── 常量 ──────────────────────────────────────────────

/** 最大记忆条数 (防止无限膨胀) */
const MAX_MEMORIES = 500;

/** 自然遗忘阈值 */
const ARCHIVE_DAYS = 30;
const FORGET_DAYS = 90;

export class MemoryStore {
  /** @type {import('better-sqlite3').Database} */
  #db;

  /** @type {object} 预编译 SQL Statements */
  #stmts = null;

  /** @type {Map<string, import('better-sqlite3').Statement>} 动态 update SQL 缓存 */
  #updateStmtCache = new Map();

  /**
   * @param {import('better-sqlite3').Database} db - better-sqlite3 实例 (raw)
   */
  constructor(db) {
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
  add(memory) {
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
    });

    return { id, action: 'ADD' };
  }

  /**
   * 更新已有记忆
   * @param {string} id
   * @param {object} updates
   * @returns {boolean}
   */
  update(id, updates) {
    const existing = this.#stmts.getById.get(id);
    if (!existing) {
      return false;
    }

    const now = new Date().toISOString();
    const fields = [];
    const params: any = { id };

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
  delete(id) {
    const result = this.#stmts.deleteById.run(id);
    return result.changes > 0;
  }

  /**
   * 按 ID 获取
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    const row = this.#stmts.getById.get(id);
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
  // @ts-expect-error TS migration: TS2339
  getAllActive({ source, type } = {}) {
    const now = new Date().toISOString();
    if (source && type) {
      return this.#stmts.getAllActiveBySourceAndType.all({ now, source, type });
    }
    if (source) {
      return this.#stmts.getAllActiveBySource.all({ now, source });
    }
    if (type) {
      return this.#stmts.getAllActiveByType.all({ now, type });
    }
    return this.#stmts.getAllActive.all({ now });
  }

  /**
   * 获取候选记忆 (用于相似度搜索)
   * @param {string|null} type
   * @returns {Array<object>}
   */
  getCandidates(type) {
    const now = new Date().toISOString();
    return type
      ? this.#stmts.getByContent.all({ type, now })
      : this.#stmts.getAll.all({ now });
  }

  /**
   * 更新访问计数
   * @param {string} id
   */
  touchAccess(id) {
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
  // @ts-expect-error TS migration: TS2339
  size({ source } = {}) {
    if (source) {
      return (
        this.#db
          .prepare('SELECT COUNT(*) as cnt FROM semantic_memories WHERE source = ?')
          .get(source)?.cnt || 0
      );
    }
    return this.#db.prepare('SELECT COUNT(*) as cnt FROM semantic_memories').get()?.cnt || 0;
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
        this.#db.prepare('SELECT COUNT(*) as cnt FROM semantic_memories').get()?.cnt || 0;
    });

    runCompact();
    return stats;
  }

  /**
   * 容量控制
   */
  enforceCapacity() {
    const count = this.#db.prepare('SELECT COUNT(*) as cnt FROM semantic_memories').get()?.cnt || 0;
    if (count <= MAX_MEMORIES) return;

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
    const total = this.#db.prepare('SELECT COUNT(*) as cnt FROM semantic_memories').get()?.cnt || 0;
    const byType = this.#db
      .prepare('SELECT type, COUNT(*) as cnt FROM semantic_memories GROUP BY type')
      .all();
    const bySource = this.#db
      .prepare('SELECT source, COUNT(*) as cnt FROM semantic_memories GROUP BY source')
      .all();
    const avgImportance =
      this.#db.prepare('SELECT AVG(importance) as avg FROM semantic_memories').get()?.avg || 0;

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
  findSimilar(content, type, limit) {
    const candidates = this.getCandidates(type);
    const lowerContent = content.toLowerCase();
    const contentTokens = tokenizeForSimilarity(lowerContent);

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
  static computeSimilarity(tokensA, lowerA, contentB) {
    const lowerB = (contentB || '').toLowerCase();
    const tokensB = tokenizeForSimilarity(lowerB);

    if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
    if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

    const jaccard = jaccardSimilarity(tokensA, tokensB);
    const containsBonus = lowerA.includes(lowerB) || lowerB.includes(lowerA) ? 0.3 : 0;
    return Math.min(1.0, jaccard + containsBonus);
  }

  /**
   * 创建 transaction wrapper
   * @param {Function} fn
   * @returns {Function}
   */
  transaction(fn) {
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
  static deserialize(row) {
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
    };
  }

  static safeParseJSON(str, fallback) {
    try {
      return str ? JSON.parse(str) : fallback;
    } catch {
      return fallback;
    }
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
          tags              TEXT DEFAULT '[]'
        )
      `);
    }
  }

  #prepareStatements() {
    this.#stmts = {
      insert: this.#db.prepare(`
        INSERT INTO semantic_memories
          (id, type, content, source, importance, access_count,
           last_accessed_at, created_at, updated_at, expires_at,
           related_entities, related_memories,
           source_dimension, source_evidence, bootstrap_session, tags)
        VALUES
          (@id, @type, @content, @source, @importance, @access_count,
           @last_accessed_at, @created_at, @updated_at, @expires_at,
           @related_entities, @related_memories,
           @source_dimension, @source_evidence, @bootstrap_session, @tags)
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

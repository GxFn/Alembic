/**
 * ProjectSemanticMemory — 项目级永久语义记忆 (Tier 3)
 *
 * 替代/增强 Memory.js 的 JSONL 存储，使用 SQLite 提供:
 *   - 重要性评分 (importance 1.0-10.0)
 *   - 综合检索 (recency × importance × relevance)
 *   - Extract-Update 模式固化 (ADD / UPDATE / MERGE / NOOP)
 *   - TTL 自动过期 + 访问计数
 *   - 关联实体 + 关联记忆
 *   - 来源追溯 (sourceDimension + sourceEvidence)
 *
 * 记忆类型:
 *   - fact:       项目事实 ("使用 BD 前缀命名", "有 200 个 ObjC 文件")
 *   - insight:    分析洞察 ("网络层集中在 BDNetwork target")
 *   - preference: 用户/项目偏好 ("不使用 singleton 模式")
 *
 * 来源:
 *   - bootstrap: 冷启动自动固化
 *   - user:      用户对话中产生
 *   - system:    SignalCollector 等后台
 *
 * 兼容: 保留 toPromptSection() 接口，可无缝替代 Memory.js
 *
 * @module ProjectSemanticMemory
 */

import { randomUUID } from 'node:crypto';

// ──────────────────────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────────────────────

/** 检索打分权重 (借鉴 Generative Agents) */
const WEIGHT_RECENCY    = 0.2;
const WEIGHT_IMPORTANCE = 0.3;
const WEIGHT_RELEVANCE  = 0.5;

/** Recency 半衰期 (天) — 7 天未访问的记忆分数下降一半 */
const RECENCY_HALF_LIFE_DAYS = 7;

/** 自然遗忘阈值 */
const ARCHIVE_DAYS      = 30;   // 30 天未访问 + importance < 3 → 归档
const FORGET_DAYS       = 90;   // 90 天未访问 → 完全遗忘

/** 最大记忆条数 (防止无限膨胀) */
const MAX_MEMORIES      = 500;

/** 相似度阈值 */
const SIMILARITY_UPDATE = 0.85;  // ≥85% 同义 → UPDATE
const SIMILARITY_MERGE  = 0.60;  // ≥60% 相关 → MERGE

// ──────────────────────────────────────────────────────────────
// ProjectSemanticMemory 类
// ──────────────────────────────────────────────────────────────

export class ProjectSemanticMemory {
  /** @type {import('better-sqlite3').Database} */
  #db;

  /** @type {import('../../infrastructure/logging/Logger.js').default|null} */
  #logger;

  // 预编译 SQL Statements (lazy init)
  #stmts = null;

  /**
   * @param {import('better-sqlite3').Database} db — better-sqlite3 实例
   * @param {object} [opts]
   * @param {object} [opts.logger] — Logger 实例
   */
  constructor(db, { logger } = {}) {
    if (!db) throw new Error('ProjectSemanticMemory requires a database instance');
    this.#db = typeof db?.getDb === 'function' ? db.getDb() : db;
    this.#logger = logger || null;

    // 确保表存在 (如果 migration 未运行)
    this.#ensureTable();
    this.#prepareStatements();
  }

  // ─── 基本 CRUD ──────────────────────────────────────────

  /**
   * 添加一条记忆
   *
   * @param {object} memory
   * @param {string} memory.type       — fact / insight / preference
   * @param {string} memory.content    — 记忆内容 (≤500 chars)
   * @param {string} [memory.source]   — bootstrap / user / system
   * @param {number} [memory.importance] — 1.0-10.0
   * @param {string} [memory.sourceDimension] — 来源维度 ID
   * @param {string} [memory.sourceEvidence]  — 支持证据
   * @param {string[]} [memory.relatedEntities] — 关联实体
   * @param {string[]} [memory.tags]   — 标签
   * @param {string} [memory.bootstrapSession] — Bootstrap session ID
   * @param {number} [memory.ttlDays]  — 过期天数 (null=永不过期)
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
   *
   * @param {string} id
   * @param {object} updates
   * @returns {boolean}
   */
  update(id, updates) {
    const existing = this.#stmts.getById.get(id);
    if (!existing) return false;

    const now = new Date().toISOString();
    const fields = [];
    const params = { id };

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

    if (fields.length === 0) return false;

    fields.push('updated_at = @updated_at');
    params.updated_at = now;

    const sql = `UPDATE semantic_memories SET ${fields.join(', ')} WHERE id = @id`;
    this.#db.prepare(sql).run(params);
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
    return row ? this.#deserialize(row) : null;
  }

  // ─── 智能存储: Extract-Update Consolidation ──────────

  /**
   * 智能固化: 对候选记忆执行 ADD / UPDATE / MERGE / NOOP
   *
   * 借鉴 Mem0 的 Extract-Update pipeline:
   *   1. 对每条候选记忆，搜索相似的现有记忆
   *   2. 根据相似度决策: ADD / UPDATE / MERGE / NOOP
   *
   * @param {Array<object>} candidateMemories — 候选记忆列表
   * @param {object} [opts]
   * @param {string} [opts.bootstrapSession] — Bootstrap session ID
   * @returns {{ added: number, updated: number, merged: number, skipped: number }}
   */
  consolidate(candidateMemories, { bootstrapSession } = {}) {
    const stats = { added: 0, updated: 0, merged: 0, skipped: 0 };

    const runConsolidate = this.#db.transaction(() => {
      for (const candidate of candidateMemories) {
        const content = (candidate.content || '').trim();
        if (!content || content.length < 5) {
          stats.skipped++;
          continue;
        }

        // 搜索相似记忆 (同 type 优先)
        const similar = this.#findSimilar(content, candidate.type, 3);

        if (similar.length === 0) {
          // ADD: 新记忆
          this.add({
            ...candidate,
            bootstrapSession,
          });
          stats.added++;
          continue;
        }

        const topMatch = similar[0];

        if (topMatch.similarity >= SIMILARITY_UPDATE) {
          // UPDATE: 几乎同义 → 更新重要性和时间戳
          this.update(topMatch.id, {
            importance: Math.max(topMatch.importance, candidate.importance || 5),
            accessCount: topMatch.access_count + 1,
          });
          stats.updated++;
        } else if (topMatch.similarity >= SIMILARITY_MERGE) {
          // MERGE: 相关但不同 → 合并信息
          const mergedContent = `${topMatch.content}; ${content}`.substring(0, 500);
          const existingRelated = this.#safeParseJSON(topMatch.related_memories_raw, []);
          this.update(topMatch.id, {
            content: mergedContent,
            importance: Math.max(topMatch.importance, candidate.importance || 5),
            relatedMemories: [...existingRelated, `merged:${Date.now()}`],
          });
          stats.merged++;
        } else {
          // 不够相似 → ADD 新记忆
          this.add({
            ...candidate,
            bootstrapSession,
          });
          stats.added++;
        }
      }
    });

    runConsolidate();

    this.#log(`Consolidation: +${stats.added} ADD, ~${stats.updated} UPDATE, ⊕${stats.merged} MERGE, =${stats.skipped} SKIP`);

    // 容量控制
    this.#enforceCapacity();

    return stats;
  }

  // ─── 综合检索 ─────────────────────────────────────────

  /**
   * 综合检索: recency × importance × relevance
   *
   * 借鉴 Generative Agents 的三维打分模型:
   *   score = α * recency + β * importance + γ * relevance
   *
   * @param {string} query — 查询文本
   * @param {object} [opts]
   * @param {number} [opts.limit=10]
   * @param {string} [opts.source] — 过滤 source
   * @param {string} [opts.type]   — 过滤 type
   * @returns {Array<object>} 按 score 降序排列
   */
  retrieve(query, { limit = 10, source, type } = {}) {
    const all = this.#getAllActive({ source, type });
    if (all.length === 0) return [];

    const now = Date.now();
    const lowerQuery = (query || '').toLowerCase();
    const queryTokens = this.#tokenize(lowerQuery);

    const scored = all.map(m => {
      // Recency: 指数衰减 (半衰期 7 天)
      const lastAccess = m.last_accessed_at
        ? new Date(m.last_accessed_at).getTime()
        : new Date(m.updated_at).getTime();
      const daysSinceAccess = (now - lastAccess) / 86400_000;
      const recency = Math.exp(-daysSinceAccess * Math.LN2 / RECENCY_HALF_LIFE_DAYS);

      // Importance: 归一化到 0-1
      const importance = (m.importance || 5) / 10;

      // Relevance: token overlap + 子串匹配
      const relevance = this.#computeRelevance(lowerQuery, queryTokens, m.content);

      const score = WEIGHT_RECENCY * recency
                  + WEIGHT_IMPORTANCE * importance
                  + WEIGHT_RELEVANCE * relevance;

      return {
        ...this.#deserialize(m),
        _score: score,
        _recency: recency,
        _relevance: relevance,
      };
    });

    // 按 score 降序，取 top-N
    scored.sort((a, b) => b._score - a._score);

    // 更新访问计数 (只更新返回的)
    const topN = scored.slice(0, limit);
    for (const m of topN) {
      this.#touchAccess(m.id);
    }

    return topN;
  }

  /**
   * 简单文本搜索 (不打分, 用于去重检查)
   *
   * @param {string} content
   * @param {object} [opts]
   * @param {number} [opts.limit=5]
   * @returns {Array<object>}
   */
  search(content, { limit = 5 } = {}) {
    const results = this.#findSimilar(content, null, limit);
    return results.map(r => this.#deserialize(r));
  }

  // ─── Prompt 生成 (兼容 Memory.js) ──────────────────────

  /**
   * 生成供系统提示词的记忆摘要
   *
   * 兼容 Memory.toPromptSection() 接口:
   *   memory.toPromptSection({ source: 'user' })
   *
   * 增强: 使用综合检索 (recency + importance + relevance)
   *
   * @param {object} [opts]
   * @param {string} [opts.source] — 过滤 source (user/system/bootstrap)
   * @param {string} [opts.query]  — 查询上下文 (用于 relevance 打分)
   * @param {number} [opts.limit=15]
   * @returns {string} Markdown 格式
   */
  toPromptSection({ source, query, limit = 15 } = {}) {
    let memories;

    if (query) {
      // 有查询上下文: 使用综合检索
      memories = this.retrieve(query, { limit, source });
    } else {
      // 无查询上下文: 按重要性 + 最近访问排序
      memories = this.#getAllActive({ source })
        .sort((a, b) => {
          const scoreA = (a.importance || 5) * 0.6 + (a.access_count || 0) * 0.4;
          const scoreB = (b.importance || 5) * 0.6 + (b.access_count || 0) * 0.4;
          return scoreB - scoreA;
        })
        .slice(0, limit)
        .map(m => this.#deserialize(m));
    }

    if (memories.length === 0) return '';

    const lines = memories.map(m => {
      const badge = m.importance >= 8 ? '⚠️' : m.importance >= 5 ? '📌' : '💡';
      return `- ${badge} [${m.type}] ${m.content}`;
    });

    return `\n## 项目记忆 (${memories.length} 条最相关)\n${lines.join('\n')}\n`;
  }

  // ─── Memory.js 兼容层 ──────────────────────────────────

  /**
   * 兼容 Memory.load() — 返回最近 N 条记忆
   *
   * @param {number} [limit=20]
   * @param {object} [opts]
   * @param {string} [opts.source]
   * @returns {Array<object>}
   */
  load(limit = 20, { source } = {}) {
    const rows = this.#getAllActive({ source })
      .sort((a, b) => {
        const tA = new Date(a.updated_at).getTime();
        const tB = new Date(b.updated_at).getTime();
        return tB - tA;
      })
      .slice(0, limit);
    return rows.map(r => ({
      ts: r.updated_at,
      type: r.type,
      content: r.content,
      source: r.source,
      importance: r.importance,
    }));
  }

  /**
   * 兼容 Memory.append() — 添加一条记忆 (自动去重)
   *
   * @param {object} entry
   * @param {string} entry.type
   * @param {string} entry.content
   * @param {string} [entry.source]
   * @param {number} [entry.ttl] — 过期天数
   */
  append(entry) {
    const content = (entry.content || '').trim().substring(0, 500);
    if (!content) return;

    // 去重: 检查是否已有高相似度记忆
    const similar = this.#findSimilar(content, entry.type, 1);
    if (similar.length > 0 && similar[0].similarity >= SIMILARITY_UPDATE) {
      // 已存在同义记忆 → 更新访问时间
      this.#touchAccess(similar[0].id);
      return;
    }

    this.add({
      type: entry.type || 'context',
      content,
      source: entry.source || 'user',
      importance: 5,
      ttlDays: entry.ttl || null,
    });
  }

  /**
   * 兼容 Memory.size()
   * @param {object} [opts]
   * @param {string} [opts.source]
   * @returns {number}
   */
  size({ source } = {}) {
    if (source) {
      return this.#db.prepare(
        'SELECT COUNT(*) as cnt FROM semantic_memories WHERE source = ?'
      ).get(source)?.cnt || 0;
    }
    return this.#db.prepare(
      'SELECT COUNT(*) as cnt FROM semantic_memories'
    ).get()?.cnt || 0;
  }

  // ─── 维护: 过期清理 + 容量控制 ────────────────────────

  /**
   * 执行维护: 清理过期记忆 + 容量控制
   *
   * 建议在每次 Bootstrap 开始时调用。
   *
   * @returns {{ expired: number, forgotten: number, archived: number, remaining: number }}
   */
  compact() {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const stats = { expired: 0, forgotten: 0, archived: 0, remaining: 0 };

    const runCompact = this.#db.transaction(() => {
      // 1. 删除 TTL 过期
      const expiredResult = this.#db.prepare(
        'DELETE FROM semantic_memories WHERE expires_at IS NOT NULL AND expires_at < ?'
      ).run(now);
      stats.expired = expiredResult.changes;

      // 2. 完全遗忘: 90 天未访问
      const forgetThreshold = new Date(nowMs - FORGET_DAYS * 86400_000).toISOString();
      const forgottenResult = this.#db.prepare(
        'DELETE FROM semantic_memories WHERE last_accessed_at < ? AND importance < 7'
      ).run(forgetThreshold);
      stats.forgotten = forgottenResult.changes;

      // 3. 归档: 30 天未访问 + 低重要性 → 降低 importance
      const archiveThreshold = new Date(nowMs - ARCHIVE_DAYS * 86400_000).toISOString();
      const archiveResult = this.#db.prepare(
        'UPDATE semantic_memories SET importance = MAX(1, importance - 1) WHERE last_accessed_at < ? AND importance < 3'
      ).run(archiveThreshold);
      stats.archived = archiveResult.changes;

      stats.remaining = this.#db.prepare('SELECT COUNT(*) as cnt FROM semantic_memories').get()?.cnt || 0;
    });

    runCompact();

    this.#log(`Compact: ${stats.expired} expired, ${stats.forgotten} forgotten, ${stats.archived} archived, ${stats.remaining} remaining`);
    return stats;
  }

  // ─── 统计 ─────────────────────────────────────────────

  /**
   * 获取统计信息
   * @returns {object}
   */
  getStats() {
    const total = this.#db.prepare('SELECT COUNT(*) as cnt FROM semantic_memories').get()?.cnt || 0;
    const byType = this.#db.prepare(
      'SELECT type, COUNT(*) as cnt FROM semantic_memories GROUP BY type'
    ).all();
    const bySource = this.#db.prepare(
      'SELECT source, COUNT(*) as cnt FROM semantic_memories GROUP BY source'
    ).all();
    const avgImportance = this.#db.prepare(
      'SELECT AVG(importance) as avg FROM semantic_memories'
    ).get()?.avg || 0;

    return {
      total,
      byType: Object.fromEntries(byType.map(r => [r.type, r.cnt])),
      bySource: Object.fromEntries(bySource.map(r => [r.source, r.cnt])),
      avgImportance: Math.round(avgImportance * 10) / 10,
    };
  }

  /**
   * 清除所有 bootstrap 来源的记忆 (用于重新冷启动前)
   * @returns {number} 删除数量
   */
  clearBootstrapMemories() {
    const result = this.#db.prepare(
      "DELETE FROM semantic_memories WHERE source = 'bootstrap'"
    ).run();
    this.#log(`Cleared ${result.changes} bootstrap memories`);
    return result.changes;
  }

  // ─── 内部方法 ─────────────────────────────────────────

  /**
   * 确保表存在 (用于 migration 未运行的情况)
   */
  #ensureTable() {
    const exists = this.#db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='semantic_memories'"
    ).get();

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

  /**
   * 预编译常用 SQL 语句
   */
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

      getById: this.#db.prepare(
        'SELECT * FROM semantic_memories WHERE id = ?'
      ),

      deleteById: this.#db.prepare(
        'DELETE FROM semantic_memories WHERE id = ?'
      ),

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

  /**
   * 获取所有活跃记忆 (未过期)
   */
  #getAllActive({ source, type } = {}) {
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
   * 更新访问计数和最后访问时间
   */
  #touchAccess(id) {
    try {
      this.#stmts.touchAccess.run({ id, now: new Date().toISOString() });
    } catch { /* non-critical */ }
  }

  /**
   * 查找相似记忆 (基于 token overlap)
   *
   * @param {string} content
   * @param {string|null} type
   * @param {number} limit
   * @returns {Array<object & { similarity: number }>}
   */
  #findSimilar(content, type, limit) {
    const now = new Date().toISOString();
    const candidates = type
      ? this.#stmts.getByContent.all({ type, now })
      : this.#stmts.getAll.all({ now });

    const lowerContent = content.toLowerCase();
    const contentTokens = this.#tokenize(lowerContent);

    const scored = candidates
      .map(row => {
        const similarity = this.#computeSimilarity(contentTokens, lowerContent, row.content);
        return { ...row, similarity, related_memories_raw: row.related_memories };
      })
      .filter(r => r.similarity > 0.1)
      .sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, limit);
  }

  /**
   * 计算两段文本的相似度 (Jaccard + 子串)
   *
   * @param {Set<string>} tokensA — 预分词的 token 集合
   * @param {string} lowerA — 小写原文
   * @param {string} contentB — 原始文本 B
   * @returns {number} 0.0-1.0
   */
  #computeSimilarity(tokensA, lowerA, contentB) {
    const lowerB = (contentB || '').toLowerCase();
    const tokensB = this.#tokenize(lowerB);

    if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
    if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

    // Jaccard similarity: |A ∩ B| / |A ∪ B|
    let intersection = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) intersection++;
    }
    const union = new Set([...tokensA, ...tokensB]).size;
    const jaccard = intersection / union;

    // 子串包含加分
    const containsBonus = (lowerA.includes(lowerB) || lowerB.includes(lowerA)) ? 0.3 : 0;

    return Math.min(1.0, jaccard + containsBonus);
  }

  /**
   * 计算查询与记忆内容的相关性 (用于检索打分)
   *
   * @param {string} lowerQuery
   * @param {Set<string>} queryTokens
   * @param {string} content
   * @returns {number} 0.0-1.0
   */
  #computeRelevance(lowerQuery, queryTokens, content) {
    if (!lowerQuery || !content) return 0;

    const lowerContent = content.toLowerCase();
    const contentTokens = this.#tokenize(lowerContent);

    if (queryTokens.size === 0) return 0;

    // Token overlap
    let matchCount = 0;
    for (const t of queryTokens) {
      if (contentTokens.has(t)) matchCount++;
    }
    const tokenOverlap = matchCount / queryTokens.size;

    // 子串匹配
    const substringMatch = lowerContent.includes(lowerQuery) ? 0.4 : 0;

    // 关键词部分匹配
    let partialMatch = 0;
    for (const qt of queryTokens) {
      if (qt.length >= 3 && lowerContent.includes(qt)) {
        partialMatch += 0.1;
      }
    }
    partialMatch = Math.min(0.3, partialMatch);

    return Math.min(1.0, tokenOverlap * 0.5 + substringMatch + partialMatch);
  }

  /**
   * 分词 (简单: 按空格/标点分割, 去短词)
   * @param {string} text
   * @returns {Set<string>}
   */
  #tokenize(text) {
    if (!text) return new Set();
    return new Set(
      text
        .split(/[\s,;:!?。，；：！？\-_/\\|()[\]{}'"<>]+/)
        .filter(t => t.length >= 2)
        .map(t => t.toLowerCase())
    );
  }

  /**
   * 反序列化 DB 行为 JS 对象
   */
  #deserialize(row) {
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
      relatedEntities: this.#safeParseJSON(row.related_entities, []),
      relatedMemories: this.#safeParseJSON(row.related_memories, []),
      sourceDimension: row.source_dimension,
      sourceEvidence: row.source_evidence,
      bootstrapSession: row.bootstrap_session,
      tags: this.#safeParseJSON(row.tags, []),
    };
  }

  /**
   * 安全 JSON 解析
   */
  #safeParseJSON(str, fallback) {
    try {
      return str ? JSON.parse(str) : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * 容量控制: 超过 MAX_MEMORIES 时删除最不重要的
   */
  #enforceCapacity() {
    const count = this.#db.prepare('SELECT COUNT(*) as cnt FROM semantic_memories').get()?.cnt || 0;
    if (count <= MAX_MEMORIES) return;

    const excess = count - MAX_MEMORIES;
    this.#db.prepare(`
      DELETE FROM semantic_memories WHERE id IN (
        SELECT id FROM semantic_memories
        ORDER BY importance ASC, access_count ASC, updated_at ASC
        LIMIT ?
      )
    `).run(excess);

    this.#log(`Capacity enforced: removed ${excess} lowest-priority memories`);
  }

  /**
   * 日志输出
   */
  #log(msg) {
    const formatted = `[SemanticMemory] ${msg}`;
    if (this.#logger) {
      this.#logger.info(formatted);
    }
  }
}

export default ProjectSemanticMemory;

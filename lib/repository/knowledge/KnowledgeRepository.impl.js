import { BaseRepository } from '../base/BaseRepository.js';
import { KnowledgeEntry, Lifecycle, inferKind } from '../../domain/knowledge/index.js';
import Logger from '../../infrastructure/logging/Logger.js';

/**
 * KnowledgeRepositoryImpl — 统一知识实体仓储实现
 *
 * 面向 knowledge_entries 表的 SQLite 持久化。
 * 替代 CandidateRepositoryImpl + RecipeRepositoryImpl。
 */
export class KnowledgeRepositoryImpl extends BaseRepository {
  constructor(database) {
    super(database, 'knowledge_entries');
    this.logger = Logger.getInstance();
  }

  /* ═══ CRUD ═══════════════════════════════════════════ */

  /**
   * 创建 KnowledgeEntry
   * @param {KnowledgeEntry} entry
   * @returns {Promise<KnowledgeEntry>}
   */
  async create(entry) {
    if (!entry || !entry.isValid()) {
      throw new Error('Invalid knowledge entry: title + content required');
    }

    try {
      const row = this._entityToRow(entry);
      const keys = Object.keys(row);
      const placeholders = keys.map(() => '?').join(', ');
      const query = `INSERT INTO knowledge_entries (${keys.join(', ')}) VALUES (${placeholders})`;
      this.db.prepare(query).run(...Object.values(row));
      return this.findById(entry.id);
    } catch (error) {
      this.logger.error('Error creating knowledge entry', {
        entryId: entry.id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 更新 KnowledgeEntry（接受完整实体或部分 wire format）
   * @param {string} id
   * @param {Object|KnowledgeEntry} updates
   * @returns {Promise<KnowledgeEntry>}
   */
  async update(id, updates) {
    try {
      const existing = await this.findById(id);
      if (!existing) throw new Error(`Knowledge entry not found: ${id}`);

      // 如果传入的是完整实体
      if (updates instanceof KnowledgeEntry) {
        const row = this._entityToRow(updates);
        delete row.id;
        delete row.created_at;
        row.updated_at = Math.floor(Date.now() / 1000);

        const setClauses = Object.keys(row).map(k => `${k} = ?`).join(', ');
        this.db.prepare(`UPDATE knowledge_entries SET ${setClauses} WHERE id = ?`)
          .run(...Object.values(row), id);
        return this.findById(id);
      }

      // 部分更新 — 合并 wire format 到现有实体
      const merged = KnowledgeEntry.fromJSON({
        ...existing.toJSON(),
        ...updates,
        updated_at: Math.floor(Date.now() / 1000),
      });
      const row = this._entityToRow(merged);
      delete row.id;
      delete row.created_at;

      const setClauses = Object.keys(row).map(k => `${k} = ?`).join(', ');
      this.db.prepare(`UPDATE knowledge_entries SET ${setClauses} WHERE id = ?`)
        .run(...Object.values(row), id);
      return this.findById(id);
    } catch (error) {
      this.logger.error('Error updating knowledge entry', {
        id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 删除
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    try {
      const result = this.db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id);
      return result.changes > 0;
    } catch (error) {
      this.logger.error('Error deleting knowledge entry', { id, error: error.message });
      throw error;
    }
  }

  /* ═══ 查询 ═══════════════════════════════════════════ */

  /**
   * 分页查询
   * @override
   */
  async findWithPagination(filters = {}, options = {}) {
    const { page = 1, pageSize = 20, orderBy = 'created_at', order = 'DESC' } = options;
    const offset = (page - 1) * pageSize;

    const conditions = [];
    const params = [];

    // 处理特殊过滤字段
    const { _tagLike, _search, lifecycle: lcFilter, ...normalFilters } = filters;

    // lifecycle 筛选：将新 3 状态映射到可能存在的旧值
    if (lcFilter) {
      if (lcFilter === 'pending') {
        conditions.push(`lifecycle IN ('pending', 'draft', 'approved', 'auto_approved')`);
      } else if (lcFilter === 'deprecated') {
        conditions.push(`lifecycle IN ('deprecated', 'rejected')`);
      } else {
        conditions.push(`lifecycle = ?`);
        params.push(lcFilter);
      }
    }

    for (const [key, value] of Object.entries(normalFilters)) {
      if (value == null) continue;
      this._assertSafeColumn(key);
      conditions.push(`${key} = ?`);
      params.push(value);
    }

    if (_tagLike) {
      conditions.push(`tags LIKE ?`);
      const escaped = _tagLike.replace(/[%_\\]/g, ch => `\\${ch}`);
      params.push(`%"${escaped}"%`);
    }

    if (_search) {
      const escaped = _search.replace(/[%_\\]/g, ch => `\\${ch}`);
      const like = `%${escaped}%`;
      conditions.push(`(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR trigger_key LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like, like);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    this._assertSafeColumn(orderBy);
    const orderClause = ` ORDER BY ${orderBy} ${order === 'ASC' ? 'ASC' : 'DESC'}`;

    const total = this.db.prepare(`SELECT COUNT(*) as count FROM knowledge_entries${where}`).get(...params).count;
    const data = this.db.prepare(`SELECT * FROM knowledge_entries${where}${orderClause} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset);

    return {
      data: data.map(row => this._rowToEntity(row)),
      pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    };
  }

  /**
   * 根据生命周期状态查询
   */
  async findByLifecycle(lifecycle, pagination = {}) {
    return this.findWithPagination({ lifecycle }, pagination);
  }

  /**
   * 根据 kind 查询
   */
  async findByKind(kind, options = {}) {
    const { lifecycle, ...pagination } = options;
    const filters = { kind };
    if (lifecycle) filters.lifecycle = lifecycle;
    return this.findWithPagination(filters, pagination);
  }

  /**
   * 查询所有 active 的 rule 类型（Guard 消费热路径）
   * @returns {Promise<KnowledgeEntry[]>}
   */
  async findActiveRules() {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM knowledge_entries
        WHERE kind = 'rule' AND lifecycle = 'active'
      `).all();
      return rows.map(row => this._rowToEntity(row));
    } catch (error) {
      this.logger.error('Error finding active rules', { error: error.message });
      throw error;
    }
  }

  /**
   * 根据语言查询
   */
  async findByLanguage(language, pagination = {}) {
    return this.findWithPagination({ language }, pagination);
  }

  /**
   * 根据分类查询
   */
  async findByCategory(category, pagination = {}) {
    return this.findWithPagination({ category }, pagination);
  }

  /**
   * 搜索
   */
  async search(keyword, pagination = {}) {
    return this.findWithPagination({ _search: keyword }, pagination);
  }

  /**
   * 获取统计信息
   */
  async getStats() {
    try {
      return this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN lifecycle IN ('pending', 'draft', 'approved', 'auto_approved') THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN lifecycle = 'active' THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN lifecycle IN ('deprecated', 'rejected') THEN 1 ELSE 0 END) as deprecated,
          SUM(CASE WHEN kind = 'rule' THEN 1 ELSE 0 END) as rules,
          SUM(CASE WHEN kind = 'pattern' THEN 1 ELSE 0 END) as patterns,
          SUM(CASE WHEN kind = 'fact' THEN 1 ELSE 0 END) as facts
        FROM knowledge_entries
      `).get();
    } catch (error) {
      this.logger.error('Error getting knowledge stats', { error: error.message });
      throw error;
    }
  }

  /* ═══ 行 ↔ 实体 映射 ═══════════════════════════════ */

  /**
   * DB Row → KnowledgeEntry
   * @param {Object} row
   * @returns {KnowledgeEntry}
   */
  _rowToEntity(row) {
    if (!row) return null;

    return new KnowledgeEntry({
      id:                row.id,
      title:             row.title,
      trigger:           row.trigger_key,
      description:       row.description,
      lifecycle:         row.lifecycle,
      lifecycleHistory:  this._parseJson(row.lifecycle_history, []),
      autoApprovable:    !!row.probation,
      language:          row.language,
      category:          row.category,
      kind:              row.kind || inferKind(row.knowledge_type),
      knowledgeType:     row.knowledge_type,
      complexity:        row.complexity,
      scope:             row.scope,
      difficulty:        row.difficulty,
      tags:              this._parseJson(row.tags, []),
      summaryCn:         row.summary_cn || '',
      summaryEn:         row.summary_en || '',
      usageGuideCn:      row.usage_guide_cn || '',
      usageGuideEn:      row.usage_guide_en || '',
      content:           this._parseJson(row.content, {}),
      relations:         this._parseJson(row.relations, {}),
      constraints:       this._parseJson(row.constraints, {}),
      reasoning:         this._parseJson(row.reasoning, {}),
      quality:           this._parseJson(row.quality, {}),
      stats:             this._parseJson(row.stats, {}),
      headers:           this._parseJson(row.headers, []),
      headerPaths:       this._parseJson(row.header_paths, []),
      moduleName:        row.module_name || '',
      includeHeaders:    !!row.include_headers,
      agentNotes:        this._parseJson(row.agent_notes, null),
      aiInsight:         row.ai_insight || null,
      reviewedBy:        row.reviewed_by || null,
      reviewedAt:        row.reviewed_at || null,
      rejectionReason:   row.rejection_reason || null,
      source:            row.source || 'manual',
      sourceFile:        row.source_file || null,
      sourceCandidateId: row.source_candidate_id || null,
      createdBy:         row.created_by || 'system',
      createdAt:         row.created_at,
      updatedAt:         row.updated_at,
      publishedAt:       row.published_at || null,
      publishedBy:       row.published_by || null,
    });
  }

  /**
   * KnowledgeEntry → DB Row
   * @param {KnowledgeEntry} e
   * @returns {Object}
   */
  _entityToRow(e) {
    const now = Math.floor(Date.now() / 1000);
    return {
      id:                  e.id,
      title:               e.title,
      trigger_key:         e.trigger || '',
      description:         e.description || '',
      lifecycle:           e.lifecycle,
      lifecycle_history:   JSON.stringify(e.lifecycleHistory || []),
      probation:           e.autoApprovable ? 1 : 0,
      language:            e.language,
      category:            e.category,
      kind:                e.kind || inferKind(e.knowledgeType),
      knowledge_type:      e.knowledgeType || 'code-pattern',
      complexity:          e.complexity || 'intermediate',
      scope:               e.scope || null,
      difficulty:          e.difficulty || null,
      tags:                JSON.stringify(e.tags || []),
      summary_cn:          e.summaryCn || null,
      summary_en:          e.summaryEn || null,
      usage_guide_cn:      e.usageGuideCn || null,
      usage_guide_en:      e.usageGuideEn || null,
      content:             JSON.stringify(e.content.toJSON()),
      relations:           JSON.stringify(e.relations.toJSON()),
      constraints:         JSON.stringify(e.constraints.toJSON()),
      reasoning:           JSON.stringify(e.reasoning.toJSON()),
      quality:             JSON.stringify(e.quality.toJSON()),
      stats:               JSON.stringify(e.stats.toJSON()),
      headers:             JSON.stringify(e.headers || []),
      header_paths:        JSON.stringify(e.headerPaths || []),
      module_name:         e.moduleName || null,
      include_headers:     e.includeHeaders ? 1 : 0,
      agent_notes:         e.agentNotes ? JSON.stringify(e.agentNotes) : null,
      ai_insight:          e.aiInsight || null,
      reviewed_by:         e.reviewedBy || null,
      reviewed_at:         e.reviewedAt || null,
      rejection_reason:    e.rejectionReason || null,
      source:              e.source || 'manual',
      source_file:         e.sourceFile || null,
      source_candidate_id: e.sourceCandidateId || null,
      created_by:          e.createdBy || 'system',
      created_at:          e.createdAt || now,
      updated_at:          e.updatedAt || now,
      published_at:        e.publishedAt || null,
      published_by:        e.publishedBy || null,
      content_hash:        null,
    };
  }

  /**
   * 覆写 BaseRepository 的 _mapRowToEntity
   * @override
   */
  _mapRowToEntity(row) {
    return this._rowToEntity(row);
  }

  /** @private 安全解析 JSON */
  _parseJson(value, fallback) {
    if (!value || value === 'null') return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return fallback; }
  }
}

export default KnowledgeRepositoryImpl;

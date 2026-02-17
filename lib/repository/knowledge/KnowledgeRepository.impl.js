import { BaseRepository } from '../base/BaseRepository.js';
import { KnowledgeEntry, Lifecycle, inferKind } from '../../domain/knowledge/index.js';
import Logger from '../../infrastructure/logging/Logger.js';

/**
 * KnowledgeRepositoryImpl — 统一知识实体仓储实现
 *
 * 面向 knowledge_entries 表的 SQLite 持久化。
 * 全链路 camelCase — DB 列名 = 实体属性名。
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
   * 更新 KnowledgeEntry（接受完整实体或部分数据）
   * @param {string} id
   * @param {Object|KnowledgeEntry} updates
   * @returns {Promise<KnowledgeEntry>}
   */
  async update(id, updates) {
    try {
      const existing = await this.findById(id);
      if (!existing) throw new Error(`Knowledge entry not found: ${id}`);

      if (updates instanceof KnowledgeEntry) {
        const row = this._entityToRow(updates);
        delete row.id;
        delete row.createdAt;
        row.updatedAt = Math.floor(Date.now() / 1000);

        const setClauses = Object.keys(row).map(k => `${k} = ?`).join(', ');
        this.db.prepare(`UPDATE knowledge_entries SET ${setClauses} WHERE id = ?`)
          .run(...Object.values(row), id);
        return this.findById(id);
      }

      // 部分更新 — 合并到现有实体
      const merged = KnowledgeEntry.fromJSON({
        ...existing.toJSON(),
        ...updates,
        updatedAt: Math.floor(Date.now() / 1000),
      });
      const row = this._entityToRow(merged);
      delete row.id;
      delete row.createdAt;

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
    const { page = 1, pageSize = 20, orderBy = 'createdAt', order = 'DESC' } = options;
    const offset = (page - 1) * pageSize;

    const conditions = [];
    const params = [];

    const { _tagLike, _search, lifecycle: lcFilter, ...normalFilters } = filters;

    if (lcFilter) {
      conditions.push(`lifecycle = ?`);
      params.push(lcFilter);
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
      conditions.push(`(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR trigger LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')`);
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
          SUM(CASE WHEN lifecycle = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN lifecycle = 'active' THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN lifecycle = 'deprecated' THEN 1 ELSE 0 END) as deprecated,
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
   * DB Row → KnowledgeEntry (camelCase 列名 = 属性名，直传)
   * @param {Object} row
   * @returns {KnowledgeEntry}
   */
  _rowToEntity(row) {
    if (!row) return null;

    return new KnowledgeEntry({
      ...row,
      // JSON 列需要 parse
      lifecycleHistory: this._parseJson(row.lifecycleHistory, []),
      tags:             this._parseJson(row.tags, []),
      content:          this._parseJson(row.content, {}),
      relations:        this._parseJson(row.relations, {}),
      constraints:      this._parseJson(row.constraints, {}),
      reasoning:        this._parseJson(row.reasoning, {}),
      quality:          this._parseJson(row.quality, {}),
      stats:            this._parseJson(row.stats, {}),
      headers:          this._parseJson(row.headers, []),
      headerPaths:      this._parseJson(row.headerPaths, []),
      agentNotes:       this._parseJson(row.agentNotes, null),
      // SQLite INTEGER → boolean
      autoApprovable:   !!row.autoApprovable,
      includeHeaders:   !!row.includeHeaders,
    });
  }

  /**
   * KnowledgeEntry → DB Row (camelCase 列名 = 属性名，直传)
   * @param {KnowledgeEntry} e
   * @returns {Object}
   */
  _entityToRow(e) {
    const now = Math.floor(Date.now() / 1000);
    return {
      id:                e.id,
      title:             e.title,
      description:       e.description || '',
      lifecycle:         e.lifecycle,
      lifecycleHistory:  JSON.stringify(e.lifecycleHistory || []),
      autoApprovable:    e.autoApprovable ? 1 : 0,
      language:          e.language,
      category:          e.category,
      kind:              e.kind || inferKind(e.knowledgeType),
      knowledgeType:     e.knowledgeType || 'code-pattern',
      complexity:        e.complexity || 'intermediate',
      scope:             e.scope || null,
      difficulty:        e.difficulty || null,
      tags:              JSON.stringify(e.tags || []),
      trigger:           e.trigger || '',
      topicHint:         e.topicHint || '',
      whenClause:        e.whenClause || '',
      doClause:          e.doClause || '',
      dontClause:        e.dontClause || '',
      coreCode:          e.coreCode || '',
      content:           JSON.stringify(typeof e.content?.toJSON === 'function' ? e.content.toJSON() : (e.content || {})),
      relations:         JSON.stringify(typeof e.relations?.toJSON === 'function' ? e.relations.toJSON() : (e.relations || {})),
      constraints:       JSON.stringify(typeof e.constraints?.toJSON === 'function' ? e.constraints.toJSON() : (e.constraints || {})),
      reasoning:         JSON.stringify(typeof e.reasoning?.toJSON === 'function' ? e.reasoning.toJSON() : (e.reasoning || {})),
      quality:           JSON.stringify(typeof e.quality?.toJSON === 'function' ? e.quality.toJSON() : (e.quality || {})),
      stats:             JSON.stringify(typeof e.stats?.toJSON === 'function' ? e.stats.toJSON() : (e.stats || {})),
      headers:           JSON.stringify(e.headers || []),
      headerPaths:       JSON.stringify(e.headerPaths || []),
      moduleName:        e.moduleName || null,
      includeHeaders:    e.includeHeaders ? 1 : 0,
      agentNotes:        e.agentNotes ? JSON.stringify(e.agentNotes) : null,
      aiInsight:         e.aiInsight || null,
      reviewedBy:        e.reviewedBy || null,
      reviewedAt:        e.reviewedAt || null,
      rejectionReason:   e.rejectionReason || null,
      source:            e.source || 'manual',
      sourceFile:        e.sourceFile || null,
      sourceCandidateId: e.sourceCandidateId || null,
      createdBy:         e.createdBy || 'system',
      createdAt:         e.createdAt || now,
      updatedAt:         e.updatedAt || now,
      publishedAt:       e.publishedAt || null,
      publishedBy:       e.publishedBy || null,
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

import { KnowledgeEntry } from '../../domain/knowledge/KnowledgeEntry.js';
import { Lifecycle, inferKind } from '../../domain/knowledge/Lifecycle.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { ValidationError, ConflictError, NotFoundError } from '../../shared/errors/index.js';

/**
 * KnowledgeService — 统一知识服务
 *
 * 替代 CandidateService + RecipeService。
 * 全链路使用 KnowledgeEntry 实体 + wire format，
 * 无需 promote、无需 metadata 袋子、无需打平映射。
 *
 * 生命周期操作委托给 KnowledgeEntry 实体方法，
 * Service 负责编排 Repository / FileWriter / AuditLog / Graph / SkillHooks。
 */
export class KnowledgeService {
  /**
   * @param {import('../../domain/knowledge/KnowledgeRepository.js').KnowledgeRepository} repository
   * @param {object} auditLogger
   * @param {object} gateway
   * @param {object} knowledgeGraphService
   * @param {object} [options]
   * @param {import('./KnowledgeFileWriter.js').KnowledgeFileWriter} [options.fileWriter]
   * @param {import('../skills/SkillHooks.js').SkillHooks} [options.skillHooks]
   * @param {import('./ConfidenceRouter.js').ConfidenceRouter} [options.confidenceRouter]
   * @param {import('../quality/QualityScorer.js').QualityScorer} [options.qualityScorer]
   */
  constructor(repository, auditLogger, gateway, knowledgeGraphService, options = {}) {
    this.repository           = repository;
    this.auditLogger          = auditLogger;
    this.gateway              = gateway;
    this._knowledgeGraphService = knowledgeGraphService || null;
    this._fileWriter          = options.fileWriter || null;
    this._skillHooks          = options.skillHooks || null;
    this._confidenceRouter    = options.confidenceRouter || null;
    this._qualityScorer       = options.qualityScorer || null;
    this.logger               = Logger.getInstance();
  }

  /* ═══ CRUD ══════════════════════════════════════════════ */

  /**
   * 创建知识条目
   *
   * MCP 参数 = wire format → KnowledgeEntry.fromJSON() 直接构造。
   * 所有新条目初始状态为 pending（待审核）。
   * ConfidenceRouter 仅标记 auto_approvable 标志，不改变 lifecycle。
   *
   * @param {Object} data - wire format 数据
   * @param {Object} context - { userId }
   * @returns {Promise<KnowledgeEntry>}
   */
  async create(data, context) {
    try {
      this._validateCreateInput(data);

      const entry = KnowledgeEntry.fromJSON({
        ...data,
        lifecycle:  Lifecycle.PENDING,
        source:     data.source || 'manual',
        created_by: context.userId,
      });

      if (!entry.isValid()) {
        throw new ValidationError('title + content required');
      }

      // ── SkillHooks: onKnowledgeSubmit ──
      if (this._skillHooks) {
        const hookResult = await this._skillHooks.run('onKnowledgeSubmit', entry, {
          userId: context.userId,
        });
        if (hookResult?.block) {
          throw new ValidationError(`SkillHook blocked: ${hookResult.reason || 'unknown'}`);
        }
      }

      // ── ConfidenceRouter — 仅标记 auto_approvable，不改变 lifecycle ──
      if (this._confidenceRouter) {
        const route = await this._confidenceRouter.route(entry);
        if (route.action === 'auto_approve') {
          entry.autoApprovable = true;
        }
        // reject / pending 都保持 pending 状态，等待人工审核
      }

      const saved = await this.repository.create(entry);

      // 同步 relations → knowledge_edges
      this._syncRelationsToGraph(saved.id, saved.relations);

      // 落盘 .md 文件
      this._persistToFile(saved);

      // 审计日志
      await this._audit('create_knowledge', saved.id, context.userId, {
        title: saved.title,
        lifecycle: saved.lifecycle,
        kind: saved.kind,
      });

      this.logger.info('Knowledge entry created', {
        id: saved.id,
        lifecycle: saved.lifecycle,
        kind: saved.kind,
        createdBy: context.userId,
      });

      // ── SkillHooks: onKnowledgeCreated (fire-and-forget) ──
      if (this._skillHooks) {
        this._skillHooks.run('onKnowledgeCreated', saved, {
          userId: context.userId,
        }).catch(err => this.logger.warn('SkillHook onKnowledgeCreated error', { error: err.message }));
      }

      return saved;
    } catch (error) {
      this.logger.error('Error creating knowledge entry', {
        error: error.message,
        data,
      });
      throw error;
    }
  }

  /**
   * 获取单个知识条目
   * @param {string} id
   * @returns {Promise<KnowledgeEntry>}
   */
  async get(id) {
    const entry = await this.repository.findById(id);
    if (!entry) {
      throw new NotFoundError('Knowledge entry not found', 'knowledge', id);
    }
    return entry;
  }

  /**
   * 更新知识条目（仅允许白名单字段）
   * @param {string} id
   * @param {Object} data - wire format 部分字段
   * @param {Object} context - { userId }
   * @returns {Promise<KnowledgeEntry>}
   */
  async update(id, data, context) {
    try {
      const entry = await this._findOrThrow(id);

      const UPDATABLE = [
        'title', 'description', 'trigger', 'language', 'category',
        'knowledge_type', 'complexity', 'scope', 'difficulty',
        'summary_cn', 'summary_en', 'usage_guide_cn', 'usage_guide_en',
        'content', 'relations', 'constraints', 'reasoning',
        'tags', 'headers', 'header_paths', 'module_name', 'include_headers',
        'agent_notes', 'ai_insight',
      ];

      const dbUpdates = {};

      for (const key of UPDATABLE) {
        if (data[key] === undefined) continue;

        switch (key) {
          // 标量字段直接映射
          case 'title':
          case 'description':
          case 'trigger':
          case 'language':
          case 'category':
          case 'complexity':
          case 'scope':
          case 'difficulty':
          case 'agent_notes':
          case 'ai_insight':
            dbUpdates[key === 'trigger' ? 'trigger_key' : key] = data[key];
            break;

          case 'summary_cn':
          case 'summary_en':
          case 'usage_guide_cn':
          case 'usage_guide_en':
            dbUpdates[key] = data[key];
            break;

          case 'knowledge_type':
            dbUpdates.knowledge_type = data.knowledge_type;
            // 联动更新 kind
            dbUpdates.kind = inferKind(data.knowledge_type);
            break;

          // 值对象字段 → JSON 列（V3 列名无 _json 后缀）
          case 'content':
            dbUpdates.content = JSON.stringify(data.content);
            break;
          case 'relations':
            dbUpdates.relations = JSON.stringify(data.relations);
            break;
          case 'constraints':
            dbUpdates.constraints = JSON.stringify(data.constraints);
            break;
          case 'reasoning':
            dbUpdates.reasoning = JSON.stringify(data.reasoning);
            break;

          // 数组 → JSON
          case 'tags':
            dbUpdates.tags = JSON.stringify(data.tags);
            break;
          case 'headers':
            dbUpdates.headers = JSON.stringify(data.headers);
            break;
          case 'header_paths':
            dbUpdates.header_paths = JSON.stringify(data.header_paths);
            break;

          // 布尔/标量
          case 'module_name':
          case 'include_headers':
            dbUpdates[key] = data[key];
            break;
        }
      }

      if (Object.keys(dbUpdates).length === 0) {
        throw new ValidationError('No updatable fields provided');
      }

      dbUpdates.updated_at = Math.floor(Date.now() / 1000);

      const updated = await this.repository.update(id, dbUpdates);

      // 若 relations 变更，同步到 knowledge_edges
      if (dbUpdates.relations) {
        this._syncRelationsToGraph(id, data.relations);
      }

      // 落盘
      this._persistToFile(updated);

      await this._audit('update_knowledge', id, context.userId, {
        fields: Object.keys(dbUpdates),
      });

      this.logger.info('Knowledge entry updated', {
        id, updatedBy: context.userId, fields: Object.keys(dbUpdates),
      });

      return updated;
    } catch (error) {
      this.logger.error('Error updating knowledge entry', {
        id, error: error.message,
      });
      throw error;
    }
  }

  /**
   * 删除知识条目
   * @param {string} id
   * @param {Object} context - { userId }
   * @returns {Promise<{ success: boolean, id: string }>}
   */
  async delete(id, context) {
    try {
      const entry = await this._findOrThrow(id);

      // 删除 .md 文件
      this._removeFile(entry);

      // 清除 knowledge_edges
      this._removeAllEdges(id);

      await this.repository.delete(id);

      await this._audit('delete_knowledge', id, context.userId, {
        title: entry.title,
      });

      this.logger.info('Knowledge entry deleted', {
        id, deletedBy: context.userId, title: entry.title,
      });

      return { success: true, id };
    } catch (error) {
      this.logger.error('Error deleting knowledge entry', {
        id, error: error.message,
      });
      throw error;
    }
  }

  /* ═══ 生命周期操作 ══════════════════════════════════════ */

  /**
   * 发布 (pending → active) — 仅开发者可执行
   */
  async publish(id, context) {
    return this._lifecycleTransition(id, 'publish', context, {
      entityArgs: [context.userId],
    });
  }

  /**
   * 弃用 (pending|active → deprecated)
   */
  async deprecate(id, reason, context) {
    if (!reason || reason.trim().length === 0) {
      throw new ValidationError('Deprecation reason is required');
    }
    return this._lifecycleTransition(id, 'deprecate', context, {
      entityArgs: [reason],
    });
  }

  /**
   * 重新激活 (deprecated → pending)
   */
  async reactivate(id, context) {
    return this._lifecycleTransition(id, 'reactivate', context);
  }

  // ── 向后兼容别名 ──

  /** @deprecated 简化后所有条目直接进 pending */
  async submit(id, context) { return this.get(id); }

  /** @deprecated 简化后 approve = publish */
  async approve(id, context) { return this.publish(id, context); }

  /** @deprecated 简化后无需 autoApprove */
  async autoApprove(id, context) { return this.get(id); }

  /** @deprecated 简化后 reject = deprecate */
  async reject(id, reason, context) { return this.deprecate(id, reason, context); }

  /** @deprecated 简化后 toDraft = reactivate */
  async toDraft(id, context) { return this.reactivate(id, context); }

  /** @deprecated 简化后 fastTrack = publish */
  async fastTrack(id, context) { return this.publish(id, context); }

  /* ═══ 查询 ══════════════════════════════════════════════ */

  /**
   * 查询列表
   * @param {Object} filters - { lifecycle, kind, language, category, knowledge_type, source, tag }
   * @param {Object} pagination - { page, pageSize }
   */
  async list(filters = {}, pagination = {}) {
    try {
      const { lifecycle, kind, language, category, knowledgeType, source, tag, scope } = filters;
      const { page = 1, pageSize = 20 } = pagination;

      const dbFilters = {};
      if (lifecycle)     dbFilters.lifecycle = lifecycle;
      if (kind)          dbFilters.kind = kind;
      if (language)      dbFilters.language = language;
      if (category)      dbFilters.category = category;
      if (knowledgeType) dbFilters.knowledge_type = knowledgeType;
      if (source)        dbFilters.source = source;
      if (scope)         dbFilters.scope = scope;
      if (tag)           dbFilters._tagLike = tag;

      return this.repository.findWithPagination(dbFilters, { page, pageSize });
    } catch (error) {
      this.logger.error('Error listing knowledge entries', {
        error: error.message, filters,
      });
      throw error;
    }
  }

  /**
   * 按 Kind 查询
   */
  async listByKind(kind, pagination = {}) {
    try {
      const { page = 1, pageSize = 20 } = pagination;
      return this.repository.findByKind(kind, { page, pageSize });
    } catch (error) {
      this.logger.error('Error listing by kind', { kind, error: error.message });
      throw error;
    }
  }

  /**
   * 搜索
   */
  async search(keyword, pagination = {}) {
    try {
      const { page = 1, pageSize = 20 } = pagination;
      return this.repository.search(keyword, { page, pageSize });
    } catch (error) {
      this.logger.error('Error searching knowledge', {
        keyword, error: error.message,
      });
      throw error;
    }
  }

  /**
   * 获取统计信息
   */
  async getStats() {
    try {
      return this.repository.getStats();
    } catch (error) {
      this.logger.error('Error getting knowledge stats', {
        error: error.message,
      });
      throw error;
    }
  }

  /* ═══ 使用/质量 ═════════════════════════════════════════ */

  /**
   * 增加使用计数
   * @param {string} id
   * @param {'adoption'|'application'|'guard_hit'|'view'|'success'} type
   * @param {Object} [options] - { actor, feedback }
   */
  async incrementUsage(id, type = 'adoption', options = {}) {
    try {
      const entry = await this._findOrThrow(id);
      entry.stats.increment(type);

      const statsJson = entry.stats.toJSON();
      await this.repository.update(id, {
        stats_json: JSON.stringify(statsJson),
        updated_at: Math.floor(Date.now() / 1000),
      });

      await this._audit(`knowledge_${type}`, id, options.actor || 'system', {
        feedback: options.feedback,
      });

      this.logger.debug(`Knowledge ${type} incremented`, { id, type });

      return entry;
    } catch (error) {
      this.logger.error(`Error incrementing knowledge ${type}`, {
        id, error: error.message,
      });
      throw error;
    }
  }

  /**
   * 更新质量评分
   * @param {string} id
   * @param {Object} [context] - { userId }
   */
  async updateQuality(id, context = {}) {
    try {
      const entry = await this._findOrThrow(id);

      if (!this._qualityScorer) {
        throw new ValidationError('QualityScorer not configured');
      }

      // 为 QualityScorer 适配输入字段
      const scorerInput = this._adaptForScorer(entry);
      const result = this._qualityScorer.score(scorerInput);

      // 更新 Quality 值对象
      await this.repository.update(id, {
        quality_json: JSON.stringify({
          completeness:          result.dimensions.completeness,
          project_adaptation:    result.dimensions.metadata,
          documentation_clarity: result.dimensions.format,
          overall:               result.score,
          grade:                 result.grade,
        }),
        updated_at: Math.floor(Date.now() / 1000),
      });

      if (context.userId) {
        await this._audit('update_knowledge_quality', id, context.userId, {
          score: result.score,
          grade: result.grade,
        });
      }

      this.logger.info('Knowledge quality updated', {
        id, score: result.score, grade: result.grade,
      });

      return result;
    } catch (error) {
      this.logger.error('Error updating knowledge quality', {
        id, error: error.message,
      });
      throw error;
    }
  }

  /* ═══ 私有方法 ══════════════════════════════════════════ */

  /**
   * 统一生命周期转换编排
   */
  async _lifecycleTransition(id, method, context, options = {}) {
    try {
      const entry = await this._findOrThrow(id);
      const prevLifecycle = entry.lifecycle;

      const entityArgs = options.entityArgs || [];
      const result = entry[method](...entityArgs);

      if (!result.success) {
        throw new ConflictError(
          result.error,
          `Lifecycle ${method} failed for ${id}`,
        );
      }

      // 构建 DB 更新
      const dbUpdates = {
        lifecycle:            entry.lifecycle,
        lifecycle_history_json: JSON.stringify(entry.lifecycleHistory),
        updated_at:           entry.updatedAt,
      };

      // 审核字段
      if (entry.reviewedBy) dbUpdates.reviewed_by = entry.reviewedBy;
      if (entry.reviewedAt) dbUpdates.reviewed_at = entry.reviewedAt;
      if (entry.rejectionReason !== null) dbUpdates.rejection_reason = entry.rejectionReason;

      // 发布字段
      if (entry.publishedAt) dbUpdates.published_at = entry.publishedAt;
      if (entry.publishedBy) dbUpdates.published_by = entry.publishedBy;
      if (entry.autoApprovable !== undefined) dbUpdates.probation = entry.autoApprovable ? 1 : 0;

      const updated = await this.repository.update(id, dbUpdates);

      // 文件位置迁移（candidate ↔ recipe 目录）
      if (this._fileWriter) {
        try {
          this._fileWriter.moveOnLifecycleChange(updated);
        } catch (err) {
          this.logger.warn('moveOnLifecycleChange failed (non-blocking)', {
            id, error: err.message,
          });
        }
      }

      await this._audit(`${method}_knowledge`, id, context.userId, {
        from: prevLifecycle,
        to: entry.lifecycle,
      });

      this.logger.info(`Knowledge entry ${method}`, {
        id, from: prevLifecycle, to: entry.lifecycle,
        actor: context.userId,
      });

      return updated;
    } catch (error) {
      this.logger.error(`Error in lifecycle ${method}`, {
        id, error: error.message,
      });
      throw error;
    }
  }

  /**
   * 查找或抛出 NotFoundError
   */
  async _findOrThrow(id) {
    const entry = await this.repository.findById(id);
    if (!entry) {
      throw new NotFoundError('Knowledge entry not found', 'knowledge', id);
    }
    return entry;
  }

  /**
   * 验证创建输入
   */
  _validateCreateInput(data) {
    if (!data.title || !data.title.trim()) {
      throw new ValidationError('Title is required');
    }

    // 内容至少需要 content 对象有内容
    const c = data.content || {};
    if (!c.pattern && !c.rationale && !(c.steps?.length > 0) && !c.markdown) {
      throw new ValidationError('Content is required (pattern, rationale, steps, or markdown)');
    }
  }

  /**
   * 为 QualityScorer 适配输入
   * QualityScorer 需要: title, trigger, code, language, category, summary, usageGuide, headers, tags
   */
  _adaptForScorer(entry) {
    return {
      title:      entry.title,
      trigger:    entry.trigger,
      code:       entry.content?.pattern || entry.content?.markdown || '',
      language:   entry.language,
      category:   entry.category,
      summary:    entry.summaryCn || entry.summaryEn || '',
      usageGuide: entry.usageGuideCn || entry.usageGuideEn || '',
      headers:    entry.headers || [],
      tags:       entry.tags || [],
    };
  }

  /* ═══ Knowledge Graph 同步 ═══════════════════════════ */

  /**
   * 将 relations 同步到 knowledge_edges 表
   */
  _syncRelationsToGraph(id, relations) {
    const gs = this._knowledgeGraphService;
    if (!gs) return;

    try {
      gs.db.prepare(
        `DELETE FROM knowledge_edges WHERE from_id = ? AND from_type = 'knowledge'`
      ).run(id);

      if (!relations || typeof relations !== 'object') return;

      // Relations 可能是 Relations 值对象或普通对象
      const relObj = typeof relations.toJSON === 'function' ? relations.toJSON() : relations;

      for (const [relType, targets] of Object.entries(relObj)) {
        if (!Array.isArray(targets)) continue;
        for (const t of targets) {
          const targetId = t.target || t.id || (typeof t === 'string' ? t : null);
          if (targetId) {
            gs.addEdge(id, 'knowledge', targetId, 'knowledge', relType, {
              weight: t.weight || 1.0,
            });
          }
        }
      }
    } catch (err) {
      this.logger.warn('Failed to sync relations to knowledge_edges', {
        id, error: err.message,
      });
    }
  }

  /**
   * 删除所有关联边
   */
  _removeAllEdges(id) {
    const gs = this._knowledgeGraphService;
    if (!gs) return;

    try {
      gs.db.prepare(
        `DELETE FROM knowledge_edges WHERE from_id = ? OR to_id = ?`
      ).run(id, id);
    } catch (err) {
      this.logger.warn('Failed to remove edges', { id, error: err.message });
    }
  }

  /* ═══ 文件落盘 ═══════════════════════════════════════ */

  /**
   * 落盘到 .md 文件 + 回写 source_file
   */
  _persistToFile(entry) {
    if (!this._fileWriter) return;
    try {
      const oldSourceFile = entry.sourceFile;
      this._fileWriter.persist(entry);
      if (entry.sourceFile && entry.sourceFile !== oldSourceFile) {
        this.repository.update(entry.id, { source_file: entry.sourceFile }).catch(err => {
          this.logger.warn('Failed to update source_file in DB', {
            id: entry.id, error: err.message,
          });
        });
      }
    } catch (err) {
      this.logger.warn('Knowledge file persist failed (non-blocking)', {
        id: entry?.id, error: err.message,
      });
    }
  }

  /**
   * 删除 .md 文件
   */
  _removeFile(entry) {
    if (!this._fileWriter) return;
    try {
      this._fileWriter.remove(entry);
    } catch (err) {
      this.logger.warn('Knowledge file remove failed (non-blocking)', {
        id: entry?.id, error: err.message,
      });
    }
  }

  /* ═══ 审计日志 ═══════════════════════════════════════ */

  async _audit(action, id, actor, details = {}) {
    try {
      await this.auditLogger.log({
        action,
        resourceType: 'knowledge',
        resourceId: id,
        resource: `knowledge:${id}`,
        actor: actor || 'system',
        result: 'success',
        details: typeof details === 'string' ? details : JSON.stringify(details),
        timestamp: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      this.logger.warn('Audit log failed (non-blocking)', {
        action, id, error: err.message,
      });
    }
  }
}

export default KnowledgeService;

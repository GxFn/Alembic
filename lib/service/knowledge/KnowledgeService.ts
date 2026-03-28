import { KnowledgeEntry, type KnowledgeEntryProps } from '../../domain/knowledge/KnowledgeEntry.js';
import type { KnowledgeRepository } from '../../domain/knowledge/KnowledgeRepository.js';
import { inferKind, Lifecycle } from '../../domain/knowledge/Lifecycle.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/index.js';
import type { ConfidenceRouter } from './ConfidenceRouter.js';
import type { KnowledgeFileWriter } from './KnowledgeFileWriter.js';
import type { KnowledgeGraphService } from './KnowledgeGraphService.js';

interface AuditLoggerLike {
  log(entry: Record<string, unknown>): Promise<void>;
}

interface SkillHooksLike {
  run(
    hookName: string,
    ...args: unknown[]
  ): Promise<{ block?: boolean; reason?: string } | undefined>;
}

interface QualityScorerLike {
  score(input: Record<string, unknown>): {
    score: number;
    dimensions: Record<string, number>;
    grade: string;
  };
}

interface EventBusLike {
  emit(event: string | symbol, ...args: unknown[]): boolean;
}

interface KnowledgeServiceOptions {
  fileWriter?: KnowledgeFileWriter | null;
  skillHooks?: SkillHooksLike | null;
  confidenceRouter?: ConfidenceRouter | null;
  qualityScorer?: QualityScorerLike | null;
  eventBus?: EventBusLike | null;
}

interface ServiceContext {
  userId: string;
}

interface ListFilters {
  lifecycle?: string;
  kind?: string;
  language?: string;
  category?: string;
  knowledgeType?: string;
  source?: string;
  tag?: string;
  scope?: string;
}

interface PaginationOptions {
  page?: number;
  pageSize?: number;
}

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
  _confidenceRouter: ConfidenceRouter | null;
  _eventBus: EventBusLike | null;
  _fileWriter: KnowledgeFileWriter | null;
  _knowledgeGraphService: KnowledgeGraphService | null;
  _qualityScorer: QualityScorerLike | null;
  _skillHooks: SkillHooksLike | null;
  auditLogger: AuditLoggerLike;
  gateway: unknown;
  logger: ReturnType<typeof Logger.getInstance>;
  repository: KnowledgeRepository;
  constructor(
    repository: KnowledgeRepository,
    auditLogger: AuditLoggerLike,
    gateway: unknown,
    knowledgeGraphService: KnowledgeGraphService | null,
    options: KnowledgeServiceOptions = {}
  ) {
    this.repository = repository;
    this.auditLogger = auditLogger;
    this.gateway = gateway;
    this._knowledgeGraphService = knowledgeGraphService || null;
    this._fileWriter = options.fileWriter || null;
    this._skillHooks = options.skillHooks || null;
    this._confidenceRouter = options.confidenceRouter || null;
    this._qualityScorer = options.qualityScorer || null;
    this._eventBus = options.eventBus || null;
    this.logger = Logger.getInstance();
  }

  /* ═══ CRUD ══════════════════════════════════════════════ */

  /**
   * 创建知识条目
   *
   * MCP 参数 = wire format → KnowledgeEntry.fromJSON() 直接构造。
   * 所有新条目初始状态为 pending（待审核）。
   * ConfidenceRouter 仅标记 auto_approvable 标志，不改变 lifecycle。
   *
   * @param data wire format 数据
   * @param context { userId }
   */
  async create(data: KnowledgeEntryProps, context: ServiceContext) {
    try {
      this._validateCreateInput(data);

      const entry = KnowledgeEntry.fromJSON({
        ...data,
        lifecycle: Lifecycle.PENDING,
        source: data.source || 'manual',
        createdBy: context.userId,
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

      // ── ConfidenceRouter — 标记 auto_approvable ──
      if (this._confidenceRouter) {
        const route = await this._confidenceRouter.route(entry);
        if (route.action === 'auto_approve') {
          entry.autoApprovable = true;
        }
        // reject / pending 都保持 pending 状态，等待人工审核
      }

      // 注意: Bootstrap 候选保持 pending 状态，由 Dashboard 审核后发布。
      // autoApprovable 标记保留，供前端显示「推荐批准」徽章。
      // CursorDelivery 已支持高置信度 pending 条目的交付。

      const saved = await this.repository.create(entry);

      // 同步 relations → knowledge_edges
      this._syncRelationsToGraph(saved.id, saved.relations);

      // 自动发现同域条目建立 related 边（best effort, 不阻塞）
      this._autoDiscoverRelations(saved.id, saved).catch((err) =>
        this.logger.warn('_autoDiscoverRelations error', { id: saved.id, error: err.message })
      );

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
        this._skillHooks
          .run('onKnowledgeCreated', saved, {
            userId: context.userId,
          })
          .catch((err: unknown) =>
            this.logger.warn('SkillHook onKnowledgeCreated error', {
              error: err instanceof Error ? err.message : String(err),
            })
          );
      }

      // ── EventBus: 通知 VectorService 同步向量索引 ──
      if (this._eventBus) {
        this._eventBus.emit('knowledge:changed', {
          action: 'create',
          entryId: saved.id,
          entry: { id: saved.id, title: saved.title, content: saved.content, kind: saved.kind },
        });
      }

      return saved;
    } catch (error: unknown) {
      this.logger.error('Error creating knowledge entry', {
        error: error instanceof Error ? error.message : String(error),
        data,
      });
      throw error;
    }
  }

  /** 获取单个知识条目 */
  async get(id: string) {
    const entry = await this.repository.findById(id);
    if (!entry) {
      throw new NotFoundError('Knowledge entry not found', 'knowledge', id);
    }
    return entry;
  }

  /**
   * 更新知识条目（仅允许白名单字段）
   * @param data 部分字段（camelCase）
   * @param context { userId }
   */
  async update(id: string, data: Partial<KnowledgeEntryProps>, context: ServiceContext) {
    try {
      const _entry = await this._findOrThrow(id);

      const UPDATABLE = [
        'title',
        'description',
        'trigger',
        'language',
        'category',
        'knowledgeType',
        'complexity',
        'scope',
        'difficulty',
        'content',
        'relations',
        'constraints',
        'reasoning',
        'tags',
        'headers',
        'headerPaths',
        'moduleName',
        'includeHeaders',
        'agentNotes',
        'aiInsight',
        // Cursor 交付字段
        'topicHint',
        'whenClause',
        'doClause',
        'dontClause',
        'coreCode',
        'usageGuide',
      ];

      const dbUpdates: Record<string, unknown> = {};

      for (const key of UPDATABLE) {
        if (data[key] === undefined) {
          continue;
        }

        switch (key) {
          // 标量字段直传
          case 'title':
          case 'description':
          case 'trigger':
          case 'language':
          case 'category':
          case 'complexity':
          case 'scope':
          case 'difficulty':
          case 'agentNotes':
          case 'aiInsight':
          case 'moduleName':
          case 'includeHeaders':
          case 'topicHint':
          case 'whenClause':
          case 'doClause':
          case 'dontClause':
          case 'coreCode':
            dbUpdates[key] = data[key];
            break;

          case 'knowledgeType':
            dbUpdates.knowledgeType = data.knowledgeType;
            dbUpdates.kind = inferKind(data.knowledgeType ?? '');
            break;

          // 值对象 / 数组字段 — 直传原始值，Repository._entityToRow 负责序列化
          case 'content':
          case 'relations':
          case 'constraints':
          case 'reasoning':
          case 'headers':
          case 'headerPaths':
            dbUpdates[key] = data[key];
            break;

          // tags 需要特殊处理：API 返回时已过滤系统标签，保存时需要合并回来
          case 'tags': {
            const existingSystemTags = (_entry.tags || []).filter((t: string) =>
              KnowledgeEntry.isSystemTag(t)
            );
            const incomingUserTags = (data.tags || []).filter(
              (t: string) => !KnowledgeEntry.isSystemTag(t)
            );
            dbUpdates.tags = [...incomingUserTags, ...existingSystemTags];
            break;
          }
        }
      }

      if (Object.keys(dbUpdates).length === 0) {
        throw new ValidationError('No updatable fields provided');
      }

      dbUpdates.updatedAt = Math.floor(Date.now() / 1000);

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
        id,
        updatedBy: context.userId,
        fields: Object.keys(dbUpdates),
      });

      // ── EventBus: 通知 VectorService 同步向量索引 ──
      if (this._eventBus) {
        this._eventBus.emit('knowledge:changed', {
          action: 'update',
          entryId: id,
          entry: {
            id: updated.id,
            title: updated.title,
            content: updated.content,
            kind: updated.kind,
          },
        });
      }

      return updated;
    } catch (error: unknown) {
      this.logger.error('Error updating knowledge entry', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * 删除知识条目
   * @param context { userId }
   * @returns >}
   */
  async delete(id: string, context: ServiceContext) {
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
        id,
        deletedBy: context.userId,
        title: entry.title,
      });

      // ── EventBus: 通知 VectorService 移除向量索引 ──
      if (this._eventBus) {
        this._eventBus.emit('knowledge:deleted', { entryId: id });
      }

      return { success: true, id };
    } catch (error: unknown) {
      this.logger.error('Error deleting knowledge entry', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /* ═══ 生命周期操作 ══════════════════════════════════════ */

  /** 发布 (pending → active) — 仅开发者可执行 */
  async publish(id: string, context: ServiceContext) {
    const result = await this._lifecycleTransition(id, 'publish', context, {
      entityArgs: [context.userId],
    });

    // 发布后触发 Cursor Delivery 增量更新（非阻塞）
    this._triggerCursorDeliveryAsync();

    return result;
  }

  /**
   * 触发 Cursor Delivery Pipeline（非阻塞、容错）
   */
  _triggerCursorDeliveryAsync() {
    import('../../injection/ServiceContainer.js')
      .then(({ getServiceContainer }) => {
        const container = getServiceContainer();
        if (container.services.cursorDeliveryPipeline) {
          const pipeline = container.get('cursorDeliveryPipeline');
          pipeline.deliver().catch(() => {
            /* ignore */
          });
        }
      })
      .catch(() => {
        // ServiceContainer 未初始化或服务不可用 — 静默忽略
      });
  }

  /** 弃用 (pending|active → deprecated) */
  async deprecate(id: string, reason: string, context: ServiceContext) {
    if (!reason || reason.trim().length === 0) {
      throw new ValidationError('Deprecation reason is required');
    }
    return this._lifecycleTransition(id, 'deprecate', context, {
      entityArgs: [reason],
    });
  }

  /** 重新激活 (deprecated → pending) */
  async reactivate(id: string, context: ServiceContext) {
    return this._lifecycleTransition(id, 'reactivate', context);
  }

  // ── 向后兼容别名 ──

  /** @deprecated 简化后所有条目直接进 pending */
  async submit(id: string, _context: ServiceContext) {
    return this.get(id);
  }

  /** @deprecated 简化后 approve = publish */
  async approve(id: string, context: ServiceContext) {
    return this.publish(id, context);
  }

  /** @deprecated 简化后无需 autoApprove */
  async autoApprove(id: string, _context: ServiceContext) {
    return this.get(id);
  }

  /** @deprecated 简化后 reject = deprecate */
  async reject(id: string, reason: string, context: ServiceContext) {
    return this.deprecate(id, reason, context);
  }

  /** @deprecated 简化后 toDraft = reactivate */
  async toDraft(id: string, context: ServiceContext) {
    return this.reactivate(id, context);
  }

  /** @deprecated 简化后 fastTrack = publish */
  async fastTrack(id: string, context: ServiceContext) {
    return this.publish(id, context);
  }

  /* ═══ 查询 ══════════════════════════════════════════════ */

  /**
   * 查询列表
   * @param filters { lifecycle, kind, language, category, knowledgeType, source, tag }
   * @param pagination { page, pageSize }
   */
  async list(filters: ListFilters = {}, pagination: PaginationOptions = {}) {
    try {
      const { lifecycle, kind, language, category, knowledgeType, source, tag, scope } = filters;
      const { page = 1, pageSize = 20 } = pagination;

      const dbFilters: Record<string, unknown> = {};
      if (lifecycle) {
        dbFilters.lifecycle = lifecycle;
      }
      if (kind) {
        dbFilters.kind = kind;
      }
      if (language) {
        dbFilters.language = language;
      }
      if (category) {
        dbFilters.category = category;
      }
      if (knowledgeType) {
        dbFilters.knowledgeType = knowledgeType;
      }
      if (source) {
        dbFilters.source = source;
      }
      if (scope) {
        dbFilters.scope = scope;
      }
      if (tag) {
        dbFilters._tagLike = tag;
      }

      return this.repository.findWithPagination(dbFilters, { page, pageSize });
    } catch (error: unknown) {
      this.logger.error('Error listing knowledge entries', {
        error: error instanceof Error ? error.message : String(error),
        filters,
      });
      throw error;
    }
  }

  /** 按 Kind 查询 */
  async listByKind(kind: string, pagination: PaginationOptions = {}) {
    try {
      const { page = 1, pageSize = 20 } = pagination;
      return this.repository.findByKind(kind, { page, pageSize });
    } catch (error: unknown) {
      this.logger.error('Error listing by kind', {
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** 搜索 */
  async search(keyword: string, pagination: PaginationOptions = {}) {
    try {
      const { page = 1, pageSize = 20 } = pagination;
      return this.repository.search(keyword, { page, pageSize });
    } catch (error: unknown) {
      this.logger.error('Error searching knowledge', {
        keyword,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** 获取统计信息 */
  async getStats() {
    try {
      return this.repository.getStats();
    } catch (error: unknown) {
      this.logger.error('Error getting knowledge stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /* ═══ 使用/质量 ═════════════════════════════════════ */

  /**
   * 增加使用计数
   * @param [options] { actor, feedback }
   */
  async incrementUsage(
    id: string,
    type = 'adoption',
    options: { actor?: string; feedback?: string } = {}
  ) {
    try {
      const entry = await this._findOrThrow(id);
      entry.stats.increment(
        type as 'views' | 'adoptions' | 'applications' | 'guardHits' | 'searchHits'
      );

      const statsJson = entry.stats.toJSON();
      await this.repository.update(id, {
        stats: JSON.stringify(statsJson),
        updatedAt: Math.floor(Date.now() / 1000),
      });

      await this._audit(`knowledge_${type}`, id, options.actor || 'system', {
        feedback: options.feedback,
      });

      this.logger.debug(`Knowledge ${type} incremented`, { id, type });

      return entry;
    } catch (error: unknown) {
      this.logger.error(`Error incrementing knowledge ${type}`, {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * 更新质量评分
   * @param [context] { userId }
   */
  async updateQuality(id: string, context: Partial<ServiceContext> = {}) {
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
        quality: JSON.stringify({
          completeness: result.dimensions.completeness,
          adaptation: result.dimensions.metadata,
          documentation: result.dimensions.format,
          overall: result.score,
          grade: result.grade,
        }),
        updatedAt: Math.floor(Date.now() / 1000),
      });

      if (context.userId) {
        await this._audit('update_knowledge_quality', id, context.userId, {
          score: result.score,
          grade: result.grade,
        });
      }

      this.logger.info('Knowledge quality updated', {
        id,
        score: result.score,
        grade: result.grade,
      });

      return result;
    } catch (error: unknown) {
      this.logger.error('Error updating knowledge quality', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /* ═══ 私有方法 ══════════════════════════════════════════ */

  /** 统一生命周期转换编排 */
  async _lifecycleTransition(
    id: string,
    method: string,
    context: ServiceContext,
    options: { entityArgs?: unknown[] } = {}
  ) {
    try {
      const entry = await this._findOrThrow(id);
      const prevLifecycle = entry.lifecycle;

      const entityArgs = options.entityArgs || [];
      const result = (
        entry as unknown as Record<
          string,
          (...args: unknown[]) => { success: boolean; error?: string }
        >
      )[method](...entityArgs);

      if (!result.success) {
        throw new ConflictError(result.error || 'Lifecycle transition failed', {
          detail: `Lifecycle ${method} failed for ${id}`,
        });
      }

      // 构建 DB 更新
      // 注意: 不在此处 JSON.stringify — repository.update() 内部
      // 通过 _entityToRow() 统一执行序列化, 传入原始值即可
      const dbUpdates: Record<string, unknown> = {
        lifecycle: entry.lifecycle,
        lifecycleHistory: entry.lifecycleHistory,
        updatedAt: entry.updatedAt,
      };

      // 审核字段
      if (entry.reviewedBy) {
        dbUpdates.reviewedBy = entry.reviewedBy;
      }
      if (entry.reviewedAt) {
        dbUpdates.reviewedAt = entry.reviewedAt;
      }
      if (entry.rejectionReason !== null) {
        dbUpdates.rejectionReason = entry.rejectionReason;
      }

      // 发布字段
      if (entry.publishedAt) {
        dbUpdates.publishedAt = entry.publishedAt;
      }
      if (entry.publishedBy) {
        dbUpdates.publishedBy = entry.publishedBy;
      }
      if (entry.autoApprovable !== undefined) {
        dbUpdates.autoApprovable = entry.autoApprovable ? 1 : 0;
      }

      const updated = await this.repository.update(id, dbUpdates);

      // 文件位置迁移（candidate ↔ recipe 目录）
      if (this._fileWriter) {
        try {
          this._fileWriter.moveOnLifecycleChange(updated);
        } catch (err: unknown) {
          this.logger.warn('moveOnLifecycleChange failed (non-blocking)', {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await this._audit(`${method}_knowledge`, id, context.userId, {
        from: prevLifecycle,
        to: entry.lifecycle,
      });

      this.logger.info(`Knowledge entry ${method}`, {
        id,
        from: prevLifecycle,
        to: entry.lifecycle,
        actor: context.userId,
      });

      // EventBus: 通知生命周期状态转换（Dashboard 实时更新 + SignalBus）
      if (this._eventBus) {
        this._eventBus.emit('lifecycle:transition', {
          entryId: id,
          from: prevLifecycle,
          to: entry.lifecycle,
          method,
          actor: context.userId,
        });
      }

      return updated;
    } catch (error: unknown) {
      this.logger.error(`Error in lifecycle ${method}`, {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** 查找或抛出 NotFoundError */
  async _findOrThrow(id: string): Promise<KnowledgeEntry> {
    const entry = await this.repository.findById(id);
    if (!entry) {
      throw new NotFoundError('Knowledge entry not found', 'knowledge', id);
    }
    return entry;
  }

  /** 验证创建输入 */
  _validateCreateInput(data: KnowledgeEntryProps) {
    if (!data.title || !data.title.trim()) {
      throw new ValidationError('Title is required');
    }

    // 内容至少需要 content 对象有内容
    const c = (data.content || {}) as Record<string, unknown>;
    if (
      !c.pattern &&
      !c.rationale &&
      !((c.steps as unknown[] | undefined)?.length && (c.steps as unknown[]).length > 0) &&
      !c.markdown
    ) {
      throw new ValidationError('Content is required (pattern, rationale, steps, or markdown)');
    }
  }

  /**
   * 为 QualityScorer 适配输入
   * QualityScorer 需要: title, trigger, code, language, category, summary, usageGuide, headers, tags
   */
  _adaptForScorer(entry: KnowledgeEntry): Record<string, unknown> {
    // 从 Stats 值对象提取 engagement 指标，映射到 QualityScorer 期望的 views/clicks/rating
    const stats =
      entry.stats && typeof entry.stats === 'object'
        ? (entry.stats as unknown as Record<string, number>)
        : ({} as Record<string, number>);
    return {
      title: entry.title,
      trigger: entry.trigger,
      code: entry.content?.pattern || entry.content?.markdown || '',
      language: entry.language,
      category: entry.category,
      summary: entry.description || '',
      usageGuide: entry.content?.markdown || entry.doClause || '',
      headers: entry.headers || [],
      tags: entry.tags || [],
      // engagement: views → views, adoptions+applications → clicks, authority → rating
      views: (stats.views ?? 0) + (stats.searchHits ?? 0),
      clicks: (stats.adoptions ?? 0) + (stats.applications ?? 0) + (stats.guardHits ?? 0),
      rating: stats.authority ?? 0,
    };
  }

  /* ═══ Knowledge Graph 同步 ═══════════════════════════ */

  /**
   * 自动发现同 category/moduleName/tags 的已有条目并建立 'related' 边
   * @param id 新创建的条目 ID
   * @param entry 条目实体
   */
  async _autoDiscoverRelations(id: string, entry: KnowledgeEntry) {
    const gs = this._knowledgeGraphService;
    if (!gs) {
      return;
    }

    try {
      const candidates: { target: string; relation: string; weight: number }[] = [];

      // 仅与已发布 Recipe（active）建立关联，不与其他候选（pending）互关联
      const activeOnly = { lifecycle: Lifecycle.ACTIVE };

      // 按 moduleName 查同模块已发布条目
      if (entry.moduleName) {
        const sameModule = await this.repository.findWithPagination(
          { ...activeOnly, moduleName: entry.moduleName },
          { page: 1, pageSize: 20 }
        );
        for (const r of sameModule.data) {
          if (r.id !== id) {
            candidates.push({ target: r.id, relation: 'related', weight: 0.8 });
          }
        }
      }

      // 按 category 查同类已发布条目（弱关联）
      if (entry.category && candidates.length < 10) {
        const sameCat = await this.repository.findWithPagination(
          { ...activeOnly, category: entry.category },
          { page: 1, pageSize: 10 }
        );
        for (const r of sameCat.data) {
          if (r.id !== id && !candidates.some((c) => c.target === r.id)) {
            candidates.push({ target: r.id, relation: 'related', weight: 0.4 });
          }
        }
      }

      // 写入 edges（限制最多 10 条自动关联）
      for (const c of candidates.slice(0, 10)) {
        try {
          gs.addEdge(id, 'knowledge', c.target, 'knowledge', c.relation, { weight: c.weight });
        } catch {
          /* ignore duplicates */
        }
      }

      // 将发现的关系写回 entry 的 relations 字段
      if (candidates.length > 0) {
        const relatedItems = candidates.slice(0, 10).map((c) => ({
          target: c.target,
          description: 'auto-discovered',
        }));
        const existingRelations: Record<string, unknown[]> = (
          typeof entry.relations?.toJSON === 'function'
            ? entry.relations.toJSON()
            : entry.relations || {}
        ) as Record<string, unknown[]>;
        const merged = {
          ...existingRelations,
          related: [...(existingRelations['related'] || []), ...relatedItems],
        };
        await this.repository.update(id, {
          relations: JSON.stringify(merged),
          updatedAt: Math.floor(Date.now() / 1000),
        });
      }
    } catch (err: unknown) {
      this.logger.warn('Auto-discover relations failed (non-blocking)', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 将 relations 同步到 knowledge_edges 表 */
  _syncRelationsToGraph(id: string, relations: unknown) {
    const gs = this._knowledgeGraphService;
    if (!gs) {
      return;
    }

    try {
      gs.db
        .prepare(`DELETE FROM knowledge_edges WHERE from_id = ? AND from_type = 'knowledge'`)
        .run(id);

      if (!relations || typeof relations !== 'object') {
        return;
      }

      // Relations 可能是 Relations 值对象或普通对象
      const relObj = (
        typeof (relations as { toJSON?: () => Record<string, unknown> }).toJSON === 'function'
          ? (relations as { toJSON: () => Record<string, unknown> }).toJSON()
          : relations
      ) as Record<string, unknown[]>;

      for (const [relType, targets] of Object.entries(relObj)) {
        if (!Array.isArray(targets)) {
          continue;
        }
        for (const t of targets) {
          const item = t as Record<string, unknown>;
          const targetId =
            (item.target as string) || (item.id as string) || (typeof t === 'string' ? t : null);
          if (targetId) {
            gs.addEdge(id, 'knowledge', targetId, 'knowledge', relType, {
              weight: (item.weight as number) || 1.0,
            });
          }
        }
      }
    } catch (err: unknown) {
      this.logger.warn('Failed to sync relations to knowledge_edges', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 删除所有关联边 */
  _removeAllEdges(id: string) {
    const gs = this._knowledgeGraphService;
    if (!gs) {
      return;
    }

    try {
      gs.db.prepare(`DELETE FROM knowledge_edges WHERE from_id = ? OR to_id = ?`).run(id, id);
    } catch (err: unknown) {
      this.logger.warn('Failed to remove edges', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /* ═══ 文件落盘 ═════════════════════════════════ */

  /** 落盘到 .md 文件 + 回写 sourceFile */
  _persistToFile(entry: KnowledgeEntry) {
    if (!this._fileWriter) {
      return;
    }
    try {
      const oldSourceFile = entry.sourceFile;
      this._fileWriter.persist(entry);
      if (entry.sourceFile && entry.sourceFile !== oldSourceFile) {
        this.repository.update(entry.id, { sourceFile: entry.sourceFile }).catch((err: unknown) => {
          this.logger.warn('Failed to update sourceFile in DB', {
            id: entry.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err: unknown) {
      this.logger.warn('Knowledge file persist failed (non-blocking)', {
        id: entry?.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 删除 .md 文件 */
  _removeFile(entry: KnowledgeEntry) {
    if (!this._fileWriter) {
      return;
    }
    try {
      this._fileWriter.remove(entry);
    } catch (err: unknown) {
      this.logger.warn('Knowledge file remove failed (non-blocking)', {
        id: entry?.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /* ═══ 审计日志 ═══════════════════════════════════════ */

  async _audit(
    action: string,
    id: string,
    actor: string,
    details: Record<string, unknown> | string = {}
  ) {
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
    } catch (err: unknown) {
      this.logger.warn('Audit log failed (non-blocking)', {
        action,
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export default KnowledgeService;

import { Candidate, CandidateStatus, Reasoning } from '../../domain/index.js';
import { isValidStateTransition } from '../../domain/types/CandidateStatus.js';
import { KnowledgeType, inferKind } from '../../domain/recipe/Recipe.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { ValidationError, ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * CandidateService
 * 管理代码候选项的完整生命周期
 * 包括创建、批准、驳回和应用到 Recipe 的业务逻辑
 */
export class CandidateService {
  constructor(candidateRepository, auditLogger, gateway, { fileWriter, skillHooks } = {}) {
    this.candidateRepository = candidateRepository;
    this.auditLogger = auditLogger;
    this.gateway = gateway;
    this.fileWriter = fileWriter || null;
    this.skillHooks = skillHooks || null;
    this.logger = Logger.getInstance();
  }

  /**
   * 创建新的候选项
   */
  async createCandidate(data, context) {
    try {
      // 验证输入
      this._validateCreateInput(data);

      // 创建实体
      const candidate = new Candidate({
        id: uuidv4(),
        code: data.code,
        language: data.language,
        category: data.category,
        source: data.source || 'manual',
        reasoning: data.reasoning
          ? new Reasoning({
              whyStandard: data.reasoning.whyStandard,
              sources: data.reasoning.sources || [],
              qualitySignals: data.reasoning.qualitySignals || {},
              alternatives: data.reasoning.alternatives || [],
              confidence: data.reasoning.confidence || 0.7,
            })
          : null,
        createdBy: context.userId,
        status: CandidateStatus.PENDING,
        metadata: data.metadata || {},
      });

      if (!candidate.isValid()) {
        throw new ValidationError('Invalid candidate data');
      }

      // ── SkillHooks: onCandidateSubmit ──
      if (this.skillHooks) {
        const hookResult = await this.skillHooks.run('onCandidateSubmit', candidate, {
          userId: context.userId,
        });
        if (hookResult?.block) {
          throw new ValidationError(`SkillHook blocked: ${hookResult.reason || 'unknown'}`);
        }
      }

      // 保存到数据库
      const created = await this.candidateRepository.create(candidate);

      // 落盘 .md 文件（Git 友好）
      if (this.fileWriter) {
        this.fileWriter.persistCandidate(created);
      }

      // 审计日志
      await this.auditLogger.log({
        action: 'create_candidate',
        resource: `candidate:${created.id}`,
        actor: context.userId,
        result: 'success',
        data: { codeLength: created.code.length },
      });

      this.logger.info('Candidate created', {
        candidateId: created.id,
        createdBy: context.userId,
        codeLength: created.code.length,
      });

      return created;
    } catch (error) {
      this.logger.error('Error creating candidate', {
        error: error.message,
        data,
      });
      throw error;
    }
  }

  /**
   * 批准候选项
   */
  async approveCandidate(candidateId, context) {
    try {
      const candidate = await this.candidateRepository.findById(candidateId);

      if (!candidate) {
        throw new NotFoundError('Candidate not found', 'candidate', candidateId);
      }

      // 检查状态转移的合法性
      if (!isValidStateTransition(candidate.status, CandidateStatus.APPROVED)) {
        throw new ConflictError(
          `Cannot approve candidate in ${candidate.status} status`,
          `Invalid transition from ${candidate.status} to APPROVED`
        );
      }

      // 执行批准
      candidate.approve(context.userId);

      // 保存
      const updated = await this.candidateRepository.update(candidateId, {
        status: candidate.status,
        status_history_json: JSON.stringify(candidate.statusHistory),
        approved_by: candidate.approvedBy,
        approved_at: candidate.approvedAt,
      });

      // 落盘 .md 文件
      if (this.fileWriter) {
        this.fileWriter.persistCandidate(updated);
      }

      // 审计日志
      await this.auditLogger.log({
        action: 'approve_candidate',
        resource: `candidate:${candidateId}`,
        actor: context.userId,
        result: 'success',
      });

      this.logger.info('Candidate approved', {
        candidateId,
        approvedBy: context.userId,
      });

      return updated;
    } catch (error) {
      this.logger.error('Error approving candidate', {
        candidateId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 删除候选项（DB + .md 文件）
   */
  async deleteCandidate(candidateId, context = {}) {
    try {
      const candidate = await this.candidateRepository.findById(candidateId);

      // 先删 .md 文件（即使 DB 中不存在也尝试按 id 清理文件）
      if (this.fileWriter && candidate) {
        this.fileWriter.removeCandidate(candidate);
      }

      // 删除 DB 记录
      const deleted = await this.candidateRepository.delete(candidateId);

      // 审计日志
      if (deleted) {
        await this.auditLogger.log({
          action: 'delete_candidate',
          resource: `candidate:${candidateId}`,
          actor: context.userId || 'system',
          result: 'success',
        });
      }

      this.logger.info('Candidate deleted', {
        candidateId,
        dbDeleted: deleted,
        fileRemoved: !!candidate,
      });

      return deleted;
    } catch (error) {
      this.logger.error('Error deleting candidate', {
        candidateId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 驳回候选项
   */
  async rejectCandidate(candidateId, reason, context) {
    try {
      const candidate = await this.candidateRepository.findById(candidateId);

      if (!candidate) {
        throw new NotFoundError('Candidate not found', 'candidate', candidateId);
      }

      // 检查状态转移的合法性
      if (!isValidStateTransition(candidate.status, CandidateStatus.REJECTED)) {
        throw new ConflictError(
          `Cannot reject candidate in ${candidate.status} status`,
          `Invalid transition from ${candidate.status} to REJECTED`
        );
      }

      if (!reason || reason.trim().length === 0) {
        throw new ValidationError('Rejection reason is required');
      }

      // 执行驳回
      candidate.reject(reason, context.userId);

      // 保存
      const updated = await this.candidateRepository.update(candidateId, {
        status: candidate.status,
        status_history_json: JSON.stringify(candidate.statusHistory),
        rejection_reason: candidate.rejectionReason,
        rejected_by: candidate.rejectedBy,
      });

      // 落盘 .md 文件（保留驳回原因）
      if (this.fileWriter) {
        this.fileWriter.persistCandidate(updated);
      }

      // 审计日志
      await this.auditLogger.log({
        action: 'reject_candidate',
        resource: `candidate:${candidateId}`,
        actor: context.userId,
        result: 'success',
        data: { reason },
      });

      this.logger.info('Candidate rejected', {
        candidateId,
        rejectedBy: context.userId,
        reason,
      });

      return updated;
    } catch (error) {
      this.logger.error('Error rejecting candidate', {
        candidateId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 将候选项应用到 Recipe（标记为已被用于发布）
   */
  async applyToRecipe(candidateId, recipeId, context) {
    try {
      const candidate = await this.candidateRepository.findById(candidateId);

      if (!candidate) {
        throw new NotFoundError('Candidate not found', 'candidate', candidateId);
      }

      // 检查状态转移的合法性
      if (!isValidStateTransition(candidate.status, CandidateStatus.APPLIED)) {
        throw new ConflictError(
          `Cannot apply candidate in ${candidate.status} status`,
          `Invalid transition from ${candidate.status} to APPLIED`
        );
      }

      // 执行应用
      candidate.applyToRecipe(recipeId);

      // 保存
      const updated = await this.candidateRepository.update(candidateId, {
        status: candidate.status,
        status_history_json: JSON.stringify(candidate.statusHistory),
        applied_recipe_id: candidate.appliedRecipeId,
      });

      // 落盘 .md 文件
      if (this.fileWriter) {
        this.fileWriter.persistCandidate(updated);
      }

      // 审计日志
      await this.auditLogger.log({
        action: 'apply_candidate_to_recipe',
        resource: `candidate:${candidateId}`,
        actor: context.userId,
        result: 'success',
        data: { recipeId },
      });

      this.logger.info('Candidate applied to recipe', {
        candidateId,
        recipeId,
        appliedBy: context.userId,
      });

      return updated;
    } catch (error) {
      this.logger.error('Error applying candidate to recipe', {
        candidateId,
        recipeId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 将候选项提升为 Recipe（一键转化核心路径）
   *
   * 从 Candidate 数据自动创建 Recipe 并标记 Candidate 为 APPLIED。
   * Candidate 必须处于 APPROVED 状态。
   *
   * @param {string} candidateId
   * @param {object} [overrides] - 可选覆盖字段 (title, category, knowledgeType 等)
   * @param {object} context
   * @returns {Promise<{recipe: object, candidate: object}>}
   */
  async promoteCandidateToRecipe(candidateId, overrides = {}, context) {
    const candidate = await this.candidateRepository.findById(candidateId);
    if (!candidate) {
      throw new NotFoundError('Candidate not found', 'candidate', candidateId);
    }

    // 只有 APPROVED 状态可以提升
    if (candidate.status !== CandidateStatus.APPROVED) {
      throw new ConflictError(
        `Cannot promote candidate in ${candidate.status} status — must be APPROVED first`,
        `Current status: ${candidate.status}`,
      );
    }

    // 从 candidate 元数据 + overrides 构建 Recipe 数据
    const meta = candidate.metadata || {};
    const knowledgeType = overrides.knowledgeType || meta.knowledgeType || KnowledgeType.CODE_PATTERN;

    const recipeData = {
      title:          overrides.title || meta.title || `Recipe from ${candidateId.slice(0, 8)}`,
      description:    overrides.description || meta.description || meta.summary || '',
      language:       overrides.language || candidate.language,
      category:       overrides.category || candidate.category,
      trigger:        overrides.trigger || meta.trigger || '',
      knowledgeType,
      kind:           overrides.kind || inferKind(knowledgeType),
      complexity:     overrides.complexity || meta.complexity || 'intermediate',
      scope:          overrides.scope || meta.scope || null,
      tags:           overrides.tags || meta.tags || [],
      content: {
        pattern:      candidate.code || '',
        rationale:    overrides.rationale || meta.rationale || (candidate.reasoning?.whyStandard) || '',
        steps:        meta.steps || [],
        codeChanges:  meta.codeChanges || [],
        verification: meta.verification || null,
        markdown:     '',
      },
      constraints:    meta.constraints || {},
      relations:      overrides.relations || meta.relations || {},
      sourceCandidate: candidate.id,
    };

    // 注入 RecipeService 创建 Recipe（通过 container）
    const { getServiceContainer } = await import('../../injection/ServiceContainer.js');
    const container = getServiceContainer();
    const recipeService = container.get('recipeService');

    const recipe = await recipeService.createRecipe(recipeData, context);

    // 标记 Candidate 为 APPLIED（复用已有方法逻辑）
    candidate.applyToRecipe(recipe.id);
    const updatedCandidate = await this.candidateRepository.update(candidateId, {
      status:              candidate.status,
      status_history_json: JSON.stringify(candidate.statusHistory),
      applied_recipe_id:   candidate.appliedRecipeId,
    });

    if (this.fileWriter) {
      this.fileWriter.persistCandidate(updatedCandidate);
    }

    await this.auditLogger.log({
      action:   'promote_candidate_to_recipe',
      resource: `candidate:${candidateId}`,
      actor:    context.userId,
      result:   'success',
      data:     { recipeId: recipe.id, recipeTitle: recipe.title },
    });

    this.logger.info('Candidate promoted to Recipe', {
      candidateId,
      recipeId: recipe.id,
      promotedBy: context.userId,
    });

    return { recipe, candidate: updatedCandidate };
  }

  /**
   * 查询候选项列表
   */
  async listCandidates(filters = {}, pagination = {}) {
    try {
      const { status, language, category, createdBy, source } = filters;
      const { page = 1, pageSize = 20 } = pagination;

      // 组合查询 — 支持多条件同时筛选
      const dbFilters = {};
      if (status)    dbFilters.status = status;
      if (language)  dbFilters.language = language;
      if (category)  dbFilters.category = category;
      if (source)    dbFilters.source = source;
      if (createdBy) dbFilters.created_by = createdBy;

      return this.candidateRepository.findWithPagination(dbFilters, { page, pageSize });
    } catch (error) {
      this.logger.error('Error listing candidates', {
        error: error.message,
        filters,
      });
      throw error;
    }
  }

  /**
   * 搜索候选项
   */
  async searchCandidates(keyword, pagination = {}) {
    try {
      const { page = 1, pageSize = 20 } = pagination;
      return this.candidateRepository.search(keyword, { page, pageSize });
    } catch (error) {
      this.logger.error('Error searching candidates', {
        keyword,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 获取候选项统计
   */
  async getCandidateStats() {
    try {
      return this.candidateRepository.getStats();
    } catch (error) {
      this.logger.error('Error getting candidate stats', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * ① 结构补齐 — 填充候选缺失的结构性语义字段
   *
   * 目标字段：rationale / knowledgeType / complexity / scope / steps / constraints
   * 写入策略：只填空不覆盖（已有值的字段不动）
   * 建议在 refineBootstrapCandidates()（② 内容润色）之前执行。
   *
   * @param {string[]} candidateIds - 候选 ID 列表
   * @param {object} aiProvider - AiProvider 实例（由调用方注入）
   * @param {object} context
   * @returns {Promise<{enriched: number, results: object[]}>}
   */
  async enrichCandidates(candidateIds, aiProvider, context) {
    if (!aiProvider || typeof aiProvider.enrichCandidates !== 'function') {
      throw new ValidationError('AI provider with enrichCandidates capability is required');
    }

    // 1. 从 DB 取出候选
    const candidates = [];
    for (const id of candidateIds) {
      const c = await this.candidateRepository.findById(id);
      if (c) candidates.push(c);
    }
    if (candidates.length === 0) throw new NotFoundError('No candidates found');

    // 2. 构建 AI 输入（合并 metadata 字段到顶层供 AI 分析）
    const aiInput = candidates.map(c => {
      const m = c.metadata || {};
      return {
        code: c.code,
        language: c.language,
        category: c.category,
        title: m.title || '',
        description: m.description || m.summary || '',
        summary: m.summary || '',
        rationale: m.rationale || '',
        knowledgeType: m.knowledgeType || '',
        complexity: m.complexity || '',
        scope: m.scope || '',
        steps: m.steps || [],
        constraints: m.constraints || {},
      };
    });

    // 3. 调用 AI 补全
    const enrichResults = await aiProvider.enrichCandidates(aiInput);

    // 4. 合并结果写回 metadata
    let enrichedCount = 0;
    const results = [];
    for (const enriched of enrichResults) {
      const idx = enriched.index;
      if (idx == null || idx < 0 || idx >= candidates.length) continue;
      const candidate = candidates[idx];
      const meta = { ...(candidate.metadata || {}) };
      let changed = false;

      const SEMANTIC_KEYS = ['rationale', 'knowledgeType', 'complexity', 'scope', 'steps', 'constraints'];
      for (const key of SEMANTIC_KEYS) {
        if (enriched[key] !== undefined && enriched[key] !== null && enriched[key] !== '') {
          // 只填充缺失的字段
          if (!meta[key] || (typeof meta[key] === 'string' && meta[key].trim() === '') ||
              (Array.isArray(meta[key]) && meta[key].length === 0) ||
              (typeof meta[key] === 'object' && !Array.isArray(meta[key]) && Object.keys(meta[key]).length === 0)) {
            meta[key] = enriched[key];
            changed = true;
          }
        }
      }

      if (changed) {
        const enrichedCandidate = await this.candidateRepository.update(candidate.id, { metadata_json: JSON.stringify(meta) });
        // 落盘 .md 文件
        if (this.fileWriter && enrichedCandidate) {
          this.fileWriter.persistCandidate(enrichedCandidate);
        }
        enrichedCount++;
      }

      results.push({
        id: candidate.id,
        enriched: changed,
        filledFields: Object.keys(enriched).filter(k => k !== 'index'),
      });
    }

    // 5. 审计
    await this.auditLogger.log({
      action: 'enrich_candidates',
      resource: 'candidates',
      actor: context.userId || 'system',
      result: 'success',
      data: { total: candidates.length, enriched: enrichedCount },
    });

    return { enriched: enrichedCount, total: candidates.length, results };
  }

  /**
   * ② 内容润色 — 逐条精炼 Bootstrap 候选的内容质量
   *
   * 目标字段：summary / agentNotes / relations / confidence / insight / tags / code
   * 写入策略：覆盖改善（AI 给出更好内容就替换）
   * 建议在 enrichCandidates()（① 结构补齐）之后执行。
   *
   * 对 source='bootstrap' 的候选逐条调用 AI，不会删除/合并候选——仅原地更新。
   *
   * @param {object}   aiProvider  AI provider 实例
   * @param {object}   [options]
   * @param {string[]} [options.candidateIds]  指定候选 ID（默认全部 bootstrap）
   * @param {string}   [options.userPrompt]    用户自定义润色提示词（追加到 AI prompt）
   * @param {boolean}  [options.dryRun]        仅预览不写入
   * @param {object}   [context]               { userId }
   * @returns {Promise<{refined: number, total: number, errors: object[], results: object[]}>}
   */
  async refineBootstrapCandidates(aiProvider, options = {}, context = { userId: 'system' }) {
    if (!aiProvider || typeof aiProvider.chat !== 'function') {
      throw new ValidationError('AI provider with chat capability is required');
    }

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    // 1. 收集候选
    let candidates;
    if (options.candidateIds?.length) {
      candidates = [];
      for (const id of options.candidateIds) {
        const c = await this.candidateRepository.findById(id);
        if (c) candidates.push(c);
      }
    } else {
      // 查全部 bootstrap 候选（PENDING 状态）
      const all = await this.candidateRepository.findAll({
        source: 'bootstrap',
        status: 'pending',
      });
      candidates = all || [];
    }

    if (candidates.length === 0) {
      return { refined: 0, total: 0, errors: [], results: [] };
    }

    // 通知：润色开始
    onProgress?.('refine:started', {
      total: candidates.length,
      candidateIds: candidates.map(c => c.id),
    });

    // 2. 收集同批次标题列表（供 AI 推断关系）
    const allTitles = candidates.map(c => (c.metadata || {}).title || '').filter(Boolean);

    // 3. 逐条润色
    const results = [];
    const errors = [];
    let refined = 0;
    let processed = 0;

    for (const candidate of candidates) {
      processed++;
      const title = (candidate.metadata || {}).title || '';

      // 通知：开始处理当前候选
      onProgress?.('refine:item-started', {
        candidateId: candidate.id,
        title,
        current: processed,
        total: candidates.length,
        progress: Math.round(((processed - 1) / candidates.length) * 100),
      });

      try {
        const meta = { ...(candidate.metadata || {}) };
        const prompt = this._buildRefinePrompt(candidate, allTitles, options.userPrompt);
        const response = await aiProvider.chat(prompt, { temperature: 0.3 });
        const parsed = aiProvider.extractJSON(response, '{', '}');

        if (!parsed) {
          errors.push({ id: candidate.id, title, error: 'AI returned no valid JSON' });
          onProgress?.('refine:item-failed', {
            candidateId: candidate.id, title,
            error: 'AI returned no valid JSON',
            current: processed, total: candidates.length,
            progress: Math.round((processed / candidates.length) * 100),
          });
          continue;
        }

        if (options.dryRun) {
          results.push({ id: candidate.id, title, preview: parsed });
          onProgress?.('refine:item-completed', {
            candidateId: candidate.id, title, refined: false,
            current: processed, total: candidates.length,
            progress: Math.round((processed / candidates.length) * 100),
            refinedSoFar: refined,
          });
          continue;
        }

        // 合并 AI 改进到 metadata
        let changed = false;

        if (parsed.summary && parsed.summary !== meta.summary) {
          meta.summary = parsed.summary;
          changed = true;
        }
        if (parsed.agentNotes && Array.isArray(parsed.agentNotes)) {
          meta.agentNotes = parsed.agentNotes;
          changed = true;
        }
        if (parsed.relations && Array.isArray(parsed.relations) && parsed.relations.length > 0) {
          meta.relations = parsed.relations;
          changed = true;
        }
        if (typeof parsed.confidence === 'number' && parsed.confidence !== 0.6) {
          meta.refinedConfidence = parsed.confidence;
          changed = true;
        }
        if (parsed.insight) {
          meta.aiInsight = parsed.insight;
          changed = true;
        }
        if (parsed.tags && Array.isArray(parsed.tags)) {
          // 合并 AI 建议的 tag（不重复）
          const existing = new Set(meta.tags || []);
          for (const t of parsed.tags) {
            if (!existing.has(t)) {
              (meta.tags = meta.tags || []).push(t);
              changed = true;
            }
          }
        }

        // 更新 code（如果 AI 改写了文档 — 增强校验防止截断/片段代码/类型变更）
        let newCode = candidate.code;
        const origCode = candidate.code || '';
        const origLen = origCode.length;
        const isOrigMarkdown = /^---\s*\n/.test(origCode) || /^#\s+/.test(origCode) || (origCode.match(/^#{1,3}\s+/gm) || []).length >= 2;
        const isNewMarkdown = parsed.code && (/^---\s*\n/.test(parsed.code) || /^#\s+/.test(parsed.code) || (parsed.code.match(/^#{1,3}\s+/gm) || []).length >= 2);
        const codeTypeChanged = !isOrigMarkdown && isNewMarkdown;
        if (parsed.code && parsed.code.length > 50 && parsed.code !== candidate.code
          && parsed.code.length >= origLen * 0.4  // 不能太短（防止 AI 返回截断片段）
          && !codeTypeChanged) {                   // 不允许源代码 → Markdown 类型变更
          newCode = parsed.code;
          changed = true;
        }

        if (changed) {
          await this.candidateRepository.update(candidate.id, {
            code: newCode,
            metadata_json: JSON.stringify(meta),
          });
          // 落盘 .md 文件
          const updated = await this.candidateRepository.findById(candidate.id);
          if (this.fileWriter && updated) {
            this.fileWriter.persistCandidate(updated);
          }
          refined++;
        }

        results.push({ id: candidate.id, title, refined: changed, fields: Object.keys(parsed) });

        // 通知：当前候选完成
        onProgress?.('refine:item-completed', {
          candidateId: candidate.id,
          title,
          refined: changed,
          current: processed,
          total: candidates.length,
          progress: Math.round((processed / candidates.length) * 100),
          refinedSoFar: refined,
        });
      } catch (err) {
        errors.push({ id: candidate.id, title: (candidate.metadata || {}).title, error: err.message });

        // 通知：当前候选失败
        onProgress?.('refine:item-failed', {
          candidateId: candidate.id,
          title,
          error: err.message,
          current: processed,
          total: candidates.length,
          progress: Math.round((processed / candidates.length) * 100),
        });
      }
    }

    // 通知：全部完成
    onProgress?.('refine:completed', {
      total: candidates.length,
      refined,
      failed: errors.length,
    });

    // 4. 审计
    await this.auditLogger.log({
      action: 'refine_bootstrap_candidates',
      resource: 'candidates',
      actor: context.userId || 'system',
      result: 'success',
      data: { total: candidates.length, refined, errors: errors.length },
    });

    return { refined, total: candidates.length, errors, results };
  }

  /**
   * 构建 AI 润色 prompt
   * @private
   */
  _buildRefinePrompt(candidate, allTitles, userPrompt = '') {
    const meta = candidate.metadata || {};
    const otherTitles = allTitles.filter(t => t !== meta.title).map(t => `  - ${t}`).join('\n');
    const code = (candidate.code || '');

    // ── 检测 code 字段是源代码还是 Markdown 文档 ──
    const isMarkdownDoc = /^---\s*\n/.test(code)                   // frontmatter
      || /^#\s+/.test(code)                                        // 以 # 标题开头
      || (code.match(/^#{1,3}\s+/gm) || []).length >= 2;           // 含 ≥2 个 Markdown 标题
    const codeContentType = isMarkdownDoc ? 'markdown-document' : 'source-code';

    // ── 用户指令段落 ──
    let userSection = '';
    if (userPrompt) {
      userSection = `
# User Instructions (HIGHEST PRIORITY — STRICTLY follow these)
${userPrompt}

## Scope Restriction
- ONLY modify fields that are DIRECTLY related to the user instruction above.
- Do NOT touch or return any field that the user did not ask to change.
- For example, if user says "增加使用案例", ONLY return the field where usage examples belong (e.g. "code" for markdown docs, or "agentNotes" for source-code candidates). Do NOT return "summary", "confidence", "tags", "insight", or "relations" unless explicitly requested.
- If you are unsure which field a user instruction maps to, prefer "agentNotes" or "code" (for markdown docs).
`;
    }

    // ── code 字段的任务描述根据内容类型而不同 ──
    let codeTask;
    if (codeContentType === 'source-code') {
      codeTask = `7. **code**: The content field contains RAW SOURCE CODE (not a Markdown document).
   - Do NOT convert source code into a Markdown document — that breaks the candidate.
   - If the user asks to add usage examples, documentation notes or explanations,
     put them in "agentNotes" (array of strings) instead of modifying "code".
   - Only modify "code" if the user explicitly asks to change the source code itself
     (e.g. fix a bug, add comments, refactor). Return the COMPLETE source code.
   - If no code change is needed, OMIT this field entirely.`;
    } else {
      codeTask = `7. **code**: The content field is a Markdown document.
   - If improvements are needed, return the COMPLETE improved Markdown document.
   - CRITICAL: You MUST return the ENTIRE document content, including ALL sections.
   - Do NOT return only source code fragments or partial snippets.
   - The code blocks inside the Markdown should contain PURE source code.
   - If no code improvement is needed, OMIT this field entirely.`;
    }

    return `# Role
You are a senior software architect refining a Bootstrap knowledge candidate.\n${userSection}

# Current Candidate
Title: ${meta.title || '(untitled)'}
Category: ${candidate.category || 'bootstrap'}
Language: ${candidate.language || 'unknown'}
Summary: ${meta.summary || '(none)'}
Tags: ${(meta.tags || []).join(', ')}
Content Type: ${codeContentType}

## Content
\`\`\`
${code.substring(0, 3000)}
\`\`\`

# Sibling Candidates (same bootstrap batch)
${otherTitles || '(none)'}

# Tasks
1. **summary**: Write a precise 1-2 sentence summary (in Chinese) that a coding agent can use to decide relevance
2. **insight**: One high-level architectural insight about this pattern (in Chinese, nullable)
3. **agentNotes**: Array of 2-4 actionable rules for the coding agent (in Chinese)
4. **relations**: Array of cross-references to sibling candidates: [{ "type": "DEPENDS_ON|EXTENDS|RELATED|CONFLICTS|ENFORCES|PREREQUISITE", "target": "<exact title from siblings>", "description": "<why>" }]
5. **confidence**: Float 0-1 rating of this candidate's value (0.3=low, 0.6=medium, 0.9=high)
6. **tags**: Additional relevant tags (array of strings, optional)
${codeTask}

# Output
Return a single JSON object. Only include fields you want to change.${userPrompt ? '\nREMINDER: Only return fields DIRECTLY related to the user instruction. Omit all others!' : ''}
Do NOT wrap in markdown code blocks. Return raw JSON only.`;
  }

  /**
   * 统一候选创建入口 — MCP / ChatAgent / Bootstrap 共用
   *
   * 从扁平的工具参数（或手工构建的对象）中提取 code / language / category /
   * reasoning / metadata，处理默认值和中英文字段映射，确保所有路径的字段
   * 映射逻辑一致。
   *
   * @param {object} item       候选数据（扁平字段或含 metadata 的对象）
   * @param {string} source     来源标识（mcp / agent / bootstrap）
   * @param {object} [extraMeta]额外 metadata（如 targetName）
   * @param {object} [context]  上下文 { userId }
   * @returns {Promise<object>} 创建后的 Candidate
   */
  async createFromToolParams(item, source, extraMeta = {}, context = { userId: 'system' }) {
    const metadata = { ...this._buildMetadataFromFlat(item), ...extraMeta };
    const reasoning = this._buildReasoning(item);

    // ── 去重: 同标题候选已存在于 DB 中则跳过（删除后可重新生成） ──
    const title = item.title || metadata.title || '';
    if (title && this._existsCandidateWithTitle(title)) {
      this.logger.info('Skipped duplicate candidate (title already exists)', { title, source });
      return { skipped: true, reason: 'duplicate_title', title };
    }

    // 如果 reasoning 为空对象（缺少 whyStandard），生成默认值
    if (!reasoning.whyStandard) {
      reasoning.whyStandard = item.rationale || item.summary || item.description || `Submitted via ${source}`;
      reasoning.sources = reasoning.sources?.length ? reasoning.sources : [source];
      reasoning.confidence = reasoning.confidence || 0.7;
    }

    return this.createCandidate({
      code: item.code || '',
      language: item.language || '',
      category: item.category || 'general',
      source,
      reasoning,
      metadata,
    }, context);
  }

  /**
   * 从扁平工具参数构建 metadata 对象（等价于旧 buildCandidateMetadata）
   */
  _buildMetadataFromFlat(obj) {
    const m = {};
    if (obj.title)        m.title = obj.title;
    if (obj.description)  m.description = obj.description;
    if (obj.summary_cn || obj.summary)  m.summary = obj.summary_cn || obj.summary;
    if (obj.summary_en)                 m.summary_en = obj.summary_en;
    if (obj.trigger)      m.trigger = obj.trigger;
    if (obj.usageGuide_cn || obj.usageGuide)  m.usageGuide = obj.usageGuide_cn || obj.usageGuide;
    if (obj.usageGuide_en)                    m.usageGuide_en = obj.usageGuide_en;
    if (obj.knowledgeType) m.knowledgeType = obj.knowledgeType;
    if (obj.complexity)    m.complexity = obj.complexity;
    if (obj.scope)         m.scope = obj.scope;
    if (obj.tags)          m.tags = obj.tags;
    if (obj.rationale)     m.rationale = obj.rationale;
    if (obj.steps)         m.steps = obj.steps;
    if (obj.codeChanges)   m.codeChanges = obj.codeChanges;
    if (obj.verification)  m.verification = obj.verification;
    if (obj.headers)       m.headers = obj.headers;
    if (obj.constraints)   m.constraints = obj.constraints;
    if (obj.relations)     m.relations = obj.relations;
    if (obj.quality)       m.quality = obj.quality;
    if (obj.sourceFile)    m.sourceFile = obj.sourceFile;
    return m;
  }

  /**
   * 从工具参数构建 Reasoning 值对象数据
   */
  _buildReasoning(obj) {
    const r = obj.reasoning;
    if (!r || !r.whyStandard) return {};
    return {
      whyStandard: r.whyStandard,
      sources: Array.isArray(r.sources) ? r.sources : [],
      confidence: typeof r.confidence === 'number' ? r.confidence : 0.7,
      qualitySignals: r.qualitySignals || {},
      alternatives: Array.isArray(r.alternatives) ? r.alternatives : [],
    };
  }

  /**
   * 验证创建输入
   */
  _validateCreateInput(data) {
    if (!data.code || data.code.trim().length === 0) {
      throw new ValidationError('Code is required');
    }

    if (!data.language || data.language.trim().length === 0) {
      throw new ValidationError('Language is required');
    }

    if (!data.category || data.category.trim().length === 0) {
      throw new ValidationError('Category is required');
    }

    if (data.code.length > 50 * 1024) {
      throw new ValidationError('Code exceeds maximum size of 50KB');
    }

    // reasoning 校验 — 提供明确错误信息而非泛化的 "Invalid candidate data"
    if (!data.reasoning) {
      throw new ValidationError('Reasoning is required — provide { whyStandard, sources, confidence }');
    }
    if (!data.reasoning.whyStandard || (typeof data.reasoning.whyStandard === 'string' && data.reasoning.whyStandard.trim().length === 0)) {
      throw new ValidationError('reasoning.whyStandard is required — explain why this code is worth capturing');
    }
    if (!Array.isArray(data.reasoning.sources) || data.reasoning.sources.length === 0) {
      throw new ValidationError('reasoning.sources must be a non-empty array — list at least one source file or reference');
    }

    // metadata 大小限制
    if (data.metadata) {
      const metaStr = typeof data.metadata === 'string' ? data.metadata : JSON.stringify(data.metadata);
      if (metaStr.length > 200 * 1024) {
        throw new ValidationError('Metadata exceeds maximum size of 200KB');
      }
    }
  }

  /**
   * 检查是否已存在同标题的候选（DB 中当前存在的）
   * @param {string} title
   * @returns {boolean}
   */
  _existsCandidateWithTitle(title) {
    try {
      const db = this.candidateRepository.db;
      const titleLower = (title || '').toLowerCase().trim();
      if (!titleLower) return false;

      // metadata_json 中搜索 title 字段
      const row = db.prepare(
        "SELECT id FROM candidates WHERE LOWER(json_extract(metadata_json, '$.title')) = ?"
      ).get(titleLower);
      return !!row;
    } catch {
      return false;
    }
  }
}

export default CandidateService;

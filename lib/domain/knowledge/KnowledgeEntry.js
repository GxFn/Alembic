import { v4 as uuidv4 } from 'uuid';
import { Lifecycle, isValidTransition, isCandidate as isLifecycleCandidate, inferKind, normalizeLifecycle } from './Lifecycle.js';
import { Content, Relations, Constraints, Reasoning, Quality, Stats } from './values/index.js';

/* ═══════════════════════════════════════════════════════════
 * KnowledgeEntry — 统一知识实体
 *
 * 合并原 Candidate + Recipe。
 * lifecycle 状态决定其行为（3 状态简化版）：
 *   pending    → 待审核（新建条目初始状态）
 *   active     → 已发布（被 Guard/Search/Export 消费）
 *   deprecated → 已废弃
 * ═══════════════════════════════════════════════════════════ */

export class KnowledgeEntry {
  /**
   * @param {Object} props
   */
  constructor(props = {}) {
    // ── 标识 ──
    this.id          = props.id          || uuidv4();
    this.title       = props.title       || '';
    this.trigger     = props.trigger     || '';
    this.description = props.description || '';

    // ── 生命周期 ──
    this.lifecycle        = normalizeLifecycle(props.lifecycle || Lifecycle.PENDING);
    this.lifecycleHistory = props.lifecycleHistory  || [];
    this.autoApprovable   = props.autoApprovable    ?? props.probation ?? false;

    // ── 语言与分类 ──
    this.language      = props.language      || '';
    this.category      = props.category      || '';
    this.knowledgeType = props.knowledgeType  || 'code-pattern';
    this.kind          = props.kind          || inferKind(this.knowledgeType);
    this.complexity    = props.complexity    || 'intermediate';
    this.scope         = props.scope         || 'universal';
    this.difficulty    = props.difficulty    || null;
    this.tags          = props.tags          || [];

    // ── 国际化文本 ──
    this.summaryCn    = props.summaryCn    ?? '';
    this.summaryEn    = props.summaryEn    ?? '';
    this.usageGuideCn = props.usageGuideCn ?? '';
    this.usageGuideEn = props.usageGuideEn ?? '';

    // ── 值对象 ──
    this.content     = Content.from(props.content);
    this.relations   = Relations.from(props.relations);
    this.constraints = Constraints.from(props.constraints);
    this.reasoning   = Reasoning.from(props.reasoning);
    this.quality     = Quality.from(props.quality);
    this.stats       = Stats.from(props.stats);

    // ── 代码头文件 (ObjC/Swift) ──
    this.headers        = props.headers        || [];
    this.headerPaths    = props.headerPaths    || [];
    this.moduleName     = props.moduleName     || '';
    this.includeHeaders = props.includeHeaders ?? false;

    // ── AI 润色 ──
    this.agentNotes = props.agentNotes || null;
    this.aiInsight  = props.aiInsight  || null;

    // ── 审核 ──
    this.reviewedBy      = props.reviewedBy      || null;
    this.reviewedAt      = props.reviewedAt      || null;
    this.rejectionReason = props.rejectionReason  || null;

    // ── 来源 ──
    this.source            = props.source            || 'manual';
    this.sourceFile        = props.sourceFile        || null;
    this.sourceCandidateId = props.sourceCandidateId || null;

    // ── 时间 ──
    this.createdBy   = props.createdBy   || 'system';
    this.createdAt   = props.createdAt   || Math.floor(Date.now() / 1000);
    this.updatedAt   = props.updatedAt   || Math.floor(Date.now() / 1000);
    this.publishedAt = props.publishedAt || null;
    this.publishedBy = props.publishedBy || null;
  }

  /* ═══ 生命周期操作 ═══════════════════════════════════ */

  /**
   * 发布 (pending → active)
   * @param {string} publisher
   * @returns {{ success: boolean, error?: string }}
   */
  publish(publisher) {
    if (!this.isValid()) {
      return { success: false, error: '内容不完整，无法发布' };
    }
    const result = this._transition(Lifecycle.ACTIVE);
    if (result.success) {
      this.publishedAt = this._now();
      this.publishedBy = publisher;
    }
    return result;
  }

  /**
   * 弃用 (pending|active → deprecated)
   * @param {string} reason
   * @returns {{ success: boolean, error?: string }}
   */
  deprecate(reason) {
    const result = this._transition(Lifecycle.DEPRECATED);
    if (result.success) {
      this.rejectionReason = reason;
    }
    return result;
  }

  /**
   * 重新激活 (deprecated → pending)
   * @returns {{ success: boolean, error?: string }}
   */
  reactivate() {
    const result = this._transition(Lifecycle.PENDING);
    if (result.success) {
      this.rejectionReason = null;
    }
    return result;
  }

  // ── 向后兼容的别名方法（旧代码可能引用） ──

  /** @deprecated 简化后统一为 pending，无需 submit */
  submit() { return { success: true }; }

  /** @deprecated 简化后无需 approve，直接 publish */
  approve(reviewer) { return this.publish(reviewer); }

  /** @deprecated 简化后 reject = deprecate */
  reject(reviewer, reason) { return this.deprecate(reason); }

  /** @deprecated 简化后无需 toDraft */
  toDraft() { return this.reactivate(); }

  /** @deprecated 简化后 fastTrack = publish */
  fastTrack(publisher) { return this.publish(publisher); }

  /** @deprecated 简化后无需 autoApprove */
  autoApprove() { return { success: true }; }

  /* ═══ 谓词 ═══════════════════════════════════════════ */

  /**
   * 是否处于候选阶段
   * @returns {boolean}
   */
  isCandidate() {
    return isLifecycleCandidate(this.lifecycle);
  }

  /**
   * 是否可被 Guard/Search/Export 消费
   * @returns {boolean}
   */
  isActive() {
    return this.lifecycle === Lifecycle.ACTIVE;
  }

  /**
   * 是否为 Guard 规则类型
   * @returns {boolean}
   */
  isRule() {
    return this.kind === 'rule';
  }

  /**
   * 内容是否有效
   * @returns {boolean}
   */
  isValid() {
    return !!(this.title?.trim() && this.content.hasContent());
  }

  /* ═══ Guard 消费 ═══════════════════════════════════ */

  /**
   * 返回此 Entry 中可被 GuardCheckEngine 消费的规则列表
   * @returns {Array<Object>}
   */
  getGuardRules() {
    if (!this.isActive() || !this.isRule()) return [];

    const regexRules = this.constraints.getRegexGuards().map(g => ({
      id:            g.id || this.id,
      type:          'regex',
      name:          g.message || this.title,
      message:       g.message || this.description || this.title,
      pattern:       g.pattern,
      languages:     this.language ? [this.language] : [],
      severity:      g.severity || 'warning',
      source:        'knowledge_entry',
      fixSuggestion: g.fix_suggestion || null,
    }));

    const astRules = this.constraints.getAstGuards().map(g => ({
      id:            g.id || `${this.id}:ast`,
      type:          'ast',
      name:          g.message || this.title,
      message:       g.message,
      astQuery:      g.ast_query,
      languages:     g.ast_query?.language ? [g.ast_query.language] : [],
      severity:      g.severity || 'warning',
      source:        'knowledge_entry',
      fixSuggestion: g.fix_suggestion || null,
    }));

    return [...regexRules, ...astRules];
  }

  /* ═══ 序列化 ═══════════════════════════════════════ */

  /**
   * Domain → wire format JSON (统一格式，DB/MCP/API 共用)
   */
  toJSON() {
    return {
      id:                  this.id,
      title:               this.title,
      trigger:             this.trigger,
      description:         this.description,
      lifecycle:           this.lifecycle,
      lifecycle_history:   this.lifecycleHistory,
      auto_approvable:     this.autoApprovable,
      language:            this.language,
      category:            this.category,
      kind:                this.kind,
      knowledge_type:      this.knowledgeType,
      complexity:          this.complexity,
      scope:               this.scope,
      difficulty:          this.difficulty,
      tags:                this.tags,
      summary_cn:          this.summaryCn,
      summary_en:          this.summaryEn,
      usage_guide_cn:      this.usageGuideCn,
      usage_guide_en:      this.usageGuideEn,
      content:             this.content.toJSON(),
      relations:           this.relations.toJSON(),
      constraints:         this.constraints.toJSON(),
      reasoning:           this.reasoning.toJSON(),
      quality:             this.quality.toJSON(),
      stats:               this.stats.toJSON(),
      headers:             this.headers,
      header_paths:        this.headerPaths,
      module_name:         this.moduleName,
      include_headers:     this.includeHeaders,
      agent_notes:         this.agentNotes,
      ai_insight:          this.aiInsight,
      reviewed_by:         this.reviewedBy,
      reviewed_at:         this.reviewedAt,
      rejection_reason:    this.rejectionReason,
      source:              this.source,
      source_file:         this.sourceFile,
      source_candidate_id: this.sourceCandidateId,
      created_by:          this.createdBy,
      created_at:          this.createdAt,
      updated_at:          this.updatedAt,
      published_at:        this.publishedAt,
      published_by:        this.publishedBy,
    };
  }

  /**
   * wire format → Domain
   * @param {Object} data snake_case 格式数据
   * @returns {KnowledgeEntry}
   */
  static fromJSON(data) {
    if (!data) return new KnowledgeEntry();
    return new KnowledgeEntry({
      id:                data.id,
      title:             data.title,
      trigger:           data.trigger,
      description:       data.description,
      lifecycle:         data.lifecycle,
      lifecycleHistory:  data.lifecycle_history,
      autoApprovable:    data.auto_approvable ?? data.probation,
      language:          data.language,
      category:          data.category,
      kind:              data.kind,
      knowledgeType:     data.knowledge_type,
      complexity:        data.complexity,
      scope:             data.scope,
      difficulty:        data.difficulty,
      tags:              data.tags,
      summaryCn:         data.summary_cn,
      summaryEn:         data.summary_en,
      usageGuideCn:      data.usage_guide_cn,
      usageGuideEn:      data.usage_guide_en,
      content:           data.content,
      relations:         data.relations,
      constraints:       data.constraints,
      reasoning:         data.reasoning,
      quality:           data.quality,
      stats:             data.stats,
      headers:           data.headers,
      headerPaths:       data.header_paths,
      moduleName:        data.module_name,
      includeHeaders:    data.include_headers,
      agentNotes:        data.agent_notes,
      aiInsight:         data.ai_insight,
      reviewedBy:        data.reviewed_by,
      reviewedAt:        data.reviewed_at,
      rejectionReason:   data.rejection_reason,
      source:            data.source,
      sourceFile:        data.source_file,
      sourceCandidateId: data.source_candidate_id,
      createdBy:         data.created_by,
      createdAt:         data.created_at,
      updatedAt:         data.updated_at,
      publishedAt:       data.published_at,
      publishedBy:       data.published_by,
    });
  }

  /* ═══ 私有 ═══════════════════════════════════════════ */

  /**
   * @param {string} to
   * @returns {{ success: boolean, error?: string }}
   */
  _transition(to) {
    if (!isValidTransition(this.lifecycle, to)) {
      return {
        success: false,
        error: `Invalid lifecycle transition: ${this.lifecycle} → ${to}`,
      };
    }
    this.lifecycleHistory.push({
      from: this.lifecycle,
      to,
      at: this._now(),
    });
    this.lifecycle = to;
    this.updatedAt = this._now();
    return { success: true };
  }

  /** @returns {number} */
  _now() {
    return Math.floor(Date.now() / 1000);
  }
}

export default KnowledgeEntry;

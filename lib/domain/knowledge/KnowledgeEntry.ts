import { v4 as uuidv4 } from 'uuid';
import type { KnowledgeEntryWire } from '#types/knowledge-wire.js';
import {
  inferKind,
  isCandidate as isLifecycleCandidate,
  isValidTransition,
  Lifecycle,
  normalizeLifecycle,
} from './Lifecycle.js';
import type { Guard } from './values/Constraints.js';
import { Constraints, Content, Quality, Reasoning, Relations, Stats } from './values/index.js';

/* ═══════════════════════════════════════════════════════════
 * KnowledgeEntry — 统一知识实体
 *
 * lifecycle 状态决定其行为（3 状态简化版）：
 *   pending    → 待审核（新建条目初始状态）
 *   active     → 已发布（被 Guard/Search/Export 消费）
 *   deprecated → 已废弃
 * ═══════════════════════════════════════════════════════════ */

export interface KnowledgeEntryProps {
  id?: string;
  title?: string;
  description?: string;
  lifecycle?: string;
  lifecycleHistory?: Array<{ from: string; to: string; at: number }>;
  autoApprovable?: boolean;
  stagingDeadline?: number | null;
  language?: string;
  category?: string;
  knowledgeType?: string;
  kind?: string;
  complexity?: string;
  scope?: string;
  difficulty?: string | null;
  tags?: string[];
  trigger?: string;
  topicHint?: string;
  whenClause?: string;
  doClause?: string;
  dontClause?: string;
  coreCode?: string;
  usageGuide?: string;
  content?: unknown;
  relations?: unknown;
  constraints?: unknown;
  reasoning?: unknown;
  quality?: unknown;
  stats?: unknown;
  headers?: string[];
  headerPaths?: string[];
  moduleName?: string;
  includeHeaders?: boolean;
  agentNotes?: string | null;
  aiInsight?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: number | null;
  rejectionReason?: string | null;
  source?: string;
  sourceFile?: string | null;
  sourceCandidateId?: string | null;
  createdBy?: string;
  createdAt?: number;
  updatedAt?: number;
  publishedAt?: number | null;
  publishedBy?: string | null;
  [key: string]: unknown;
}

export class KnowledgeEntry {
  // Identification
  id: string;
  title: string;
  description: string;

  // Lifecycle
  lifecycle: string;
  lifecycleHistory: Array<{ from: string; to: string; at: number }>;
  autoApprovable: boolean;
  stagingDeadline: number | null;

  // Language & Classification
  language: string;
  category: string;
  knowledgeType: string;
  kind: string;
  complexity: string;
  scope: string;
  difficulty: string | null;
  tags: string[];

  // Cursor delivery fields
  trigger: string;
  topicHint: string;
  whenClause: string;
  doClause: string;
  dontClause: string;
  coreCode: string;
  usageGuide: string;

  // Value objects
  content: Content;
  relations: Relations;
  constraints: Constraints;
  reasoning: Reasoning;
  quality: Quality;
  stats: Stats;

  // Code headers (ObjC/Swift)
  headers: string[];
  headerPaths: string[];
  moduleName: string;
  includeHeaders: boolean;

  // AI
  agentNotes: string | null;
  aiInsight: string | null;

  // Review
  reviewedBy: string | null;
  reviewedAt: number | null;
  rejectionReason: string | null;

  // Source
  source: string;
  sourceFile: string | null;
  sourceCandidateId: string | null;

  // Timestamps
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  publishedBy: string | null;

  constructor(props: KnowledgeEntryProps = {}) {
    // ── 标识 ──
    this.id = props.id || uuidv4();
    this.title = props.title || '';
    this.description = props.description || '';

    // ── 生命周期 ──
    this.lifecycle = normalizeLifecycle(props.lifecycle || Lifecycle.PENDING);
    this.lifecycleHistory = props.lifecycleHistory || [];
    this.autoApprovable = props.autoApprovable ?? false;
    this.stagingDeadline = props.stagingDeadline ?? null;

    // ── 语言与分类 ──
    this.language = props.language || '';
    this.category = props.category || '';
    this.knowledgeType = props.knowledgeType || 'code-pattern';
    this.kind = props.kind || inferKind(this.knowledgeType);
    this.complexity = props.complexity || 'intermediate';
    this.scope = props.scope || 'universal';
    this.difficulty = props.difficulty || null;
    this.tags = props.tags || [];

    // ── Cursor 交付字段（AI 直接产出）──
    this.trigger = props.trigger || '';
    this.topicHint = props.topicHint || '';
    this.whenClause = props.whenClause || '';
    this.doClause = props.doClause || '';
    this.dontClause = props.dontClause || '';
    this.coreCode = props.coreCode || '';
    this.usageGuide = props.usageGuide || '';

    // ── 值对象 ──
    this.content = Content.from(props.content);
    this.relations = Relations.from(props.relations);
    this.constraints = Constraints.from(props.constraints);
    this.reasoning = Reasoning.from(props.reasoning);
    this.quality = Quality.from(props.quality);
    this.stats = Stats.from(props.stats);

    // ── 代码头文件 (ObjC/Swift) ──
    this.headers = props.headers || [];
    this.headerPaths = props.headerPaths || [];
    this.moduleName = props.moduleName || '';
    this.includeHeaders = props.includeHeaders ?? false;

    // ── AI 润色 ──
    this.agentNotes = props.agentNotes || null;
    this.aiInsight = props.aiInsight || null;

    // ── 审核 ──
    this.reviewedBy = props.reviewedBy || null;
    this.reviewedAt = props.reviewedAt || null;
    this.rejectionReason = props.rejectionReason || null;

    // ── 来源 ──
    this.source = props.source || 'manual';
    this.sourceFile = props.sourceFile || null;
    this.sourceCandidateId = props.sourceCandidateId || null;

    // ── 时间 ──
    this.createdBy = props.createdBy || 'system';
    this.createdAt = props.createdAt || Math.floor(Date.now() / 1000);
    this.updatedAt = props.updatedAt || Math.floor(Date.now() / 1000);
    this.publishedAt = props.publishedAt || null;
    this.publishedBy = props.publishedBy || null;
  }

  /* ═══ 生命周期操作 ═══════════════════════════════════ */

  /**
   * 发布 (pending|staging|evolving → active)
   */
  publish(publisher: string): { success: boolean; error?: string } {
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
   * 进入暂存期 (pending → staging)
   */
  stage(): { success: boolean; error?: string } {
    return this._transition(Lifecycle.STAGING);
  }

  /**
   * 进入进化态 (active → evolving)
   */
  evolve(): { success: boolean; error?: string } {
    return this._transition(Lifecycle.EVOLVING);
  }

  /**
   * 进入衰退观察 (active|evolving → decaying)
   */
  decay(): { success: boolean; error?: string } {
    return this._transition(Lifecycle.DECAYING);
  }

  /**
   * 恢复为已发布 (decaying|evolving → active)，不更新 publishedAt
   */
  restore(): { success: boolean; error?: string } {
    return this._transition(Lifecycle.ACTIVE);
  }

  /**
   * 弃用 (pending|active|decaying → deprecated)
   */
  deprecate(reason: string): { success: boolean; error?: string } {
    const result = this._transition(Lifecycle.DEPRECATED);
    if (result.success) {
      this.rejectionReason = reason;
    }
    return result;
  }

  /**
   * 重新激活 (deprecated|staging → pending)
   */
  reactivate() {
    const result = this._transition(Lifecycle.PENDING);
    if (result.success) {
      this.rejectionReason = null;
    }
    return result;
  }

  /* ═══ 谓词 ═══════════════════════════════════════════ */

  /** 是否处于候选阶段 */
  isCandidate() {
    return isLifecycleCandidate(this.lifecycle);
  }

  /** 是否可被 Guard/Search/Export 消费 */
  isActive() {
    return this.lifecycle === Lifecycle.ACTIVE;
  }

  /** 是否为 Guard 规则类型 */
  isRule() {
    return this.kind === 'rule';
  }

  /** 内容是否有效 */
  isValid() {
    return !!(this.title?.trim() && this.content.hasContent());
  }

  /* ═══ Guard 消费 ═══════════════════════════════════ */

  /** 返回此 Entry 中可被 GuardCheckEngine 消费的规则列表 */
  getGuardRules() {
    if (!this.isActive() || !this.isRule()) {
      return [];
    }

    const regexRules = this.constraints.getRegexGuards().map((g: Guard) => ({
      id: g.id || this.id,
      type: 'regex',
      name: g.message || this.title,
      message: g.message || this.description || this.title,
      pattern: g.pattern,
      languages: this.language ? [this.language] : [],
      severity: g.severity || 'warning',
      source: 'knowledge_entry',
      fixSuggestion: g.fix_suggestion || null,
    }));

    const astRules = this.constraints.getAstGuards().map((g: Guard) => ({
      id: g.id || `${this.id}:ast`,
      type: 'ast',
      name: g.message || this.title,
      message: g.message,
      astQuery: g.ast_query,
      languages: g.ast_query?.language ? [g.ast_query.language] : [],
      severity: g.severity || 'warning',
      source: 'knowledge_entry',
      fixSuggestion: g.fix_suggestion || null,
    }));

    return [...regexRules, ...astRules];
  }

  /* ═══ 系统标签 ═══════════════════════════════════ */

  /** 系统内部标签前缀 — 内部元数据，不应暴露给最终用户 */
  static SYSTEM_TAG_PREFIXES = ['dimension:', 'bootstrap:', 'internal:', 'system:'];

  /** 判断是否为系统内部标签 */
  static isSystemTag(tag: string): boolean {
    return KnowledgeEntry.SYSTEM_TAG_PREFIXES.some((p) => tag.startsWith(p));
  }

  /* ═══ 序列化 ═══════════════════════════════════════ */

  /**
   * Domain → JSON (camelCase 直出，全链路统一)
   * 注意: tags 保留原始值（含系统标签），对外 API 使用 sanitizeForAPI() 过滤
   */
  toJSON(): KnowledgeEntryWire {
    return {
      id: this.id,
      title: this.title,
      description: this.description,
      lifecycle: this.lifecycle,
      lifecycleHistory: this.lifecycleHistory,
      autoApprovable: this.autoApprovable,
      language: this.language,
      category: this.category,
      kind: this.kind,
      knowledgeType: this.knowledgeType,
      complexity: this.complexity,
      scope: this.scope,
      difficulty: this.difficulty,
      tags: this.tags,
      trigger: this.trigger,
      topicHint: this.topicHint,
      whenClause: this.whenClause,
      doClause: this.doClause,
      dontClause: this.dontClause,
      coreCode: this.coreCode,
      usageGuide: this.usageGuide,
      content: this.content.toJSON(),
      relations: this.relations.toJSON(),
      constraints: this.constraints.toJSON(),
      reasoning: this.reasoning.toJSON(),
      quality: this.quality.toJSON(),
      stats: this.stats.toJSON(),
      headers: this.headers,
      headerPaths: this.headerPaths,
      moduleName: this.moduleName,
      includeHeaders: this.includeHeaders,
      agentNotes: this.agentNotes,
      aiInsight: this.aiInsight,
      reviewedBy: this.reviewedBy,
      reviewedAt: this.reviewedAt,
      rejectionReason: this.rejectionReason,
      source: this.source,
      sourceFile: this.sourceFile,
      sourceCandidateId: this.sourceCandidateId,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      publishedAt: this.publishedAt,
      publishedBy: this.publishedBy,
    };
  }

  /** JSON → Domain (camelCase 直入) */
  static fromJSON(data: unknown): KnowledgeEntry {
    if (!data) {
      return new KnowledgeEntry();
    }
    return new KnowledgeEntry(data as KnowledgeEntryProps);
  }

  /* ═══ 私有 ═══════════════════════════════════════════ */

  /** @returns } */
  _transition(to: string): { success: boolean; error?: string } {
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

  _now() {
    return Math.floor(Date.now() / 1000);
  }
}

export default KnowledgeEntry;

/**
 * lifecycle.js — 生命周期操作类工具 (10)
 *
 * 16.  submit_knowledge     提交候选项
 * 17.  approve_candidate    批准候选
 * 18.  reject_candidate     驳回候选
 * 19.  publish_recipe       发布 Recipe
 * 20.  deprecate_recipe     弃用 Recipe
 * 21.  update_recipe        更新 Recipe
 * 22.  record_usage         记录使用
 * 23.  quality_score        质量评分
 * 24.  validate_candidate   候选校验
 * 25.  get_feedback_stats   反馈统计
 */

import {
  getInternalAgentRequiredFields,
  getSystemInjectedFields,
} from '#domain/knowledge/FieldSpec.js';
import { UnifiedValidator } from '#domain/knowledge/UnifiedValidator.js';
import { checkDimensionType, DIMENSION_DISPLAY_GROUP, type ToolHandlerContext } from './_shared.js';

// ─── Tool handler param types ──────────────────────────────

export interface SubmitKnowledgeParams {
  content?: { markdown?: string; pattern?: string; rationale?: string; [key: string]: unknown };
  title?: string;
  description?: string;
  tags?: string[];
  trigger?: string;
  kind?: string;
  topicHint?: string;
  whenClause?: string;
  doClause?: string;
  dontClause?: string;
  coreCode?: string;
  reasoning?: { whyStandard?: string; sources?: string[]; confidence?: number };
  scope?: string;
  complexity?: string;
  headers?: string[];
  knowledgeType?: string;
  usageGuide?: string;
  sourceFile?: string;
  _category?: string;
  [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────
// 16. submit_knowledge
// ────────────────────────────────────────────────────────────
export const submitCandidate = {
  name: 'submit_knowledge',
  description: '提交新的代码候选项到知识库审核队列。',
  parameters: {
    type: 'object',
    properties: {
      // ── 内容（V3 content 子对象） ──
      content: {
        type: 'object',
        description:
          '{ markdown: "项目特写 Markdown(≥200字)", pattern: "核心代码 3-8 行", rationale: "设计原理" }',
      },

      // ── 基本信息 ──
      title: { type: 'string', description: '候选标题（中文 ≤20 字）' },
      description: { type: 'string', description: '中文简述 ≤80 字，引用真实类名' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },

      // ── Cursor 交付（AI 必填）──
      trigger: { type: 'string', description: '@前缀 kebab-case 唯一标识符' },
      kind: { type: 'string', enum: ['rule', 'pattern', 'fact'], description: '知识类型' },
      topicHint: {
        type: 'string',
        enum: ['networking', 'ui', 'data', 'architecture', 'conventions'],
        description: '主题分类',
      },
      whenClause: { type: 'string', description: '触发场景英文' },
      doClause: { type: 'string', description: '正向指令英文祈使句 ≤60 tokens' },
      dontClause: { type: 'string', description: "反向约束英文（不以 Don't 开头）" },
      coreCode: { type: 'string', description: '3-8 行纯代码骨架，语法完整可复制' },

      // ── 推理（必填） ──
      reasoning: {
        type: 'object',
        description: '{ whyStandard: string, sources: string[], confidence: number } — 全部必填',
      },

      // ── V3 扩展字段 ──
      scope: {
        type: 'string',
        enum: ['universal', 'project-specific', 'team-convention'],
        description: '适用范围',
      },
      complexity: {
        type: 'string',
        enum: ['basic', 'intermediate', 'advanced'],
        description: '复杂度',
      },
      headers: {
        type: 'array',
        items: { type: 'string' },
        description: '依赖的 import/require 行（无 import 时传 []）',
      },
      knowledgeType: {
        type: 'string',
        description: '知识维度：code-pattern / architecture / best-practice 等',
      },
      usageGuide: { type: 'string', description: '使用指南 Markdown（### 章节格式）' },
      sourceFile: { type: 'string', description: '来源文件相对路径' },
    },
    // FieldSpec 驱动: 内部 Agent 路径排除系统注入字段
    required: getInternalAgentRequiredFields(),
  },
  handler: async (params: SubmitKnowledgeParams, ctx: ToolHandlerContext) => {
    const knowledgeService = ctx.container.get('knowledgeService');

    // ── Bootstrap 维度类型校验 ──
    const dimMeta = ctx._dimensionMeta;
    if (dimMeta && ctx.source === 'system') {
      const rejected = checkDimensionType(dimMeta, params, ctx.logger);
      if (rejected) {
        return rejected;
      }

      // 自动注入维度标签
      if (!params.tags) {
        params.tags = [];
      }
      if (!params.tags.includes(dimMeta.id)) {
        params.tags.push(dimMeta.id);
      }
      if (!params.tags.includes('bootstrap')) {
        params.tags.push('bootstrap');
      }

      // Bootstrap 模式: 将 category 覆盖为展示分组 ID
      params._category =
        (DIMENSION_DISPLAY_GROUP as Record<string, string>)[dimMeta.id] || dimMeta.id;

      // ── UnifiedValidator 统一质量验证（替代 CandidateGuardrail） ──
      const validator =
        ctx._validator ||
        new UnifiedValidator({
          existingTitles: ctx._submittedTitles || new Set(),
          existingFingerprints: ctx._submittedPatterns || new Set(),
        });
      const validResult = validator.validate(params, {
        systemInjectedFields: getSystemInjectedFields(),
      });
      if (!validResult.pass) {
        ctx.logger?.info(
          `[submit_knowledge] ✗ validator rejected: ${validResult.errors.join('; ')}`
        );
        return {
          status: 'rejected',
          error: validResult.errors.join('\n'),
          warnings: validResult.warnings,
          hint: '请根据错误信息调整内容后重新提交。',
        };
      }
      if (validResult.warnings.length > 0) {
        ctx.logger?.debug(`[submit_knowledge] ⚠ warnings: ${validResult.warnings.join('; ')}`);
      }
    }

    // ── 系统自动设置 ──
    const systemFields = {
      language: ctx._projectLanguage || '',
      category: dimMeta
        ? (DIMENSION_DISPLAY_GROUP as Record<string, string>)[dimMeta.id] || dimMeta.id
        : 'general',
      knowledgeType: dimMeta?.allowedKnowledgeTypes?.[0] || 'code-pattern',
      source: ctx.source === 'system' ? 'bootstrap' : 'agent',
    };

    // ── 直传 → KnowledgeEntry ──
    const reasoning = params.reasoning || { whyStandard: '', sources: ['agent'], confidence: 0.7 };
    if (Array.isArray(reasoning.sources) && reasoning.sources.length === 0) {
      reasoning.sources = ['agent'];
    }

    // V3 content 直透
    const contentObj =
      params.content && typeof params.content === 'object'
        ? params.content
        : { markdown: '', pattern: '' };

    const data = {
      ...systemFields,
      title: params.title || '',
      description: params.description || '',
      tags: params.tags || [],
      trigger: params.trigger || '',
      kind: params.kind || 'pattern',
      topicHint: params.topicHint || '',
      whenClause: params.whenClause || '',
      doClause: params.doClause || '',
      dontClause: params.dontClause || '',
      coreCode: contentObj.pattern || '',
      content: contentObj,
      reasoning,
      // V3 扩展字段直透
      scope: params.scope || '',
      complexity: params.complexity || '',
      headers: params.headers || [],
      // 注意: sourceFile 由 KnowledgeFileWriter.persist() 自动设置，
      // 不应从 AI params/reasoning.sources 取值（那是项目源文件路径，不是知识文件路径）
      sourceFile: '',
      // 7.3.9 agentNotes/aiInsight 注入
      agentNotes: dimMeta
        ? { dimensionId: dimMeta.id, outputType: dimMeta.outputType || 'candidate' }
        : null,
      aiInsight: reasoning.whyStandard || params.description || null,
    };

    if (dimMeta && ctx.source === 'system') {
      const displayGroup =
        (DIMENSION_DISPLAY_GROUP as Record<string, string>)[dimMeta.id] || dimMeta.id;
      data.tags = [...new Set([...(data.tags || []), displayGroup])];
    }

    const saved = await knowledgeService.create(data, { userId: 'agent' });

    // ── QualityScorer 自动评分 ──
    try {
      await knowledgeService.updateQuality(saved.id, { userId: 'agent' });
    } catch {
      /* best effort — 不阻塞创建流程 */
    }

    return saved;
  },
};

// ────────────────────────────────────────────────────────────
// 16b. save_document — 保存开发文档到知识库
// ── (已删除: save_document — 已合并到 submit_knowledge 统一管线) ──

// ────────────────────────────────────────────────────────────
// 17. approve_candidate
// ────────────────────────────────────────────────────────────
export const approveCandidate = {
  name: 'approve_candidate',
  description: '批准候选项（PENDING → APPROVED）。',
  parameters: {
    type: 'object',
    properties: {
      candidateId: { type: 'string', description: '候选 ID' },
    },
    required: ['candidateId'],
  },
  handler: async (params: { candidateId: string }, ctx: ToolHandlerContext) => {
    const knowledgeService = ctx.container.get('knowledgeService');
    return knowledgeService.approve(params.candidateId, { userId: 'agent' });
  },
};

// ────────────────────────────────────────────────────────────
// 18. reject_candidate
// ────────────────────────────────────────────────────────────
export const rejectCandidate = {
  name: 'reject_candidate',
  description: '驳回候选项并填写驳回理由。',
  parameters: {
    type: 'object',
    properties: {
      candidateId: { type: 'string', description: '候选 ID' },
      reason: { type: 'string', description: '驳回理由' },
    },
    required: ['candidateId', 'reason'],
  },
  handler: async (params: { candidateId: string; reason: string }, ctx: ToolHandlerContext) => {
    const knowledgeService = ctx.container.get('knowledgeService');
    return knowledgeService.reject(params.candidateId, params.reason, { userId: 'agent' });
  },
};

// ────────────────────────────────────────────────────────────
// 19. publish_recipe
// ────────────────────────────────────────────────────────────
export const publishRecipe = {
  name: 'publish_recipe',
  description: '发布 Recipe（DRAFT → ACTIVE）。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
    },
    required: ['recipeId'],
  },
  handler: async (params: { recipeId: string }, ctx: ToolHandlerContext) => {
    const knowledgeService = ctx.container.get('knowledgeService');
    return knowledgeService.publish(params.recipeId, { userId: 'agent' });
  },
};

// ────────────────────────────────────────────────────────────
// 20. deprecate_recipe
// ────────────────────────────────────────────────────────────
export const deprecateRecipe = {
  name: 'deprecate_recipe',
  description: '弃用 Recipe 并填写弃用原因。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
      reason: { type: 'string', description: '弃用原因' },
    },
    required: ['recipeId', 'reason'],
  },
  handler: async (params: { recipeId: string; reason: string }, ctx: ToolHandlerContext) => {
    const knowledgeService = ctx.container.get('knowledgeService');
    return knowledgeService.deprecate(params.recipeId, params.reason, { userId: 'agent' });
  },
};

// ────────────────────────────────────────────────────────────
// 21. update_recipe
// ────────────────────────────────────────────────────────────
export const updateRecipe = {
  name: 'update_recipe',
  description: '更新 Recipe 的指定字段（title/description/content/category/tags 等）。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
      updates: { type: 'object', description: '要更新的字段和值' },
    },
    required: ['recipeId', 'updates'],
  },
  handler: async (
    params: { recipeId: string; updates: Record<string, unknown> },
    ctx: ToolHandlerContext
  ) => {
    const knowledgeService = ctx.container.get('knowledgeService');
    return knowledgeService.update(params.recipeId, params.updates, { userId: 'agent' });
  },
};

// ────────────────────────────────────────────────────────────
// 22. record_usage
// ────────────────────────────────────────────────────────────
export const recordUsage = {
  name: 'record_usage',
  description: '记录 Recipe 的使用（adoption 被采纳 / application 被应用）。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
      type: { type: 'string', description: 'adoption 或 application，默认 adoption' },
    },
    required: ['recipeId'],
  },
  handler: async (params: { recipeId: string; type?: string }, ctx: ToolHandlerContext) => {
    const knowledgeService = ctx.container.get('knowledgeService');
    const type = params.type || 'adoption';
    await knowledgeService.incrementUsage(params.recipeId, type);
    return { success: true, recipeId: params.recipeId, type };
  },
};

// ────────────────────────────────────────────────────────────
// 23. quality_score
// ────────────────────────────────────────────────────────────
export const qualityScore = {
  name: 'quality_score',
  description:
    'Recipe 质量评分 — 5 维度综合评估（完整性/格式/代码质量/元数据/互动），返回分数和等级(A-F)。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID（从数据库读取后评分）' },
      recipe: {
        type: 'object',
        description: '或直接提供 Recipe 对象 { title, trigger, code, language, ... }',
      },
    },
  },
  handler: async (
    params: { recipeId?: string; recipe?: Record<string, unknown> },
    ctx: ToolHandlerContext
  ) => {
    const qualityScorer = ctx.container.get('qualityScorer');
    let recipe = params.recipe;

    if (!recipe && params.recipeId) {
      const knowledgeService = ctx.container.get('knowledgeService');
      try {
        const entry = await knowledgeService.get(params.recipeId);
        recipe = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
      } catch {
        return { error: `Knowledge entry '${params.recipeId}' not found` };
      }
    }
    if (!recipe) {
      return { error: 'Provide recipeId or recipe object' };
    }

    return qualityScorer.score(recipe);
  },
};

// ────────────────────────────────────────────────────────────
// 24. validate_candidate
// ────────────────────────────────────────────────────────────
export const validateCandidate = {
  name: 'validate_candidate',
  description:
    '候选校验 — 检查候选是否满足提交要求（必填字段/格式/质量），返回 errors 和 warnings。',
  parameters: {
    type: 'object',
    properties: {
      candidate: {
        type: 'object',
        description: '候选对象 { title, trigger, category, language, code, reasoning, ... }',
      },
    },
    required: ['candidate'],
  },
  handler: async (params: { candidate: Record<string, unknown> }, ctx: ToolHandlerContext) => {
    const validator = ctx.container.get('recipeCandidateValidator');
    return validator.validate(params.candidate);
  },
};

// ────────────────────────────────────────────────────────────
// 25. get_feedback_stats
// ────────────────────────────────────────────────────────────
export const getFeedbackStats = {
  name: 'get_feedback_stats',
  description: '获取用户反馈统计 — 全局交互事件统计 + 热门 Recipe + 指定 Recipe 的详细反馈。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: '查询指定 Recipe 的反馈（可选）' },
      topN: { type: 'number', description: '热门 Recipe 数量，默认 10' },
    },
  },
  handler: async (params: { recipeId?: string; topN?: number }, ctx: ToolHandlerContext) => {
    const feedbackCollector = ctx.container.get('feedbackCollector');
    const result: Record<string, unknown> = {};

    result.global = feedbackCollector.getGlobalStats();
    result.topRecipes = feedbackCollector.getTopRecipes(params.topN || 10);

    if (params.recipeId) {
      result.recipeStats = feedbackCollector.getRecipeStats(params.recipeId);
    }

    return result;
  },
};

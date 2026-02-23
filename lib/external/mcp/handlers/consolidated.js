/**
 * MCP 整合 Handler — 参数路由层
 *
 * 将整合后的工具（autosnippet_search / knowledge / structure / graph / guard / skill）
 * 按 operation / mode 参数路由到已有 handler 实现。
 *
 * 不包含业务逻辑，仅做参数解构 → 路由 → 转发。
 *
 * autosnippet_bootstrap 已迁移到 bootstrap-external.js（外部 Agent 路径）。
 */

import * as browseHandlers from './browse.js';
import * as candidateHandlers from './candidate.js';
import * as guardHandlers from './guard.js';
import { REQUIRED_FIELDS_DESCRIPTION } from './bootstrap/shared/dimension-text.js';
import * as searchHandlers from './search.js';
import * as skillHandlers from './skill.js';
import * as structureHandlers from './structure.js';

// ─── autosnippet_search (整合 4 → 1) ────────────────────────

/**
 * 统合搜索：根据 mode 参数路由到对应搜索 handler
 *   auto (默认) → search()
 *   keyword     → keywordSearch()
 *   semantic    → semanticSearch()
 *   context     → contextSearch()
 */
export async function consolidatedSearch(ctx, args) {
  const mode = args.mode || 'auto';
  switch (mode) {
    case 'keyword':
      return searchHandlers.keywordSearch(ctx, args);
    case 'semantic':
      return searchHandlers.semanticSearch(ctx, args);
    case 'context':
      return searchHandlers.contextSearch(ctx, args);
    default:
      return searchHandlers.search(ctx, { ...args, mode });
  }
}

// ─── autosnippet_knowledge (整合 7 → 1) ─────────────────────

/**
 * 知识浏览：根据 operation 参数路由
 *   list (默认) → listByKind() 或 listRecipes()
 *   get          → getRecipe()
 *   insights     → recipeInsights()
 *   confirm_usage → confirmUsage()
 */
export async function consolidatedKnowledge(ctx, args) {
  const op = args.operation || 'list';
  switch (op) {
    case 'list': {
      const kind = args.kind;
      if (kind && kind !== 'all') {
        return browseHandlers.listByKind(ctx, kind, args);
      }
      return browseHandlers.listRecipes(ctx, args);
    }
    case 'get':
      return browseHandlers.getRecipe(ctx, args);
    case 'insights':
      return browseHandlers.recipeInsights(ctx, args);
    case 'confirm_usage':
      // confirmUsage expects { recipeId, usageType, feedback }
      // 适配：如果传了 id 但没传 recipeId，自动映射
      if (args.id && !args.recipeId) {
        args.recipeId = args.id;
      }
      return browseHandlers.confirmUsage(ctx, args);
    default:
      throw new Error(
        `Unknown knowledge operation: ${op}. Expected: list, get, insights, confirm_usage`
      );
  }
}

// ─── autosnippet_structure (整合 3 → 1) ─────────────────────

/**
 * 项目结构：根据 operation 参数路由
 *   targets (默认) → getTargets()
 *   files          → getTargetFiles()
 *   metadata       → getTargetMetadata()
 */
export async function consolidatedStructure(ctx, args) {
  const op = args.operation || 'targets';
  switch (op) {
    case 'targets':
      return structureHandlers.getTargets(ctx, args);
    case 'files':
      return structureHandlers.getTargetFiles(ctx, args);
    case 'metadata':
      return structureHandlers.getTargetMetadata(ctx, args);
    default:
      throw new Error(`Unknown structure operation: ${op}. Expected: targets, files, metadata`);
  }
}

// ─── autosnippet_graph (整合 4 → 1) ─────────────────────────

/**
 * 知识图谱：根据 operation 参数路由
 *   query   → graphQuery()
 *   impact  → graphImpact()
 *   path    → graphPath()
 *   stats   → graphStats()
 */
export async function consolidatedGraph(ctx, args) {
  const op = args.operation;
  if (!op) {
    throw new Error('Missing required parameter: operation. Expected: query, impact, path, stats');
  }
  switch (op) {
    case 'query':
      return structureHandlers.graphQuery(ctx, args);
    case 'impact':
      return structureHandlers.graphImpact(ctx, args);
    case 'path':
      return structureHandlers.graphPath(ctx, args);
    case 'stats':
      return structureHandlers.graphStats(ctx);
    default:
      throw new Error(`Unknown graph operation: ${op}. Expected: query, impact, path, stats`);
  }
}

// ─── autosnippet_guard (整合 2 → 1) ─────────────────────────

/**
 * Guard 检查：按参数自动路由
 *   有 code  → guardCheck()   (单文件)
 *   有 files → guardAuditFiles() (多文件)
 */
export async function consolidatedGuard(ctx, args) {
  if (args.files && Array.isArray(args.files) && args.files.length > 0) {
    return guardHandlers.guardAuditFiles(ctx, args);
  }
  if (args.code) {
    return guardHandlers.guardCheck(ctx, args);
  }
  throw new Error(
    'autosnippet_guard requires either "code" (single check) or "files" (batch audit) parameter'
  );
}

// ─── autosnippet_skill (整合 6 → 1) ─────────────────────────

/**
 * Skill 管理：根据 operation 参数路由
 *   list    → listSkills()
 *   load    → loadSkill()
 *   create  → createSkill()
 *   update  → updateSkill()
 *   delete  → deleteSkill()
 *   suggest → suggestSkills()
 */
export async function consolidatedSkill(ctx, args) {
  const op = args.operation;
  if (!op) {
    throw new Error(
      'Missing required parameter: operation. Expected: list, load, create, update, delete, suggest'
    );
  }

  // loadSkill expects { skillName }, map from { name }
  if (args.name && !args.skillName) {
    args.skillName = args.name;
  }

  switch (op) {
    case 'list':
      return skillHandlers.listSkills();
    case 'load':
      return skillHandlers.loadSkill(ctx, args);
    case 'create':
      return skillHandlers.createSkill(ctx, args);
    case 'update':
      return skillHandlers.updateSkill(ctx, args);
    case 'delete':
      return skillHandlers.deleteSkill(ctx, args);
    case 'suggest':
      return skillHandlers.suggestSkills(ctx);
    default:
      throw new Error(
        `Unknown skill operation: ${op}. Expected: list, load, create, update, delete, suggest`
      );
  }
}

// ─── autosnippet_submit_knowledge (增强：严格前置校验 + dedup + 提交追踪) ──

/**
 * 增强版提交：严格前置校验，缺少必要字段直接拒绝（不入库）。
 * 通过校验后执行提交 + 去重检测，结果附在响应中。
 * v2: 成功提交后记录到 BootstrapSession.submissionTracker (如果有活跃 session)。
 *
 * 设计原则：
 *   - 不降级：缺字段不自动补全，要求 Agent 一次性生成完整数据
 *   - 不重复提交：拒绝时不创建任何记录，Agent 需补齐后重新调用
 */
export async function enhancedSubmitKnowledge(ctx, args) {
  const { submitKnowledge } = await import('./knowledge.js');
  const { checkRecipeReadiness } = await import('../../../shared/RecipeReadinessChecker.js');
  const { envelope } = await import('../envelope.js');

  const skipDuplicateCheck = args.skipDuplicateCheck === true;

  // ── 严格前置校验：RecipeReady 不通过则直接拒绝 ──
  const readinessInput = {
    title: args.title,
    code: args.content?.pattern || args.code || '',
    language: args.language,
    category: args.category,
    trigger: args.trigger,
    description: args.description,
    headers: args.headers,
    reasoning: args.reasoning,
    knowledgeType: args.knowledgeType,
    complexity: args.complexity,
    usageGuide: args.usageGuide,
    rationale: args.content?.rationale || args.rationale,
    kind: args.kind,
    doClause: args.doClause,
    dontClause: args.dontClause,
    whenClause: args.whenClause,
    topicHint: args.topicHint,
    coreCode: args.coreCode,
  };
  const readiness = checkRecipeReadiness(readinessInput);
  if (!readiness.ready) {
    // v2: 记录拒绝到 BootstrapSession tracker
    _trackRejection(ctx, args.title, readiness.missing.join(', '));

    return envelope({
      success: false,
      message: `提交被拒绝：缺少必要字段 [${readiness.missing.join(', ')}]。请在单次调用中补齐所有字段后重新提交，不要分步提交或先提交再补全。`,
      errorCode: 'INCOMPLETE_SUBMISSION',
      data: {
        missingFields: readiness.missing,
        suggestions: readiness.suggestions,
        requiredFields: REQUIRED_FIELDS_DESCRIPTION,
      },
      meta: { tool: 'autosnippet_submit_knowledge' },
    });
  }

  // ── 校验通过，执行提交 ──
  const result = await submitKnowledge(ctx, args);

  // 如果提交本身失败，直接返回
  if (result && !result.success) {
    return result;
  }

  // ── 附加去重检测结果（非阻塞） ──
  let duplicateCheck = null;
  if (!skipDuplicateCheck) {
    try {
      const dedupCandidate = {
        title: args.title,
        summary: args.description || '',
        code: args.content?.pattern || '',
      };
      const dedupResult = await candidateHandlers.checkDuplicate(ctx, {
        candidate: dedupCandidate,
        threshold: 0.7,
        topK: 3,
      });
      if (dedupResult?.data) {
        duplicateCheck = {
          hasSimilar: dedupResult.data.hasDuplicate ?? dedupResult.data.matches?.length > 0,
          closest: dedupResult.data.matches?.[0] || null,
        };
      }
    } catch {
      duplicateCheck = { hasSimilar: false, note: 'dedup skipped due to error' };
    }
  }

  // 将去重结果附到响应中
  if (result?.data) {
    result.data.duplicateCheck = duplicateCheck;
  }

  // v2: 记录成功提交到 BootstrapSession tracker
  if (result?.data?.id) {
    _trackSubmission(ctx, args, result.data.id);
  }

  return result;
}

// ── v2: BootstrapSession 提交追踪辅助函数 ──────────────────

/**
 * 记录成功提交到活跃 BootstrapSession 的 submissionTracker
 * 静默失败 — tracker 不可用时不影响提交本身
 */
function _trackSubmission(ctx, args, recipeId) {
  try {
    const sessionManager = ctx.container.get('bootstrapSessionManager');
    const session = sessionManager?.getSession?.();
    if (!session?.submissionTracker) return;

    // 推断当前维度: 从 session 进度中找到第一个未完成的维度
    const progress = session.getProgress();
    const currentDimId = progress.remainingDimIds[0] || args.knowledgeType || 'unknown';

    session.submissionTracker.recordSubmission(currentDimId, args, recipeId);
  } catch {
    // tracker 不可用时静默降级
  }
}

/**
 * 记录拒绝到活跃 BootstrapSession 的 submissionTracker
 */
function _trackRejection(ctx, title, reason) {
  try {
    const sessionManager = ctx.container.get('bootstrapSessionManager');
    const session = sessionManager?.getSession?.();
    if (!session?.submissionTracker) return;

    const progress = session.getProgress();
    const currentDimId = progress.remainingDimIds[0] || 'unknown';

    session.submissionTracker.recordRejection(currentDimId, title || '(untitled)', reason);
  } catch {
    // 静默降级
  }
}

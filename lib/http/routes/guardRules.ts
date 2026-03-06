/**
 * 防护规则 API 路由
 * 管理代码质量防护规则的 CRUD 和生命周期操作
 */

import express from 'express';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { NotFoundError, ValidationError } from '../../shared/errors/index.js';
import { LanguageService } from '../../shared/LanguageService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getContext, safeInt } from '../utils/routeHelpers.js';

const router = express.Router();

const MAX_BATCH_SIZE = 100;

/**
 * 将 Recipe 实体 → Guard 规则扁平格式（Dashboard GuardView 期望）
 */
function mapRecipeToGuardRule(r) {
  const guards = r.constraints?.guards || [];
  const firstGuard = guards[0] || {};
  return {
    id: r.id,
    ruleId: r.id,
    message: firstGuard.message || r.description || r.title || '',
    severity: firstGuard.severity || 'warning',
    pattern: firstGuard.pattern || r.content?.pattern || '',
    languages: r.tags?.length > 0 ? r.tags : r.language ? [r.language] : [],
    note: r.content?.rationale || '',
    dimension: r.scope || 'file',
    rationale: r.content?.rationale || '',
    sourceRecipe: r.id,
    enabled: r.status === 'active',
  };
}

/**
 * GET /api/v1/rules
 * 获取防护规则列表（支持筛选和分页）
 * 同时包含内置规则 + 数据库规则
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { severity, category, enabled, sourceRecipe, keyword } = req.query;
    const page = safeInt(req.query.page, 1);
    const pageSize = safeInt(req.query.limit, 20, 1, 100);

    const container = getServiceContainer();
    const guardService = container.get('guardService');

    // 获取数据库中的 boundary-constraint 规则
    let result;
    if (keyword) {
      result = await guardService.searchRules(keyword, { page, pageSize });
    } else {
      const filters: any = {};
      if (severity) {
        filters.severity = severity;
      }
      if (category) {
        filters.category = category;
      }
      if (enabled !== undefined) {
        filters.enabled = enabled === 'true';
      }
      if (sourceRecipe) {
        filters.sourceRecipe = sourceRecipe;
      }
      result = await guardService.listRules(filters, { page, pageSize });
    }

    // 将 Recipe 实体映射为 Guard 规则扁平格式
    const dbItems = result?.data || [];
    const mappedDbRules = dbItems.map(mapRecipeToGuardRule);

    // 合并内置规则（GuardCheckEngine 内置 9 条 iOS 规则）
    let guardCheckEngine;
    try {
      guardCheckEngine = container.get('guardCheckEngine');
    } catch {
      /* not registered */
    }
    const builtInEntries = guardCheckEngine
      ? Object.entries(guardCheckEngine.getBuiltInRules())
      : [];
    const dbRuleIds = new Set(mappedDbRules.map((r) => r.id));
    const builtInRules = builtInEntries
      .filter(([id]) => !dbRuleIds.has(id))
      .map(([id, r]) => ({
        id,
        ruleId: id,
        // @ts-expect-error TS migration: TS2339
        message: r.message,
        // @ts-expect-error TS migration: TS2339
        severity: r.severity,
        // @ts-expect-error TS migration: TS2339
        pattern: r.pattern,
        // @ts-expect-error TS migration: TS2339
        languages: r.languages || [],
        // @ts-expect-error TS migration: TS2339
        dimension: r.dimension || 'file',
        // @ts-expect-error TS migration: TS2339
        category: r.category || '',
        // @ts-expect-error TS migration: TS2339
        fixSuggestion: r.fixSuggestion || '',
        note: '',
        enabled: true,
        source: 'built-in',
      }));

    const allRules = [...mappedDbRules, ...builtInRules];

    // 获取当前项目检测到的语言列表，供前端按项目语言筛选
    // 使用 LanguageService 统一检测（支持 Discoverer + Monorepo 文件标记回退）
    let projectLanguages = [];
    try {
      const moduleService = container.get('moduleService');
      await moduleService.load();
      const info = moduleService.getProjectInfo();
      const discovererIds = info.languages || [];
      projectLanguages = LanguageService.detectProjectLanguages(process.cwd(), { discovererIds });
    } catch {
      // moduleService 不可用时纯文件扫描回退
      projectLanguages = LanguageService.detectProjectLanguages(process.cwd());
    }

    // Guard 内置规则中 objectivec 记为 'objc'，做向后兼容映射
    projectLanguages = projectLanguages.map((l) => LanguageService.toGuardLangId(l));

    res.json({
      success: true,
      data: {
        data: allRules,
        projectLanguages,
        pagination: result?.pagination || { page, pageSize, total: allRules.length, pages: 1 },
      },
    });
  })
);

/**
 * GET /api/v1/rules/stats
 * 获取防护规则统计
 */
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const guardService = container.get('guardService');
    const stats = await guardService.getRuleStats();
    res.json({ success: true, data: stats });
  })
);

/**
 * GET /api/v1/rules/:id
 * 获取防护规则详情
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const container = getServiceContainer();
    const recipeRepo = container.get('knowledgeRepository');
    const rule = await recipeRepo.findById(id);

    if (!rule) {
      throw new NotFoundError('Guard rule not found', 'recipe', id);
    }

    res.json({ success: true, data: rule });
  })
);

/**
 * POST /api/v1/rules
 * 创建防护规则 (Gateway 管控: 权限 + 宪法 + 审计)
 * 兼容前端字段: { ruleId, message, pattern, languages, note, dimension }
 * 同时兼容 V2 字段: { name, description, pattern, severity, category }
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    // 兼容前端 GuardView 发来的字段名
    const name = req.body.name || req.body.ruleId;
    const description = req.body.description || req.body.message || '';
    const { pattern, severity, category, sourceRecipeId, sourceReason } = req.body;
    const note = req.body.note || sourceReason || '';
    const languages = req.body.languages || (category ? [category] : []);
    const dimension = req.body.dimension || null;

    if (!name || !pattern) {
      throw new ValidationError('name/ruleId and pattern are required');
    }

    const result = await req.gw('guard_rule:create', 'guard_rules', {
      name,
      description,
      pattern,
      severity: severity || 'warning',
      category: languages[0] || category || 'guard',
      languages,
      note,
      dimension,
      sourceRecipeId,
      sourceReason: note,
    });

    res.status(201).json({ success: true, data: result.data, requestId: result.requestId });
  })
);

/**
 * POST /api/v1/rules/batch-enable
 * 批量启用防护规则
 */
router.post(
  '/batch-enable',
  asyncHandler(async (req, res) => {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      throw new ValidationError('ids array is required and must not be empty');
    }
    if (ids.length > MAX_BATCH_SIZE) {
      throw new ValidationError(`Batch size exceeds limit of ${MAX_BATCH_SIZE}`);
    }

    const container = getServiceContainer();
    const guardService = container.get('guardService');
    const context = getContext(req);

    const results = await Promise.allSettled(ids.map((id) => guardService.enableRule(id, context)));

    const enabled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? { id: ids[i], error: r.reason?.message } : null))
      .filter(Boolean);

    res.json({
      success: true,
      data: {
        enabled,
        failed,
        total: ids.length,
        successCount: enabled.length,
        failureCount: failed.length,
      },
    });
  })
);

/**
 * POST /api/v1/rules/batch-disable
 * 批量禁用防护规则
 */
router.post(
  '/batch-disable',
  asyncHandler(async (req, res) => {
    const { ids, reason } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      throw new ValidationError('ids array is required and must not be empty');
    }
    if (ids.length > MAX_BATCH_SIZE) {
      throw new ValidationError(`Batch size exceeds limit of ${MAX_BATCH_SIZE}`);
    }

    const container = getServiceContainer();
    const guardService = container.get('guardService');
    const context = getContext(req);

    const results = await Promise.allSettled(
      ids.map((id) => guardService.disableRule(id, reason || '', context))
    );

    const disabled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? { id: ids[i], error: r.reason?.message } : null))
      .filter(Boolean);

    res.json({
      success: true,
      data: {
        disabled,
        failed,
        total: ids.length,
        successCount: disabled.length,
        failureCount: failed.length,
      },
    });
  })
);

/**
 * PATCH /api/v1/rules/:id/enable
 * 启用防护规则
 */
router.patch(
  '/:id/enable',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const container = getServiceContainer();
    const guardService = container.get('guardService');
    const context = getContext(req);

    const rule = await guardService.enableRule(id, context);
    res.json({ success: true, data: rule });
  })
);

/**
 * PATCH /api/v1/rules/:id/disable
 * 禁用防护规则
 */
router.patch(
  '/:id/disable',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    const container = getServiceContainer();
    const guardService = container.get('guardService');
    const context = getContext(req);

    const rule = await guardService.disableRule(id, reason || '', context);
    res.json({ success: true, data: rule });
  })
);

/**
 * POST /api/v1/rules/check
 * 检查代码是否违反规则
 */
router.post(
  '/check',
  asyncHandler(async (req, res) => {
    const { code, language, ruleIds } = req.body;

    if (!code) {
      throw new ValidationError('code is required');
    }

    const container = getServiceContainer();
    const guardService = container.get('guardService');

    const result = await guardService.checkCode(code, { language, ruleIds });
    res.json({ success: true, data: result });
  })
);

/**
 * POST /api/v1/rules/import-from-recipe
 * 从 Recipe 导入防护规则
 */
router.post(
  '/import-from-recipe',
  asyncHandler(async (req, res) => {
    const { recipeId, rules } = req.body;

    if (!recipeId) {
      throw new ValidationError('recipeId is required');
    }
    if (!Array.isArray(rules) || rules.length === 0) {
      throw new ValidationError('rules array is required and must not be empty');
    }

    const container = getServiceContainer();
    const guardService = container.get('guardService');
    const context = getContext(req);

    const importedRules = await guardService.importRulesFromRecipe(recipeId, rules, context);
    res.status(201).json({
      success: true,
      data: { importedRules, count: importedRules.length },
    });
  })
);

/**
 * GET /api/v1/rules/compliance
 * 生成全项目合规报告
 * Query params:
 *   - path: 扫描根目录（默认 projectRoot）
 *   - maxErrors: Quality Gate 最大 error 数（默认 0）
 *   - maxWarnings: Quality Gate 最大 warning 数（默认 20）
 *   - minScore: Quality Gate 最低分（默认 70）
 *   - maxFiles: 最大扫描文件数（默认 500）
 */
router.get(
  '/compliance',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const reporter = container.get('complianceReporter');
    const projectRoot = req.query.path || process.env.ASD_PROJECT_DIR || process.cwd();

    const report = await reporter.generate(projectRoot, {
      qualityGate: {
        maxErrors: parseInt(req.query.maxErrors) || 0,
        maxWarnings: parseInt(req.query.maxWarnings) || 20,
        minScore: parseInt(req.query.minScore) || 70,
      },
      maxFiles: parseInt(req.query.maxFiles) || 500,
    });

    res.json({ success: true, data: report });
  })
);

export default router;

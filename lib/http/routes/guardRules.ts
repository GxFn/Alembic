/**
 * 防护规则 API 路由
 * 管理代码质量防护规则的 CRUD 和生命周期操作
 */

import express, { type Request, type Response } from 'express';
import { ioLimit } from '#shared/concurrency.js';
import {
  BatchDisableBody,
  BatchEnableBody,
  CheckCodeBody,
  CreateGuardRuleBody,
  ImportFromRecipeBody,
} from '#shared/schemas/http-requests.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { LanguageService } from '../../shared/LanguageService.js';
import { validate } from '../middleware/validate.js';
import { getContext, safeInt } from '../utils/routeHelpers.js';

const router = express.Router();

/**
 * 将 Recipe 实体 → Guard 规则扁平格式（Dashboard GuardView 期望）
 */
function mapRecipeToGuardRule(r: Record<string, unknown>) {
  const constraints = r.constraints as Record<string, unknown[]> | undefined;
  const guards = constraints?.guards || [];
  const firstGuard = (guards[0] || {}) as Record<string, unknown>;
  const content = r.content as Record<string, unknown> | undefined;
  const tags = r.tags as string[] | undefined;
  return {
    id: r.id,
    ruleId: r.id,
    message: firstGuard.message || r.description || r.title || '',
    severity: firstGuard.severity || 'warning',
    pattern: firstGuard.pattern || content?.pattern || '',
    languages: tags && tags.length > 0 ? tags : r.language ? [r.language] : [],
    note: content?.rationale || '',
    dimension: r.scope || 'file',
    rationale: content?.rationale || '',
    sourceRecipe: r.id,
    enabled: r.status === 'active',
  };
}

/**
 * GET /api/v1/rules
 * 获取防护规则列表（支持筛选和分页）
 * 同时包含内置规则 + 数据库规则
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const { severity, category, enabled, sourceRecipe, keyword } = req.query;
  const page = safeInt(req.query.page, 1);
  const pageSize = safeInt(req.query.limit, 20, 1, 100);

  const container = getServiceContainer();
  const guardService = container.get('guardService');

  // 获取数据库中的 boundary-constraint 规则
  let result: { data?: Record<string, unknown>[]; pagination?: Record<string, unknown> };
  if (keyword) {
    result = (await guardService.searchRules(String(keyword), { page, pageSize })) as typeof result;
  } else {
    const filters: Record<string, unknown> = {};
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
    result = (await guardService.listRules(filters, { page, pageSize })) as typeof result;
  }

  // 将 Recipe 实体映射为 Guard 规则扁平格式
  const dbItems = result?.data || [];
  const mappedDbRules = dbItems.map(mapRecipeToGuardRule);

  // 合并内置规则（GuardCheckEngine 内置 9 条 iOS 规则）
  let guardCheckEngine: { getBuiltInRules(): Record<string, unknown> } | undefined;
  try {
    guardCheckEngine = container.get('guardCheckEngine');
  } catch {
    /* not registered */
  }
  const builtInEntries = guardCheckEngine
    ? (Object.entries(guardCheckEngine.getBuiltInRules()) as [string, Record<string, unknown>][])
    : [];
  const dbRuleIds = new Set(mappedDbRules.map((r: Record<string, unknown>) => r.id));
  const builtInRules = builtInEntries
    .filter(([id]) => !dbRuleIds.has(id))
    .map(([id, r]) => ({
      id,
      ruleId: id,
      message: r.message,
      severity: r.severity,
      pattern: r.pattern,
      languages: r.languages || [],
      dimension: r.dimension || 'file',
      category: r.category || '',
      fixSuggestion: r.fixSuggestion || '',
      note: '',
      enabled: true,
      source: 'built-in',
    }));

  const allRules = [...mappedDbRules, ...builtInRules];

  // 获取当前项目检测到的语言列表，供前端按项目语言筛选
  // 使用 LanguageService 统一检测（支持 Discoverer + Monorepo 文件标记回退）
  let projectLanguages: string[] = [];
  try {
    const moduleService = container.get('moduleService');
    await moduleService.load();
    const info = moduleService.getProjectInfo();
    const discovererIds = info.languages || [];
    projectLanguages = LanguageService.detectProjectLanguages(process.cwd(), {
      discovererIds,
    }) as string[];
  } catch {
    // moduleService 不可用时纯文件扫描回退
    projectLanguages = LanguageService.detectProjectLanguages(process.cwd()) as string[];
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
});

/**
 * GET /api/v1/rules/stats
 * 获取防护规则统计
 */
router.get('/stats', async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const guardService = container.get('guardService');
  const stats = await guardService.getRuleStats();
  res.json({ success: true, data: stats });
});

/**
 * GET /api/v1/rules/:id
 * 获取防护规则详情
 */
router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const container = getServiceContainer();
  const recipeRepo = container.get('knowledgeRepository');
  const rule = await recipeRepo.findById(String(id));

  if (!rule) {
    throw new NotFoundError('Guard rule not found', 'recipe', id as string);
  }

  res.json({ success: true, data: rule });
});

/**
 * POST /api/v1/rules
 * 创建防护规则 (Gateway 管控: 权限 + 宪法 + 审计)
 * 兼容前端字段: { ruleId, message, pattern, languages, note, dimension }
 * 同时兼容 V2 字段: { name, description, pattern, severity, category }
 */
router.post('/', validate(CreateGuardRuleBody), async (req: Request, res: Response) => {
  // 兼容前端 GuardView 发来的字段名
  const name = req.body.name || req.body.ruleId;
  const description = req.body.description || req.body.message || '';
  const { pattern, severity, category, sourceRecipeId, sourceReason } = req.body;
  const note = req.body.note || sourceReason || '';
  const languages = req.body.languages || (category ? [category] : []);
  const dimension = req.body.dimension || null;

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
});

/**
 * POST /api/v1/rules/batch-enable
 * 批量启用防护规则
 */
router.post('/batch-enable', validate(BatchEnableBody), async (req: Request, res: Response) => {
  const { ids } = req.body;

  const container = getServiceContainer();
  const guardService = container.get('guardService');
  const context = getContext(req);

  const results = await Promise.allSettled(
    ids.map((id: string) => ioLimit(() => guardService.enableRule(id, context)))
  );

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
});

/**
 * POST /api/v1/rules/batch-disable
 * 批量禁用防护规则
 */
router.post('/batch-disable', validate(BatchDisableBody), async (req: Request, res: Response) => {
  const { ids, reason } = req.body;

  const container = getServiceContainer();
  const guardService = container.get('guardService');
  const context = getContext(req);

  const results = await Promise.allSettled(
    ids.map((id: string) => ioLimit(() => guardService.disableRule(id, reason || '', context)))
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
});

/**
 * PATCH /api/v1/rules/:id/enable
 * 启用防护规则
 */
router.patch('/:id/enable', async (req: Request, res: Response) => {
  const { id } = req.params;
  const container = getServiceContainer();
  const guardService = container.get('guardService');
  const context = getContext(req);

  const rule = await guardService.enableRule(String(id), context);
  res.json({ success: true, data: rule });
});

/**
 * PATCH /api/v1/rules/:id/disable
 * 禁用防护规则
 */
router.patch('/:id/disable', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body;

  const container = getServiceContainer();
  const guardService = container.get('guardService');
  const context = getContext(req);

  const rule = await guardService.disableRule(String(id), reason || '', context);
  res.json({ success: true, data: rule });
});

/**
 * POST /api/v1/rules/check
 * 检查代码是否违反规则
 */
router.post('/check', validate(CheckCodeBody), async (req: Request, res: Response) => {
  const { code, language, ruleIds } = req.body;

  const container = getServiceContainer();
  const guardService = container.get('guardService');

  const result = await guardService.checkCode(code, { language, ruleIds } as unknown as Parameters<
    typeof guardService.checkCode
  >[1]);
  res.json({ success: true, data: result });
});

/**
 * POST /api/v1/rules/import-from-recipe
 * 从 Recipe 导入防护规则
 */
router.post(
  '/import-from-recipe',
  validate(ImportFromRecipeBody),
  async (req: Request, res: Response) => {
    const { recipeId, rules } = req.body;

    const container = getServiceContainer();
    const guardService = container.get('guardService');
    const context = getContext(req);

    const importedRules = (await (
      guardService as unknown as Record<string, Function>
    ).importRulesFromRecipe(recipeId, rules, context)) as unknown[];
    res.status(201).json({
      success: true,
      data: { importedRules, count: importedRules.length },
    });
  }
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
router.get('/compliance', async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const reporter = container.get('complianceReporter');
  const projectRoot = String(req.query.path || process.env.ASD_PROJECT_DIR || process.cwd());

  const report = await reporter.generate(projectRoot, {
    qualityGate: {
      maxErrors: parseInt(req.query.maxErrors as string) || 0,
      maxWarnings: parseInt(req.query.maxWarnings as string) || 20,
      minScore: parseInt(req.query.minScore as string) || 70,
    },
    maxFiles: parseInt(req.query.maxFiles as string) || 500,
  });

  res.json({ success: true, data: report });
});

export default router;

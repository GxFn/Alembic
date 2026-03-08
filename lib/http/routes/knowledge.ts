/**
 * Knowledge API 路由 (V3)
 * 统一知识条目的 CRUD + 生命周期操作
 * 替代 recipes.js + candidates.js （旧路由继续保留用于向后兼容）
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { ioLimit } from '#shared/concurrency.js';
import {
  BatchPublishBody,
  CreateKnowledgeBody,
  DeprecateKnowledgeBody,
  KnowledgeUsageBody,
  UpdateKnowledgeBody,
} from '#shared/schemas/http-requests.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validate } from '../middleware/validate.js';
import {
  getContext,
  safeInt,
  sanitizeForAPI,
  sanitizePaginatedForAPI,
} from '../utils/routeHelpers.js';

const _logger = Logger.getInstance();
const router = express.Router();

/* ═══ 权限中间件 ═════════════════════════════════════════ */

/**
 * 路由级权限检查中间件
 * 使用 roleResolver 已解析的 req.resolvedRole + PermissionManager 校验
 * 当角色缺少指定 action:resource 权限时返回 403
 */
function requirePermission(action: string, resource: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = (req.resolvedRole as string) || 'anonymous';
    try {
      const container = getServiceContainer();
      const permissionManager = container.get('permissionManager');
      if (permissionManager) {
        const result = permissionManager.check(role, action, resource);
        if (!result.allowed) {
          _logger.warn('Knowledge route permission denied', {
            role,
            action,
            resource,
            reason: result.reason,
          });
          res.status(403).json({
            success: false,
            error: {
              message: `Permission denied: role '${role}' cannot ${action} on ${resource}. ${result.reason}`,
              code: 'PERMISSION_DENIED',
            },
          });
          return;
        }
      }
    } catch {
      // PermissionManager 不可用时降级放行（向后兼容）
    }
    next();
  };
}

/* ═══ 查询 ═══════════════════════════════════════════════ */

/**
 * GET /api/v1/knowledge
 * 获取知识条目列表（支持筛选和分页）
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const { lifecycle, kind, category, language, knowledgeType, scope, keyword, tag, source } =
    req.query;
  const page = safeInt(req.query.page, 1);
  const pageSize = safeInt(req.query.limit, 20, 1, 1000);

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');

  if (keyword) {
    const result = await knowledgeService.search(keyword, { page, pageSize });
    return void res.json({ success: true, data: sanitizePaginatedForAPI(result) });
  }

  const filters: Record<string, unknown> = {};
  if (lifecycle) {
    filters.lifecycle = lifecycle;
  }
  if (kind) {
    filters.kind = kind;
  }
  if (category) {
    filters.category = category;
  }
  if (language) {
    filters.language = language;
  }
  if (knowledgeType) {
    filters.knowledgeType = knowledgeType;
  }
  if (scope) {
    filters.scope = scope;
  }
  if (tag) {
    filters.tag = tag;
  }
  if (source) {
    filters.source = source;
  }

  const result = await knowledgeService.list(filters, { page, pageSize });
  res.json({ success: true, data: sanitizePaginatedForAPI(result) });
});

/**
 * GET /api/v1/knowledge/stats
 * 获取统计信息
 */
router.get('/stats', async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const stats = await knowledgeService.getStats();
  res.json({ success: true, data: stats });
});

/**
 * GET /api/v1/knowledge/:id
 * 获取知识条目详情
 */
router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const entry = await knowledgeService.get(id);
  res.json({ success: true, data: sanitizeForAPI(entry) });
});

/* ═══ CRUD ═══════════════════════════════════════════════ */

/**
 * POST /api/v1/knowledge
 * 创建知识条目（wire format 直通）
 */
router.post(
  '/',
  requirePermission('knowledge', 'create'),
  validate(CreateKnowledgeBody),
  async (req: Request, res: Response) => {
    const data = req.body;

    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const entry = await knowledgeService.create(data, context);
    res.status(201).json({
      success: true,
      data: sanitizeForAPI(entry),
    });
  }
);

/**
 * PATCH /api/v1/knowledge/:id
 * 更新知识条目（白名单字段）
 */
router.patch(
  '/:id',
  requirePermission('knowledge', 'update'),
  validate(UpdateKnowledgeBody),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const entry = await knowledgeService.update(id, req.body, context);
    res.json({ success: true, data: sanitizeForAPI(entry) });
  }
);

/**
 * DELETE /api/v1/knowledge/:id
 * 删除知识条目
 */
router.delete(
  '/:id',
  requirePermission('knowledge', 'delete'),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const result = await knowledgeService.delete(id, context);
    res.json({ success: true, data: result });
  }
);

/* ═══ 生命周期操作（3 状态: pending / active / deprecated）═══ */

/**
 * PATCH /api/v1/knowledge/:id/publish
 * 发布 (pending → active) — 仅开发者
 */
router.patch(
  '/:id/publish',
  requirePermission('knowledge', 'publish'),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const entry = await knowledgeService.publish(id, context);
    res.json({ success: true, data: sanitizeForAPI(entry) });
  }
);

/**
 * PATCH /api/v1/knowledge/:id/deprecate
 * 废弃 (pending|active → deprecated)
 */
router.patch(
  '/:id/deprecate',
  requirePermission('knowledge', 'deprecate'),
  validate(DeprecateKnowledgeBody),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { reason } = req.body;

    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const entry = await knowledgeService.deprecate(id, reason, context);
    res.json({ success: true, data: sanitizeForAPI(entry) });
  }
);

/**
 * PATCH /api/v1/knowledge/:id/reactivate
 * 重新激活 (deprecated → pending)
 */
router.patch(
  '/:id/reactivate',
  requirePermission('knowledge', 'update'),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const entry = await knowledgeService.reactivate(id, context);
    res.json({ success: true, data: sanitizeForAPI(entry) });
  }
);

/* ═══ 批量操作 ═══════════════════════════════════════════ */

/**
 * POST /api/v1/knowledge/batch-publish
 * 批量发布 (pending → active)
 * 支持 autoApprovableOnly=true 参数，只发布 autoApprovable 的条目
 */
router.post(
  '/batch-publish',
  requirePermission('knowledge', 'publish'),
  validate(BatchPublishBody),
  async (req: Request, res: Response) => {
    const { ids } = req.body;

    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const results = await Promise.allSettled(
      ids.map((id: string) => ioLimit(() => knowledgeService.publish(id, context)))
    );

    const published = results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => sanitizeForAPI(r.value));
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? { id: ids[i], error: r.reason?.message } : null))
      .filter(Boolean);

    res.json({
      success: true,
      data: {
        published,
        failed,
        total: ids.length,
        successCount: published.length,
        failureCount: failed.length,
      },
    });
  }
);

/* ═══ 使用 / 质量 ═══════════════════════════════════════ */

/**
 * POST /api/v1/knowledge/:id/usage
 * 记录使用（adoption / application / guard_hit / view / success）
 */
router.post('/:id/usage', validate(KnowledgeUsageBody), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { type, feedback } = req.body;
  const context = getContext(req);

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');

  await knowledgeService.incrementUsage(id, type, { actor: context.userId, feedback });
  res.json({ success: true, message: `${type} recorded` });
});

/**
 * PATCH /api/v1/knowledge/:id/quality
 * 重新计算质量评分
 */
router.patch('/:id/quality', async (req: Request, res: Response) => {
  const { id } = req.params;
  const context = getContext(req);

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');

  const result = await knowledgeService.updateQuality(id, context);
  res.json({ success: true, data: result });
});

export default router;

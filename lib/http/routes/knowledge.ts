/**
 * Knowledge API 路由 (V3)
 * 统一知识条目的 CRUD + 生命周期操作
 * 替代 recipes.js + candidates.js （旧路由继续保留用于向后兼容）
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { ioLimit } from '#shared/concurrency.js';
import {
  BatchDeleteBody,
  BatchDeprecateBody,
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
        const result = (
          permissionManager as unknown as {
            check: (r: string, a: string, res: string) => { allowed: boolean; reason?: string };
          }
        ).check(role, action, resource);
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
    const result = await knowledgeService.search(String(keyword), { page, pageSize });
    return void res.json({
      success: true,
      data: sanitizePaginatedForAPI(
        result as unknown as Parameters<typeof sanitizePaginatedForAPI>[0]
      ),
    });
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
  res.json({
    success: true,
    data: sanitizePaginatedForAPI(
      result as unknown as Parameters<typeof sanitizePaginatedForAPI>[0]
    ),
  });
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
 * GET /api/v1/knowledge/lifecycle
 * 获取六态生命周期统计 + 各状态条目列表
 */
router.get('/lifecycle', async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const stats = await knowledgeService.getStats();

  const states = ['pending', 'staging', 'active', 'evolving', 'decaying', 'deprecated'] as const;
  const lifecycle: Record<string, unknown> = {
    counts: {} as Record<string, number>,
    entries: {} as Record<string, unknown[]>,
  };

  const counts = lifecycle.counts as Record<string, number>;
  for (const state of states) {
    counts[state] = (stats as Record<string, number>)?.[state] ?? 0;
  }

  // 仅对过渡态（staging / evolving / decaying）返回条目详情
  const transitionalStates = ['staging', 'evolving', 'decaying'] as const;
  const entries = lifecycle.entries as Record<string, unknown[]>;
  for (const state of transitionalStates) {
    if (counts[state] > 0) {
      const result = await knowledgeService.list({ lifecycle: state }, { page: 1, pageSize: 20 });
      entries[state] = (result as { items?: unknown[] }).items ?? [];
    } else {
      entries[state] = [];
    }
  }

  res.json({ success: true, data: lifecycle });
});

/**
 * POST /api/v1/knowledge/quality/refresh-all
 * 批量重新计算所有条目的质量评分
 */
router.post('/quality/refresh-all', async (_req: Request, res: Response) => {
  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const result = await knowledgeService.list({}, { page: 1, pageSize: 10000 });
  const all = result.data;
  let updated = 0;
  let failed = 0;
  for (const entry of all) {
    try {
      await knowledgeService.updateQuality(entry.id);
      updated++;
    } catch {
      failed++;
    }
  }
  res.json({ success: true, data: { updated, failed, total: all.length } });
});

/**
 * GET /api/v1/knowledge/:id
 * 获取知识条目详情
 */
router.get('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
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
    const id = String(req.params.id);
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
    const id = String(req.params.id);
    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const result = await knowledgeService.delete(id, context);
    res.json({ success: true, data: result });
  }
);

/* ═══ 生命周期操作（6 态: pending / staging / active / evolving / decaying / deprecated）═══ */

/**
 * PATCH /api/v1/knowledge/:id/publish
 * 发布 (pending → active) — 仅开发者
 */
router.patch(
  '/:id/publish',
  requirePermission('knowledge', 'publish'),
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
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
    const id = String(req.params.id);
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
    const id = String(req.params.id);
    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const entry = await knowledgeService.reactivate(id, context);
    res.json({ success: true, data: sanitizeForAPI(entry) });
  }
);

/**
 * PATCH /api/v1/knowledge/:id/stage
 * 暂存 (pending → staging)
 */
router.patch(
  '/:id/stage',
  requirePermission('knowledge', 'update'),
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const entry = await knowledgeService.stage(id, context);
    res.json({ success: true, data: sanitizeForAPI(entry) });
  }
);

/**
 * PATCH /api/v1/knowledge/:id/evolve
 * 进化 (active → evolving)
 */
router.patch(
  '/:id/evolve',
  requirePermission('knowledge', 'update'),
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const entry = await knowledgeService.evolve(id, context);
    res.json({ success: true, data: sanitizeForAPI(entry) });
  }
);

/**
 * PATCH /api/v1/knowledge/:id/decay
 * 衰退 (active|evolving → decaying)
 */
router.patch(
  '/:id/decay',
  requirePermission('knowledge', 'update'),
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const entry = await knowledgeService.decay(id, context);
    res.json({ success: true, data: sanitizeForAPI(entry) });
  }
);

/**
 * PATCH /api/v1/knowledge/:id/restore
 * 恢复为已发布 (decaying|evolving → active)
 */
router.patch(
  '/:id/restore',
  requirePermission('knowledge', 'update'),
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const entry = await knowledgeService.restore(id, context);
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

/**
 * POST /api/v1/knowledge/batch-delete
 * 批量删除知识条目
 */
router.post(
  '/batch-delete',
  requirePermission('knowledge', 'delete'),
  validate(BatchDeleteBody),
  async (req: Request, res: Response) => {
    const { ids } = req.body;

    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const results = await Promise.allSettled(
      ids.map((id: string) => ioLimit(() => knowledgeService.delete(id, context)))
    );

    const deleted = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? { id: ids[i], error: r.reason?.message } : null))
      .filter(Boolean);

    res.json({
      success: true,
      data: {
        total: ids.length,
        deletedCount: deleted,
        failureCount: failed.length,
        failed,
      },
    });
  }
);

/**
 * POST /api/v1/knowledge/batch-deprecate
 * 批量废弃知识条目 (active → deprecated)
 */
router.post(
  '/batch-deprecate',
  requirePermission('knowledge', 'publish'),
  validate(BatchDeprecateBody),
  async (req: Request, res: Response) => {
    const { ids, reason } = req.body;

    const container = getServiceContainer();
    const knowledgeService = container.get('knowledgeService');
    const context = getContext(req);

    const results = await Promise.allSettled(
      ids.map((id: string) =>
        ioLimit(() => knowledgeService.deprecate(id, reason || 'batch deprecate', context))
      )
    );

    const deprecated = results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => sanitizeForAPI(r.value));
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? { id: ids[i], error: r.reason?.message } : null))
      .filter(Boolean);

    res.json({
      success: true,
      data: {
        deprecated,
        failed,
        total: ids.length,
        successCount: deprecated.length,
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
  const id = String(req.params.id);
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
  const id = String(req.params.id);
  const context = getContext(req);

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');

  const result = await knowledgeService.updateQuality(id, context);
  res.json({ success: true, data: result });
});

export default router;

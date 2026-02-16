/**
 * Knowledge API 路由 (V3)
 * 统一知识条目的 CRUD + 生命周期操作
 * 替代 recipes.js + candidates.js （旧路由继续保留用于向后兼容）
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { ValidationError } from '../../shared/errors/index.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { getContext, safeInt } from '../utils/routeHelpers.js';

const logger = Logger.getInstance();
const router = express.Router();

const MAX_BATCH_SIZE = 100;

/* ═══ 查询 ═══════════════════════════════════════════════ */

/**
 * GET /api/v1/knowledge
 * 获取知识条目列表（支持筛选和分页）
 */
router.get('/', asyncHandler(async (req, res) => {
  const { lifecycle, kind, category, language, knowledgeType, scope, keyword, tag, source } = req.query;
  const page = safeInt(req.query.page, 1);
  const pageSize = safeInt(req.query.limit, 20, 1, 1000);

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');

  if (keyword) {
    const result = await knowledgeService.search(keyword, { page, pageSize });
    return res.json({ success: true, data: result });
  }

  const filters = {};
  if (lifecycle)     filters.lifecycle = lifecycle;
  if (kind)          filters.kind = kind;
  if (category)      filters.category = category;
  if (language)      filters.language = language;
  if (knowledgeType) filters.knowledgeType = knowledgeType;
  if (scope)         filters.scope = scope;
  if (tag)           filters.tag = tag;
  if (source)        filters.source = source;

  const result = await knowledgeService.list(filters, { page, pageSize });
  res.json({ success: true, data: result });
}));

/**
 * GET /api/v1/knowledge/stats
 * 获取统计信息
 */
router.get('/stats', asyncHandler(async (req, res) => {
  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const stats = await knowledgeService.getStats();
  res.json({ success: true, data: stats });
}));

/**
 * GET /api/v1/knowledge/:id
 * 获取知识条目详情
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const entry = await knowledgeService.get(id);
  res.json({ success: true, data: entry.toJSON() });
}));

/* ═══ CRUD ═══════════════════════════════════════════════ */

/**
 * POST /api/v1/knowledge
 * 创建知识条目（wire format 直通）
 */
router.post('/', asyncHandler(async (req, res) => {
  const data = req.body;

  if (!data.title || !data.content) {
    throw new ValidationError('title and content are required');
  }

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const context = getContext(req);

  const entry = await knowledgeService.create(data, context);
  res.status(201).json({
    success: true,
    data: entry.toJSON(),
  });
}));

/**
 * PATCH /api/v1/knowledge/:id
 * 更新知识条目（白名单字段）
 */
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const context = getContext(req);

  const entry = await knowledgeService.update(id, req.body, context);
  res.json({ success: true, data: entry.toJSON() });
}));

/**
 * DELETE /api/v1/knowledge/:id
 * 删除知识条目
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const context = getContext(req);

  const result = await knowledgeService.delete(id, context);
  res.json({ success: true, data: result });
}));

/* ═══ 生命周期操作（3 状态: pending / active / deprecated）═══ */

/**
 * PATCH /api/v1/knowledge/:id/publish
 * 发布 (pending → active) — 仅开发者
 */
router.patch('/:id/publish', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const context = getContext(req);

  const entry = await knowledgeService.publish(id, context);
  res.json({ success: true, data: entry.toJSON() });
}));

/**
 * PATCH /api/v1/knowledge/:id/deprecate
 * 废弃 (pending|active → deprecated)
 */
router.patch('/:id/deprecate', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason) {
    throw new ValidationError('reason is required for deprecation');
  }

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const context = getContext(req);

  const entry = await knowledgeService.deprecate(id, reason, context);
  res.json({ success: true, data: entry.toJSON() });
}));

/**
 * PATCH /api/v1/knowledge/:id/reactivate
 * 重新激活 (deprecated → pending)
 */
router.patch('/:id/reactivate', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const context = getContext(req);

  const entry = await knowledgeService.reactivate(id, context);
  res.json({ success: true, data: entry.toJSON() });
}));

/* ═══ 批量操作 ═══════════════════════════════════════════ */

/**
 * POST /api/v1/knowledge/batch-publish
 * 批量发布 (pending → active)
 * 支持 autoApprovableOnly=true 参数，只发布 auto_approvable 的条目
 */
router.post('/batch-publish', asyncHandler(async (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ValidationError('ids array is required and must not be empty');
  }
  if (ids.length > MAX_BATCH_SIZE) {
    throw new ValidationError(`Batch size exceeds limit of ${MAX_BATCH_SIZE}`);
  }

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');
  const context = getContext(req);

  const results = await Promise.allSettled(
    ids.map(id => knowledgeService.publish(id, context)),
  );

  const published = results.filter(r => r.status === 'fulfilled').map(r => r.value.toJSON());
  const failed = results
    .map((r, i) => r.status === 'rejected' ? { id: ids[i], error: r.reason?.message } : null)
    .filter(Boolean);

  res.json({
    success: true,
    data: { published, failed, total: ids.length, successCount: published.length, failureCount: failed.length },
  });
}));

/* ═══ 使用 / 质量 ═══════════════════════════════════════ */

/**
 * POST /api/v1/knowledge/:id/usage
 * 记录使用（adoption / application / guard_hit / view / success）
 */
router.post('/:id/usage', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { type = 'adoption', feedback } = req.body;
  const context = getContext(req);

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');

  await knowledgeService.incrementUsage(id, type, { actor: context.userId, feedback });
  res.json({ success: true, message: `${type} recorded` });
}));

/**
 * PATCH /api/v1/knowledge/:id/quality
 * 重新计算质量评分
 */
router.patch('/:id/quality', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const context = getContext(req);

  const container = getServiceContainer();
  const knowledgeService = container.get('knowledgeService');

  const result = await knowledgeService.updateQuality(id, context);
  res.json({ success: true, data: result });
}));

export default router;

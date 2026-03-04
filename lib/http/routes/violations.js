/**
 * Violations API 路由
 * Guard 违规记录管理、AI 规则生成
 */

import express from 'express';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { ValidationError } from '../../shared/errors/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();
const _logger = Logger.getInstance();

/**
 * GET /api/v1/violations
 * 获取 Guard 违规记录列表
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const violationsStore = container.get('violationsStore');

    const { severity, ruleId, file } = req.query;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const filters = {};
    if (severity) {
      filters.severity = severity;
    }
    if (ruleId) {
      filters.ruleId = ruleId;
    }
    if (file) {
      filters.file = file;
    }

    const result = await violationsStore.list(filters, { page, limit });

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * GET /api/v1/violations/stats
 * 获取违规统计摘要
 */
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const violationsStore = container.get('violationsStore');

    const stats = await violationsStore.getStats();

    res.json({
      success: true,
      data: stats,
    });
  })
);

/**
 * POST /api/v1/violations/clear
 * 清除违规记录
 */
router.post(
  '/clear',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const violationsStore = container.get('violationsStore');

    const { ruleId, file, all } = req.body;

    let cleared = 0;
    if (all) {
      cleared = await violationsStore.clearAll();
    } else {
      cleared = await violationsStore.clear({ ruleId, file });
    }

    res.json({
      success: true,
      data: { cleared },
    });
  })
);

export default router;

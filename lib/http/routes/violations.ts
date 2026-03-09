/**
 * Violations API 路由
 * Guard 违规记录管理、AI 规则生成
 */

import express, { type Request, type Response } from 'express';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';

const router = express.Router();
const _logger = Logger.getInstance();

/**
 * GET /api/v1/violations
 * 获取 Guard 违规记录列表
 */
router.get('/', async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const violationsStore = container.get('violationsStore');

  const { severity, ruleId, file } = req.query;
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);

  const filters: Record<string, string> = {};
  if (severity) {
    filters.severity = String(severity);
  }
  if (ruleId) {
    filters.ruleId = String(ruleId);
  }
  if (file) {
    filters.file = String(file);
  }

  const result = await violationsStore.list(filters, { page, limit });

  res.json({
    success: true,
    data: result,
  });
});

/**
 * GET /api/v1/violations/stats
 * 获取违规统计摘要
 */
router.get('/stats', async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const violationsStore = container.get('violationsStore');

  const stats = await violationsStore.getStats();

  res.json({
    success: true,
    data: stats,
  });
});

/**
 * POST /api/v1/violations/clear
 * 清除违规记录
 */
router.post('/clear', async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const violationsStore = container.get('violationsStore');

  const { ruleId, file, all } = req.body;

  let cleared = 0;
  if (all) {
    cleared = (await violationsStore.clearAll()) as unknown as number;
  } else {
    cleared = (await violationsStore.clear({ ruleId, file })) as unknown as number;
  }

  res.json({
    success: true,
    data: { cleared },
  });
});

export default router;

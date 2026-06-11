/**
 * Violations API 路由
 * Guard 违规记录管理、AI 规则生成
 */

import Logger from '@alembic/core/logging';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validate, validateQuery } from '../middleware/validate.js';

const router = express.Router();
const _logger = Logger.getInstance();

const blankToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);
const optionalNonEmptyString = z.preprocess(blankToUndefined, z.string().trim().min(1).optional());

const ViolationsQuery = z.object({
  file: optionalNonEmptyString,
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(50)),
  page: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(1)),
  ruleId: optionalNonEmptyString,
  severity: optionalNonEmptyString,
});

const ViolationsClearBody = z
  .object({
    all: z.boolean().optional(),
    file: optionalNonEmptyString,
    ruleId: optionalNonEmptyString,
  })
  .passthrough();

/**
 * GET /api/v1/violations
 * 获取 Guard 违规记录列表
 */
router.get('/', validateQuery(ViolationsQuery), async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const violationsStore = container.get('violationsStore');
  const query = req.query as unknown as z.infer<typeof ViolationsQuery>;

  const { severity, ruleId, file, page } = query;
  const limit = Math.min(query.limit, 200);

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
// AO1 route-input-exempt: stats read uses no body/query/params.
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
router.post('/clear', validate(ViolationsClearBody), async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const violationsStore = container.get('violationsStore');

  const { ruleId, file, all } = req.body as z.infer<typeof ViolationsClearBody>;

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

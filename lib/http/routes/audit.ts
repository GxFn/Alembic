/**
 * Audit Log API 路由
 *
 * 端点:
 *   GET /api/v1/audit — 查询审计日志
 */

import express, { type Request, type Response } from 'express';
import { z } from 'zod';

import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validateQuery } from '../middleware/validate.js';

const router = express.Router();

const blankToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

const AuditQuery = z.object({
  action: z.preprocess(blankToUndefined, z.string().trim().min(1).optional()),
  actor: z.preprocess(blankToUndefined, z.string().trim().min(1).optional()),
  endDate: z.preprocess(blankToUndefined, z.coerce.number().int().nonnegative().optional()),
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(100)),
  result: z.preprocess(blankToUndefined, z.enum(['success', 'failure']).optional()),
  startDate: z.preprocess(blankToUndefined, z.coerce.number().int().nonnegative().optional()),
});

/**
 * GET /api/v1/audit
 * 查询审计日志，支持按 actor/action/result/时间范围过滤
 *
 * Query params:
 *   actor     — 操作人过滤
 *   action    — 操作类型过滤
 *   result    — 结果过滤 (success|failure)
 *   startDate — 起始时间戳 (毫秒)
 *   endDate   — 结束时间戳 (毫秒)
 *   limit     — 返回条数上限 (默认 100, 最大 500)
 */
router.get('/', validateQuery(AuditQuery), async (req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const auditStore = container.get('auditStore');

    if (!auditStore) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'AuditStore not available' },
      });
      return;
    }

    const query = req.query as unknown as z.infer<typeof AuditQuery>;

    const logs = auditStore.query({
      actor: query.actor,
      action: query.action,
      result: query.result,
      startDate: query.startDate,
      endDate: query.endDate,
      limit: Math.min(query.limit, 500),
    });

    res.json({ success: true, data: { logs, total: logs.length } });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'AUDIT_ERROR', message: (err as Error).message },
    });
  }
});

export default router;

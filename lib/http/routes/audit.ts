/**
 * Audit Log API 路由
 *
 * 端点:
 *   GET /api/v1/audit — 查询审计日志
 */

import express, { type Request, type Response } from 'express';

import { getServiceContainer } from '../../injection/ServiceContainer.js';

const router = express.Router();

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
router.get('/', async (req: Request, res: Response): Promise<void> => {
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

    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const logs = auditStore.query({
      actor: req.query.actor as string | undefined,
      action: req.query.action as string | undefined,
      result: req.query.result as string | undefined,
      startDate: req.query.startDate ? Number(req.query.startDate) : undefined,
      endDate: req.query.endDate ? Number(req.query.endDate) : undefined,
      limit,
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

/**
 * Signal & Report API 路由
 *
 * 端点:
 *   GET /api/v1/signals/trace   — 查询信号留痕
 *   GET /api/v1/signals/stats   — 信号统计
 *   GET /api/v1/signals/reports — 查询管道报告
 */

import type { SignalTraceWriter } from '@alembic/core/events';
import type { ReportStore } from '@alembic/core/infrastructure/report';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validateQuery } from '../middleware/validate.js';

const router = express.Router();

const blankToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);
const optionalNonEmptyString = z.preprocess(blankToUndefined, z.string().trim().min(1).optional());
const optionalTimestamp = z.preprocess(
  blankToUndefined,
  z.coerce.number().int().nonnegative().optional()
);
const optionalLimit = z.preprocess(blankToUndefined, z.coerce.number().int().positive().optional());
const optionalOffset = z.preprocess(
  blankToUndefined,
  z.coerce.number().int().nonnegative().optional()
);

const SignalTraceQuery = z.object({
  from: optionalTimestamp,
  limit: optionalLimit,
  offset: optionalOffset,
  source: optionalNonEmptyString,
  target: optionalNonEmptyString,
  to: optionalTimestamp,
  type: optionalNonEmptyString,
});

const SignalStatsQuery = z.object({
  from: optionalTimestamp,
  to: optionalTimestamp,
});

const SignalReportsQuery = z.object({
  category: optionalNonEmptyString,
  from: optionalTimestamp,
  limit: optionalLimit,
  offset: optionalOffset,
  to: optionalTimestamp,
  type: optionalNonEmptyString,
});

/**
 * GET /api/v1/signals/trace
 * 查询信号留痕（支持 type / source / target / from / to / limit / offset）
 */
router.get(
  '/trace',
  validateQuery(SignalTraceQuery),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const container = getServiceContainer();
      const traceWriter = container.get('signalTraceWriter') as SignalTraceWriter | null;
      const query = req.query as z.infer<typeof SignalTraceQuery>;

      if (!traceWriter) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'SignalTraceWriter not available' },
        });
        return;
      }

      const type = query.type?.split(',').filter(Boolean);

      const result = await traceWriter.query({
        type,
        source: query.source,
        target: query.target,
        from: query.from,
        to: query.to,
        limit: capLimit(query.limit, 200),
        offset: query.offset,
      });
      res.json({ success: true, data: result });
    } catch (err: unknown) {
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
);

/**
 * GET /api/v1/signals/stats
 * 信号统计（可选 from / to 时间范围）
 */
router.get(
  '/stats',
  validateQuery(SignalStatsQuery),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const container = getServiceContainer();
      const traceWriter = container.get('signalTraceWriter') as SignalTraceWriter | null;
      const query = req.query as z.infer<typeof SignalStatsQuery>;

      if (!traceWriter) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'SignalTraceWriter not available' },
        });
        return;
      }

      const stats = await traceWriter.stats({ from: query.from, to: query.to });
      res.json({ success: true, data: stats });
    } catch (err: unknown) {
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
);

/**
 * GET /api/v1/signals/reports
 * 查询管道报告（支持 category / type / from / to / limit / offset）
 */
router.get(
  '/reports',
  validateQuery(SignalReportsQuery),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const container = getServiceContainer();
      const reportStore = container.get('reportStore') as ReportStore | null;
      const query = req.query as z.infer<typeof SignalReportsQuery>;

      if (!reportStore) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'ReportStore not available' },
        });
        return;
      }

      const category = query.category?.split(',').filter(Boolean) as never;

      const result = await reportStore.query({
        category,
        type: query.type,
        from: query.from,
        to: query.to,
        limit: capLimit(query.limit, 200),
        offset: query.offset,
      });
      res.json({ success: true, data: result });
    } catch (err: unknown) {
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
);

export default router;

function capLimit(value: number | undefined, max: number): number | undefined {
  return value === undefined ? undefined : Math.min(value, max);
}

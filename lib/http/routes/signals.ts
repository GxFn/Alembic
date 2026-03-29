/**
 * Signal & Report API 路由
 *
 * 端点:
 *   GET /api/v1/signals/trace   — 查询信号留痕
 *   GET /api/v1/signals/stats   — 信号统计
 *   GET /api/v1/signals/reports — 查询管道报告
 */

import express, { type Request, type Response } from 'express';
import type { ReportStore } from '../../infrastructure/report/ReportStore.js';
import type { SignalTraceWriter } from '../../infrastructure/signal/SignalTraceWriter.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';

const router = express.Router();

/**
 * GET /api/v1/signals/trace
 * 查询信号留痕（支持 type / source / target / from / to / limit / offset）
 */
router.get('/trace', async (req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const traceWriter = container.get('signalTraceWriter') as SignalTraceWriter | null;

    if (!traceWriter) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'SignalTraceWriter not available' },
      });
      return;
    }

    const typeParam = req.query.type;
    const type = typeof typeParam === 'string' ? typeParam.split(',').filter(Boolean) : undefined;
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;
    const target = typeof req.query.target === 'string' ? req.query.target : undefined;
    const from = req.query.from ? Number(req.query.from) : undefined;
    const to = req.query.to ? Number(req.query.to) : undefined;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;

    const result = await traceWriter.query({ type, source, target, from, to, limit, offset });
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
});

/**
 * GET /api/v1/signals/stats
 * 信号统计（可选 from / to 时间范围）
 */
router.get('/stats', async (req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const traceWriter = container.get('signalTraceWriter') as SignalTraceWriter | null;

    if (!traceWriter) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'SignalTraceWriter not available' },
      });
      return;
    }

    const from = req.query.from ? Number(req.query.from) : undefined;
    const to = req.query.to ? Number(req.query.to) : undefined;

    const stats = await traceWriter.stats({ from, to });
    res.json({ success: true, data: stats });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
});

/**
 * GET /api/v1/signals/reports
 * 查询管道报告（支持 category / type / from / to / limit / offset）
 */
router.get('/reports', async (req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const reportStore = container.get('reportStore') as ReportStore | null;

    if (!reportStore) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'ReportStore not available' },
      });
      return;
    }

    const catParam = req.query.category;
    const category =
      typeof catParam === 'string' ? (catParam.split(',').filter(Boolean) as never) : undefined;
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const from = req.query.from ? Number(req.query.from) : undefined;
    const to = req.query.to ? Number(req.query.to) : undefined;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;

    const result = await reportStore.query({ category, type, from, to, limit, offset });
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
});

export default router;

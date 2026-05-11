/**
 * evolution.ts — 进化相关路由
 *
 * GET  /api/v1/evolution/proposals          Proposal 列表
 * GET  /api/v1/evolution/proposals/stats    Proposal 统计
 * POST /api/v1/evolution/proposals/:id/execute  执行 Proposal
 * POST /api/v1/evolution/proposals/:id/observe  开始观察 Proposal
 * POST /api/v1/evolution/proposals/:id/reject   拒绝 Proposal
 * GET  /api/v1/evolution/warnings           Warning 列表
 * GET  /api/v1/evolution/warnings/stats     Warning 统计
 * POST /api/v1/evolution/warnings/:id/resolve   解决 Warning
 * POST /api/v1/evolution/warnings/:id/dismiss   忽略 Warning
 *
 * @module http/routes/evolution
 */

import express, { type Request, type Response } from 'express';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import type { ProposalRepository } from '../../repository/evolution/ProposalRepository.js';
import type { WarningRepository } from '../../repository/evolution/WarningRepository.js';
import type { ProposalExecutor } from '../../service/evolution/ProposalExecutor.js';

const router = express.Router();
const logger = Logger.getInstance();

/* ════════════════════════════════════════════════════════
 *  Proposals — CRUD + 操作
 * ════════════════════════════════════════════════════════ */

/** GET /proposals — 查询 Proposals */
router.get('/proposals', (req: Request, res: Response) => {
  try {
    const container = getServiceContainer();
    const repo = container.get('proposalRepository') as ProposalRepository;

    const filter: Record<string, unknown> = {};
    if (req.query.status) {
      filter.status = req.query.status;
    }
    if (req.query.type) {
      filter.type = req.query.type;
    }
    if (req.query.targetRecipeId) {
      filter.targetRecipeId = req.query.targetRecipeId;
    }
    if (req.query.source) {
      filter.source = req.query.source;
    }

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const proposals = repo
      .find(filter as Parameters<ProposalRepository['find']>[0])
      .slice(0, limit);

    res.json({ success: true, data: proposals });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'PROPOSAL_ERROR', message: (err as Error).message },
    });
  }
});

/** GET /proposals/stats — Proposal 统计 */
router.get('/proposals/stats', (req: Request, res: Response) => {
  try {
    const container = getServiceContainer();
    const repo = container.get('proposalRepository') as ProposalRepository;

    const pending = repo.find({ status: 'pending' }).length;
    const observing = repo.find({ status: 'observing' }).length;

    res.json({
      success: true,
      data: { pending, observing, total: pending + observing },
    });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'PROPOSAL_ERROR', message: (err as Error).message },
    });
  }
});

/** POST /proposals/:id/execute — 手动执行 Proposal */
router.post('/proposals/:id/execute', async (req: Request, res: Response) => {
  try {
    const container = getServiceContainer();
    const repo = container.get('proposalRepository') as ProposalRepository;
    const executor = container.get('proposalExecutor') as ProposalExecutor;

    const id = String(req.params.id);
    const proposal = repo.findById(id);
    if (!proposal) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Proposal not found' },
      });
      return;
    }

    // 仅执行指定的单个 Proposal
    const result = await executor.executeOne(id);

    res.json({ success: true, data: result });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'PROPOSAL_ERROR', message: (err as Error).message },
    });
  }
});

/** POST /proposals/:id/observe — 开始观察 Proposal（pending → observing） */
router.post('/proposals/:id/observe', (req: Request, res: Response) => {
  try {
    const container = getServiceContainer();
    const repo = container.get('proposalRepository') as ProposalRepository;

    const id = String(req.params.id);
    const ok = repo.startObserving(id);

    if (!ok) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Proposal not found or not in pending status' },
      });
      return;
    }

    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'PROPOSAL_ERROR', message: (err as Error).message },
    });
  }
});

/** POST /proposals/:id/reject — 拒绝 Proposal */
router.post('/proposals/:id/reject', (req: Request, res: Response) => {
  try {
    const container = getServiceContainer();
    const repo = container.get('proposalRepository') as ProposalRepository;

    const id = String(req.params.id);
    const { reason } = req.body as { reason?: string };
    const ok = repo.markRejected(id, reason || 'user rejected', 'user');

    if (!ok) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Proposal not found or already resolved' },
      });
      return;
    }

    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'PROPOSAL_ERROR', message: (err as Error).message },
    });
  }
});

/* ════════════════════════════════════════════════════════
 *  Warnings — CRUD + 操作
 * ════════════════════════════════════════════════════════ */

/** GET /warnings — 查询 Warnings */
router.get('/warnings', (req: Request, res: Response) => {
  try {
    const container = getServiceContainer();
    const repo = container.get('warningRepository') as WarningRepository;

    const filter: Record<string, unknown> = {};
    if (req.query.status) {
      filter.status = req.query.status;
    }
    if (req.query.type) {
      filter.type = req.query.type;
    }
    if (req.query.targetRecipeId) {
      filter.targetRecipeId = req.query.targetRecipeId;
    }

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const warnings = repo.find(filter as Parameters<WarningRepository['find']>[0], limit);

    res.json({ success: true, data: warnings });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'WARNING_ERROR', message: (err as Error).message },
    });
  }
});

/** GET /warnings/stats — Warning 统计 */
router.get('/warnings/stats', (req: Request, res: Response) => {
  try {
    const container = getServiceContainer();
    const repo = container.get('warningRepository') as WarningRepository;

    const stats = repo.countOpen();

    res.json({ success: true, data: stats });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'WARNING_ERROR', message: (err as Error).message },
    });
  }
});

/** POST /warnings/:id/resolve — 解决 Warning */
router.post('/warnings/:id/resolve', (req: Request, res: Response) => {
  try {
    const container = getServiceContainer();
    const repo = container.get('warningRepository') as WarningRepository;

    const id = String(req.params.id);
    const { resolution } = req.body as { resolution?: string };
    const ok = repo.resolve(id, resolution || 'resolved by user', 'user');

    if (!ok) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Warning not found or already resolved' },
      });
      return;
    }

    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'WARNING_ERROR', message: (err as Error).message },
    });
  }
});

/** POST /warnings/:id/dismiss — 忽略 Warning */
router.post('/warnings/:id/dismiss', (req: Request, res: Response) => {
  try {
    const container = getServiceContainer();
    const repo = container.get('warningRepository') as WarningRepository;

    const id = String(req.params.id);
    const { reason } = req.body as { reason?: string };
    const ok = repo.dismiss(id, reason || 'dismissed by user', 'user');

    if (!ok) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Warning not found or already resolved' },
      });
      return;
    }

    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'WARNING_ERROR', message: (err as Error).message },
    });
  }
});

export default router;

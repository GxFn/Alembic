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

import type { ProposalExecutor } from '@alembic/core/evolution';
import type { ProposalRepository, WarningRepository } from '@alembic/core/repositories';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validate, validateParams, validateQuery } from '../middleware/validate.js';

const router = express.Router();

const blankToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);
const optionalNonEmptyString = z.preprocess(blankToUndefined, z.string().trim().min(1).optional());

const EvolutionListQuery = z.object({
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(100)),
  source: optionalNonEmptyString,
  status: optionalNonEmptyString,
  targetRecipeId: optionalNonEmptyString,
  type: optionalNonEmptyString,
});

const EvolutionIdParams = z.object({
  id: z.string().trim().min(1),
});

const ProposalRejectBody = z
  .object({
    reason: optionalNonEmptyString,
  })
  .passthrough();

const WarningResolveBody = z
  .object({
    resolution: optionalNonEmptyString,
  })
  .passthrough();

const WarningDismissBody = ProposalRejectBody;

/* ════════════════════════════════════════════════════════
 *  Proposals — CRUD + 操作
 * ════════════════════════════════════════════════════════ */

/** GET /proposals — 查询 Proposals */
router.get('/proposals', validateQuery(EvolutionListQuery), (req: Request, res: Response) => {
  try {
    const container = getServiceContainer();
    const repo = container.get('proposalRepository') as ProposalRepository;
    const query = req.query as unknown as z.infer<typeof EvolutionListQuery>;

    const filter: Record<string, unknown> = {};
    if (query.status) {
      filter.status = query.status;
    }
    if (query.type) {
      filter.type = query.type;
    }
    if (query.targetRecipeId) {
      filter.targetRecipeId = query.targetRecipeId;
    }
    if (query.source) {
      filter.source = query.source;
    }

    const proposals = repo
      .find(filter as Parameters<ProposalRepository['find']>[0])
      .slice(0, Math.min(query.limit, 500));

    res.json({ success: true, data: proposals });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'PROPOSAL_ERROR', message: (err as Error).message },
    });
  }
});

/** GET /proposals/stats — Proposal 统计 */
// AO1 route-input-exempt: stats read uses no body/query/params and preserves ignored query strings.
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
router.post(
  '/proposals/:id/execute',
  validateParams(EvolutionIdParams),
  async (req: Request, res: Response) => {
    try {
      const container = getServiceContainer();
      const repo = container.get('proposalRepository') as ProposalRepository;
      const executor = container.get('proposalExecutor') as ProposalExecutor;
      const params = req.params as z.infer<typeof EvolutionIdParams>;

      const id = params.id;
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
  }
);

/** POST /proposals/:id/observe — 开始观察 Proposal（pending → observing） */
router.post(
  '/proposals/:id/observe',
  validateParams(EvolutionIdParams),
  (req: Request, res: Response) => {
    try {
      const container = getServiceContainer();
      const repo = container.get('proposalRepository') as ProposalRepository;
      const params = req.params as z.infer<typeof EvolutionIdParams>;

      const id = params.id;
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
  }
);

/** POST /proposals/:id/reject — 拒绝 Proposal */
router.post(
  '/proposals/:id/reject',
  validateParams(EvolutionIdParams),
  validate(ProposalRejectBody),
  (req: Request, res: Response) => {
    try {
      const container = getServiceContainer();
      const repo = container.get('proposalRepository') as ProposalRepository;
      const params = req.params as z.infer<typeof EvolutionIdParams>;
      const body = req.body as z.infer<typeof ProposalRejectBody>;

      const id = params.id;
      const ok = repo.markRejected(id, body.reason || 'user rejected', 'user');

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
  }
);

/* ════════════════════════════════════════════════════════
 *  Warnings — CRUD + 操作
 * ════════════════════════════════════════════════════════ */

/** GET /warnings — 查询 Warnings */
router.get('/warnings', validateQuery(EvolutionListQuery), (req: Request, res: Response) => {
  try {
    const container = getServiceContainer();
    const repo = container.get('warningRepository') as WarningRepository;
    const query = req.query as unknown as z.infer<typeof EvolutionListQuery>;

    const filter: Record<string, unknown> = {};
    if (query.status) {
      filter.status = query.status;
    }
    if (query.type) {
      filter.type = query.type;
    }
    if (query.targetRecipeId) {
      filter.targetRecipeId = query.targetRecipeId;
    }

    const warnings = repo.find(
      filter as Parameters<WarningRepository['find']>[0],
      Math.min(query.limit, 500)
    );

    res.json({ success: true, data: warnings });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'WARNING_ERROR', message: (err as Error).message },
    });
  }
});

/** GET /warnings/stats — Warning 统计 */
// AO1 route-input-exempt: stats read uses no body/query/params and preserves ignored query strings.
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
router.post(
  '/warnings/:id/resolve',
  validateParams(EvolutionIdParams),
  validate(WarningResolveBody),
  (req: Request, res: Response) => {
    try {
      const container = getServiceContainer();
      const repo = container.get('warningRepository') as WarningRepository;
      const params = req.params as z.infer<typeof EvolutionIdParams>;
      const body = req.body as z.infer<typeof WarningResolveBody>;

      const id = params.id;
      const ok = repo.resolve(id, body.resolution || 'resolved by user', 'user');

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
  }
);

/** POST /warnings/:id/dismiss — 忽略 Warning */
router.post(
  '/warnings/:id/dismiss',
  validateParams(EvolutionIdParams),
  validate(WarningDismissBody),
  (req: Request, res: Response) => {
    try {
      const container = getServiceContainer();
      const repo = container.get('warningRepository') as WarningRepository;
      const params = req.params as z.infer<typeof EvolutionIdParams>;
      const body = req.body as z.infer<typeof WarningDismissBody>;

      const id = params.id;
      const ok = repo.dismiss(id, body.reason || 'dismissed by user', 'user');

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
  }
);

export default router;

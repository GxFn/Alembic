/**
 * Governance API routes.
 *
 * Panorama project-information routes were retired in P5. These endpoints are
 * kept under an explicit /governance family because they use active
 * decay/staging/enhancement services and are not Panorama data surfaces.
 */

import express, { type Request, type Response } from 'express';

import { getServiceContainer } from '../../injection/ServiceContainer.js';

const router = express.Router();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * POST /api/v1/governance/cycle
 * Retired metabolism cycle entrypoint. Keep the explicit 410 so callers get a
 * stable removal signal while active governance reads remain available below.
 */
// AO1 route-input-exempt: removed endpoint ignores body/query/params and always returns 410.
router.post('/cycle', async (_req: Request, res: Response): Promise<void> => {
  res.status(410).json({
    success: false,
    error: {
      code: 'REMOVED',
      message: 'KnowledgeMetabolism has been removed. Use rescan for governance.',
    },
  });
});

/**
 * GET /api/v1/governance/decay
 * Fetch the current decay scan from the active decay detector service.
 */
// AO1 route-input-exempt: governance decay read uses no body/query/params.
router.get('/decay', async (_req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const decayDetector = container.get('decayDetector') as { scanAll(): unknown } | undefined;

    if (!decayDetector) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'DecayDetector not available' },
      });
      return;
    }

    const results = await decayDetector.scanAll();
    res.json({ success: true, data: { results } });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'GOVERNANCE_ERROR', message: errorMessage(err) },
    });
  }
});

/**
 * POST /api/v1/governance/staging-check
 * Check staging entries and promote entries whose governance delay has elapsed.
 */
// AO1 route-input-exempt: staging-check trigger has no request-controlled input.
router.post('/staging-check', async (_req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const stagingManager = container.get('stagingManager') as
      | { checkAndPromote(): unknown; listStaging(): unknown }
      | undefined;

    if (!stagingManager) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'StagingManager not available' },
      });
      return;
    }

    const checkResult = await stagingManager.checkAndPromote();
    const currentStaging = await stagingManager.listStaging();
    res.json({ success: true, data: { checkResult, currentStaging } });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'GOVERNANCE_ERROR', message: errorMessage(err) },
    });
  }
});

/**
 * GET /api/v1/governance/staging
 * List current staging entries.
 */
// AO1 route-input-exempt: staging read uses no body/query/params.
router.get('/staging', async (_req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const stagingManager = container.get('stagingManager') as
      | { listStaging(): unknown }
      | undefined;

    if (!stagingManager) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'StagingManager not available' },
      });
      return;
    }

    const entries = await stagingManager.listStaging();
    res.json({ success: true, data: { entries } });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'GOVERNANCE_ERROR', message: errorMessage(err) },
    });
  }
});

/**
 * GET /api/v1/governance/enhancements
 * Fetch current enhancement suggestions from the active governance service.
 */
// AO1 route-input-exempt: enhancements read uses no body/query/params.
router.get('/enhancements', async (_req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const suggester = container.get('enhancementSuggester') as
      | { analyzeAll(): unknown }
      | undefined;

    if (!suggester) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'EnhancementSuggester not available' },
      });
      return;
    }

    const suggestions = await suggester.analyzeAll();
    res.json({ success: true, data: { suggestions } });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'GOVERNANCE_ERROR', message: errorMessage(err) },
    });
  }
});

export default router;

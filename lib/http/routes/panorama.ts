/**
 * Panorama API 路由
 *
 * 端点:
 *   GET /api/v1/panorama          — 项目全景概览
 *   GET /api/v1/panorama/health   — 全景健康度
 *   GET /api/v1/panorama/gaps     — 知识空白区
 *   GET /api/v1/panorama/module/:name — 单模块详情
 */

import express, { type Request, type Response } from 'express';
import { z } from 'zod';

import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validateParams, validateQuery } from '../middleware/validate.js';

const router = express.Router();

const blankToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

const PanoramaRefreshQuery = z.object({
  refresh: z.preprocess(blankToUndefined, z.enum(['true', 'false']).optional()),
});

const PanoramaModuleParams = z.object({
  name: z.string().trim().min(1),
});

function sendRetiredProjectInfoRoute(res: Response): void {
  res.status(410).json({
    success: false,
    error: {
      code: 'RETIRED_PROJECT_INFO_ROUTE',
      message:
        'Project information is served by ProjectContext-backed module and structure routes.',
    },
  });
}

/**
 * GET /api/v1/panorama
 * 返回项目全景概览（层级、模块、覆盖率）
 */
router.get(
  '/',
  validateQuery(PanoramaRefreshQuery),
  async (_req: Request, res: Response): Promise<void> => {
    sendRetiredProjectInfoRoute(res);
  }
);

/**
 * GET /api/v1/panorama/health
 * 返回全景健康度评分
 */
router.get(
  '/health',
  validateQuery(PanoramaRefreshQuery),
  async (_req: Request, res: Response): Promise<void> => {
    sendRetiredProjectInfoRoute(res);
  }
);

/**
 * GET /api/v1/panorama/gaps
 * 返回知识空白区列表
 */
router.get(
  '/gaps',
  validateQuery(PanoramaRefreshQuery),
  async (_req: Request, res: Response): Promise<void> => {
    sendRetiredProjectInfoRoute(res);
  }
);

/**
 * GET /api/v1/panorama/coverage
 * 返回各模块知识覆盖率热力图数据
 */
router.get(
  '/coverage',
  validateQuery(PanoramaRefreshQuery),
  async (_req: Request, res: Response): Promise<void> => {
    sendRetiredProjectInfoRoute(res);
  }
);

/**
 * GET /api/v1/panorama/module/:name
 * 返回单模块详情
 */
router.get(
  '/module/:name',
  validateParams(PanoramaModuleParams),
  async (_req: Request, res: Response): Promise<void> => {
    sendRetiredProjectInfoRoute(res);
  }
);

/* ═══ 治理 (Governance) ═══════════════════════════════════════ */

/**
 * POST /api/v1/panorama/governance/cycle
 * 执行完整治理周期（矛盾检测 + 冗余分析 + 衰退扫描）
 */
// AO1 route-input-exempt: removed endpoint ignores body/query/params and always returns 410.
router.post('/governance/cycle', async (_req: Request, res: Response): Promise<void> => {
  res.status(410).json({
    success: false,
    error: {
      code: 'REMOVED',
      message: 'KnowledgeMetabolism has been removed. Use rescan for governance.',
    },
  });
});

/**
 * GET /api/v1/panorama/governance/decay
 * 获取衰退评估报告
 */
// AO1 route-input-exempt: governance decay read uses no body/query/params.
router.get('/governance/decay', async (_req: Request, res: Response): Promise<void> => {
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
      error: { code: 'GOVERNANCE_ERROR', message: (err as Error).message },
    });
  }
});

/**
 * POST /api/v1/panorama/governance/staging-check
 * 检查 staging 条目并自动发布到期的
 */
// AO1 route-input-exempt: staging-check trigger has no request-controlled input.
router.post('/governance/staging-check', async (_req: Request, res: Response): Promise<void> => {
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
      error: { code: 'GOVERNANCE_ERROR', message: (err as Error).message },
    });
  }
});

/**
 * GET /api/v1/panorama/governance/staging
 * 获取当前 staging 列表（只读）
 */
// AO1 route-input-exempt: staging read uses no body/query/params.
router.get('/governance/staging', async (_req: Request, res: Response): Promise<void> => {
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
      error: { code: 'GOVERNANCE_ERROR', message: (err as Error).message },
    });
  }
});

/**
 * GET /api/v1/panorama/governance/enhancements
 * 获取增强建议
 */
// AO1 route-input-exempt: enhancements read uses no body/query/params.
router.get('/governance/enhancements', async (_req: Request, res: Response): Promise<void> => {
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
      error: { code: 'GOVERNANCE_ERROR', message: (err as Error).message },
    });
  }
});

export default router;

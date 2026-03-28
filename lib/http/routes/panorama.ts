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

import { getServiceContainer } from '../../injection/ServiceContainer.js';

const router = express.Router();

/**
 * GET /api/v1/panorama
 * 返回项目全景概览（层级、模块、覆盖率）
 */
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const panoramaService = container.get('panoramaService');

    if (!panoramaService) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'PanoramaService not available' },
      });
      return;
    }

    const overview = panoramaService.getOverview();

    res.json({ success: true, data: overview });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'PANORAMA_ERROR', message: (err as Error).message },
    });
  }
});

/**
 * GET /api/v1/panorama/health
 * 返回全景健康度评分
 */
router.get('/health', async (_req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const panoramaService = container.get('panoramaService');

    if (!panoramaService) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'PanoramaService not available' },
      });
      return;
    }

    const health = panoramaService.getHealth();

    res.json({ success: true, data: health });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'PANORAMA_ERROR', message: (err as Error).message },
    });
  }
});

/**
 * GET /api/v1/panorama/gaps
 * 返回知识空白区列表
 */
router.get('/gaps', async (_req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const panoramaService = container.get('panoramaService');

    if (!panoramaService) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'PanoramaService not available' },
      });
      return;
    }

    const gaps = panoramaService.getGaps();

    res.json({ success: true, data: gaps });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'PANORAMA_ERROR', message: (err as Error).message },
    });
  }
});

/**
 * GET /api/v1/panorama/module/:name
 * 返回单模块详情
 */
router.get('/module/:name', async (req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const panoramaService = container.get('panoramaService');

    if (!panoramaService) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'PanoramaService not available' },
      });
      return;
    }

    const detail = panoramaService.getModule(req.params.name as string);

    if (!detail) {
      res.status(404).json({
        success: false,
        error: { code: 'MODULE_NOT_FOUND', message: `Module "${req.params.name}" not found` },
      });
      return;
    }

    res.json({ success: true, data: detail });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'PANORAMA_ERROR', message: (err as Error).message },
    });
  }
});

export default router;

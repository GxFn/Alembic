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
router.get('/', async (req: Request, res: Response): Promise<void> => {
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

    if (req.query.refresh === 'true' && typeof panoramaService.invalidate === 'function') {
      panoramaService.invalidate();
    }

    if (typeof panoramaService.ensureData === 'function') {
      await panoramaService.ensureData();
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
router.get('/health', async (req: Request, res: Response): Promise<void> => {
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

    if (req.query.refresh === 'true' && typeof panoramaService.invalidate === 'function') {
      panoramaService.invalidate();
    }

    if (typeof panoramaService.ensureData === 'function') {
      await panoramaService.ensureData();
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
router.get('/gaps', async (req: Request, res: Response): Promise<void> => {
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

    if (req.query.refresh === 'true' && typeof panoramaService.invalidate === 'function') {
      panoramaService.invalidate();
    }

    if (typeof panoramaService.ensureData === 'function') {
      await panoramaService.ensureData();
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
 * GET /api/v1/panorama/coverage
 * 返回各模块知识覆盖率热力图数据
 */
router.get('/coverage', async (req: Request, res: Response): Promise<void> => {
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

    if (req.query.refresh === 'true' && typeof panoramaService.invalidate === 'function') {
      panoramaService.invalidate();
    }

    if (typeof panoramaService.ensureData === 'function') {
      await panoramaService.ensureData();
    }

    const overview = panoramaService.getOverview();
    const gaps = panoramaService.getGaps?.() ?? [];

    // 构建模块级覆盖率数据：从 overview.layers 中提取每个模块的文件数和 recipe 数
    const modules: {
      name: string;
      layer: string;
      fileCount: number;
      recipeCount: number;
      coverage: number;
    }[] = [];

    for (const layer of overview.layers || []) {
      const layerModules = layer.modules || [];
      for (const mod of layerModules) {
        const fileCount = mod.fileCount || 0;
        const recipeCount = mod.recipeCount || 0;
        const coverage = fileCount > 0 ? Math.round((recipeCount / fileCount) * 100) : 0;
        modules.push({
          name: mod.name || 'unknown',
          layer: layer.name,
          fileCount,
          recipeCount,
          coverage: Math.min(coverage, 100),
        });
      }
    }

    // 按覆盖率升序（低覆盖在前，方便高亮）
    modules.sort((a, b) => a.coverage - b.coverage);

    // 空白区按维度聚合
    const gapsByDimension: Record<string, number> = {};
    for (const gap of gaps) {
      const dim = gap.dimensionName || 'unknown';
      gapsByDimension[dim] = (gapsByDimension[dim] || 0) + 1;
    }

    res.json({
      success: true,
      data: {
        modules,
        gapsByDimension,
        overallCoverage: overview.overallCoverage ?? 0,
        totalFiles: overview.totalFiles ?? 0,
        totalRecipes: overview.totalRecipes ?? 0,
      },
    });
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

    if (typeof panoramaService.ensureData === 'function') {
      await panoramaService.ensureData();
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

/* ═══ 治理 (Governance) ═══════════════════════════════════════ */

/**
 * POST /api/v1/panorama/governance/cycle
 * 执行完整治理周期（矛盾检测 + 冗余分析 + 衰退扫描）
 */
router.post('/governance/cycle', async (_req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const metabolism = container.get('knowledgeMetabolism') as
      | { runFullCycle(): unknown }
      | undefined;

    if (!metabolism) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'KnowledgeMetabolism not available' },
      });
      return;
    }

    const report = metabolism.runFullCycle();
    res.json({ success: true, data: report });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'GOVERNANCE_ERROR', message: (err as Error).message },
    });
  }
});

/**
 * GET /api/v1/panorama/governance/decay
 * 获取衰退评估报告
 */
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

    const results = decayDetector.scanAll();
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

    const checkResult = stagingManager.checkAndPromote();
    const currentStaging = stagingManager.listStaging();
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

    const entries = stagingManager.listStaging();
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

    const suggestions = suggester.analyzeAll();
    res.json({ success: true, data: { suggestions } });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'GOVERNANCE_ERROR', message: (err as Error).message },
    });
  }
});

export default router;

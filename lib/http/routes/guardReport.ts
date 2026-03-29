/**
 * Guard Report API 路由
 *
 * 端点:
 *   GET /api/v1/guard/report           — 项目合规性报告（ComplianceReporter + Uncertainty）
 *   GET /api/v1/guard/report/reverse   — ReverseGuard 反向验证
 *   GET /api/v1/guard/report/coverage  — CoverageAnalyzer 覆盖率矩阵
 */

import express, { type Request, type Response } from 'express';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { resolveProjectRoot } from '../../shared/resolveProjectRoot.js';

const router = express.Router();

/**
 * GET /api/v1/guard/report
 * 生成完整的合规性报告，含 uncertain/coverage/confidence
 *
 * Query params:
 *   minScore   — 最低通过分数 (默认 60)
 *   maxErrors  — 最大错误数 (默认 0)
 *   maxFiles   — 扫描文件上限
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const complianceReporter = container.get('complianceReporter');

    if (!complianceReporter) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'ComplianceReporter not available' },
      });
      return;
    }

    const projectRoot = resolveProjectRoot(container);

    const qualityGate = {
      minScore: req.query.minScore ? Number(req.query.minScore) : undefined,
      maxErrors: req.query.maxErrors ? Number(req.query.maxErrors) : undefined,
    };
    const maxFiles = req.query.maxFiles ? Number(req.query.maxFiles) : undefined;

    const report = await complianceReporter.generate(projectRoot, {
      qualityGate,
      maxFiles,
    });

    res.json({ success: true, data: report });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'GUARD_REPORT_ERROR', message: (err as Error).message },
    });
  }
});

/**
 * GET /api/v1/guard/report/reverse
 * ReverseGuard — Recipe→Code 反向验证
 *
 * Query params:
 *   maxFiles — 扫描文件上限 (默认 200)
 */
router.get('/reverse', async (req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const projectRoot = resolveProjectRoot(container);

    const { ReverseGuard } = await import('../../service/guard/ReverseGuard.js');
    const { collectSourceFilesWithContent } = await import(
      '../../service/guard/SourceFileCollector.js'
    );

    let reverseGuard: InstanceType<typeof ReverseGuard>;
    try {
      reverseGuard = container.get('reverseGuard') as InstanceType<typeof ReverseGuard>;
    } catch {
      const db = container.get('database') as { getDb(): unknown };
      reverseGuard = new ReverseGuard(db.getDb() as ConstructorParameters<typeof ReverseGuard>[0]);
    }

    const maxFiles = req.query.maxFiles ? Number(req.query.maxFiles) : 200;
    const projectFiles = await collectSourceFilesWithContent(projectRoot, { maxFiles });
    const results = reverseGuard.auditAllRules(projectFiles);
    const drifts = reverseGuard.getDriftResults(results);

    res.json({
      success: true,
      data: {
        totalRecipes: results.length,
        healthy: results.filter((r) => r.recommendation === 'healthy').length,
        investigate: results.filter((r) => r.recommendation === 'investigate').length,
        decay: results.filter((r) => r.recommendation === 'decay').length,
        drifts,
        allResults: results.map((r) => ({
          recipeId: r.recipeId,
          title: r.title,
          recommendation: r.recommendation,
          signalCount: r.signals.length,
        })),
      },
    });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'REVERSE_GUARD_ERROR', message: (err as Error).message },
    });
  }
});

/**
 * GET /api/v1/guard/report/coverage
 * CoverageAnalyzer — 模块覆盖率矩阵
 */
router.get('/coverage', async (_req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();

    const { CoverageAnalyzer } = await import('../../service/guard/CoverageAnalyzer.js');

    let analyzer: InstanceType<typeof CoverageAnalyzer>;
    try {
      analyzer = container.get('coverageAnalyzer') as InstanceType<typeof CoverageAnalyzer>;
    } catch {
      const db = container.get('database') as { getDb(): unknown };
      analyzer = new CoverageAnalyzer(
        db.getDb() as ConstructorParameters<typeof CoverageAnalyzer>[0]
      );
    }

    // 从 Panorama 或目录结构获取模块文件
    const moduleFiles = new Map<string, string[]>();
    try {
      const panorama = container.get('panoramaService') as unknown as {
        getOverview(): { modules: { name: string; files: string[] }[] };
      };
      const overview = panorama.getOverview();
      if (overview?.modules) {
        for (const mod of overview.modules) {
          if (mod.files?.length > 0) {
            moduleFiles.set(mod.name, mod.files);
          }
        }
      }
    } catch {
      /* PanoramaService not available */
    }

    const matrix = analyzer.analyze(moduleFiles);
    res.json({ success: true, data: matrix });
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'COVERAGE_ANALYZER_ERROR', message: (err as Error).message },
    });
  }
});

export default router;

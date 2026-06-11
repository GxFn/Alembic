/**
 * Guard Report API 路由
 *
 * 端点:
 *   GET /api/v1/guard/report           — 项目合规性报告（ComplianceReporter + Uncertainty）
 *   GET /api/v1/guard/report/coverage  — CoverageAnalyzer 覆盖率矩阵
 */

import { resolveProjectRoot } from '@alembic/core/workspace';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validateQuery } from '../middleware/validate.js';

const router = express.Router();

const blankToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

const GuardReportQuery = z.object({
  maxErrors: z.preprocess(blankToUndefined, z.coerce.number().int().nonnegative().optional()),
  maxFiles: z.preprocess(blankToUndefined, z.coerce.number().int().positive().optional()),
  minScore: z.preprocess(blankToUndefined, z.coerce.number().min(0).max(100).optional()),
});

/**
 * GET /api/v1/guard/report
 * 生成完整的合规性报告，含 uncertain/coverage/confidence
 *
 * Query params:
 *   minScore   — 最低通过分数 (默认 60)
 *   maxErrors  — 最大错误数 (默认 0)
 *   maxFiles   — 扫描文件上限
 */
router.get(
  '/',
  validateQuery(GuardReportQuery),
  async (req: Request, res: Response): Promise<void> => {
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
      const query = req.query as z.infer<typeof GuardReportQuery>;

      const qualityGate = {
        minScore: query.minScore,
        maxErrors: query.maxErrors,
      };
      const maxFiles = query.maxFiles;

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
  }
);

/**
 * GET /api/v1/guard/report/coverage
 * CoverageAnalyzer — 模块覆盖率矩阵
 */
// AO1 route-input-exempt: coverage read uses no body/query/params and keeps legacy ignored query strings.
router.get('/coverage', async (_req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();

    const { CoverageAnalyzer } = await import('@alembic/core/guard');

    let analyzer: InstanceType<typeof CoverageAnalyzer>;
    try {
      analyzer = container.get('coverageAnalyzer') as InstanceType<typeof CoverageAnalyzer>;
    } catch {
      analyzer = new CoverageAnalyzer(
        container.get('knowledgeRepository') as ConstructorParameters<typeof CoverageAnalyzer>[0],
        container.get('guardViolationRepository') as ConstructorParameters<
          typeof CoverageAnalyzer
        >[1]
      );
    }

    // 从 Panorama 或目录结构获取模块文件
    const moduleFiles = new Map<string, string[]>();
    try {
      const panorama = container.get('panoramaService') as unknown as {
        getOverview(): Promise<{ modules: { name: string; files: string[] }[] }>;
      };
      const overview = await panorama.getOverview();
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

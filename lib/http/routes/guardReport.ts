/**
 * Guard Report API 路由
 *
 * 端点:
 *   GET /api/v1/guard/report — 项目合规性报告（ComplianceReporter + Uncertainty）
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

export default router;

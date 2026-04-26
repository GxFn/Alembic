/**
 * Commands API 路由
 * 执行 Module Map 刷新、Embed (重建索引) 等命令
 */

import express, { type Request, type Response } from 'express';
import { DASHBOARD_OPERATION_IDS } from '../../agent/dashboard/DashboardOperations.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { FileReadQuery, FileSaveBody } from '../../shared/schemas/http-requests.js';
import { validate, validateQuery } from '../middleware/validate.js';
import {
  executeDashboardOperation,
  sendDashboardOperationResponse,
} from '../utils/dashboard-operation.js';

const router = express.Router();

/**
 * POST /api/v1/commands/spm-map
 * 执行 SPM 依赖映射刷新（向后兼容）
 */
router.post('/spm-map', async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const envelope = await executeDashboardOperation(
    container,
    req,
    DASHBOARD_OPERATION_IDS.updateModuleMap,
    { aggressive: true }
  );
  sendDashboardOperationResponse(res, envelope);
});

/**
 * POST /api/v1/commands/embed
 * 全量重建语义索引
 */
router.post('/embed', async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const envelope = await executeDashboardOperation(
    container,
    req,
    DASHBOARD_OPERATION_IDS.rebuildSemanticIndex,
    req.body || {}
  );
  sendDashboardOperationResponse(res, envelope);
});

/**
 * GET /api/v1/commands/status
 * 获取命令执行状态（Snippet 同步状态、索引状态等）
 */
router.get('/status', async (req: Request, res: Response) => {
  const container = getServiceContainer();

  const status = {
    index: { ready: false },
    spmMap: { available: false },
  };

  try {
    const _indexingPipeline = container.get('indexingPipeline');
    status.index.ready = true; // IndexingPipeline is available
  } catch {
    /* ignore */
  }

  try {
    const moduleService = container.get('moduleService');
    await moduleService.load();
    status.spmMap.available = (await moduleService.listTargets()).length > 0;
  } catch {
    /* ignore */
  }

  res.json({ success: true, data: status });
});

// ─── File Operations (for Xcode Simulator page) ─────

/**
 * GET /api/v1/commands/files/tree
 * Get project file tree – only .h / .m / .swift source files
 */
router.get('/files/tree', async (req: Request, res: Response): Promise<void> => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const container = getServiceContainer();
  const projectRoot = (container.singletons?._projectRoot as string | undefined) || process.cwd();

  const SOURCE_EXTS = new Set(['.h', '.m', '.swift']);
  const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'Pods',
    'build',
    'DerivedData',
    '.build',
    'dist',
    'vendor',
  ]);

  /**
   * Recursively scan dir, returning FileNode or null if folder has no matching files.
   */
  function scanDir(dirPath: string) {
    const dirName = path.default.basename(dirPath);
    if (SKIP_DIRS.has(dirName)) {
      return null;
    }

    let entries: import('node:fs').Dirent[];
    try {
      entries = fs.default.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return null;
    }

    const children: Record<string, unknown>[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue; // skip hidden
      }
      const fullPath = path.default.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const sub = scanDir(fullPath);
        if (sub) {
          children.push(sub);
        }
      } else if (entry.isFile()) {
        const ext = path.default.extname(entry.name).toLowerCase();
        if (SOURCE_EXTS.has(ext)) {
          children.push({
            type: 'file',
            name: entry.name,
            path: fullPath,
            relativePath: path.default.relative(projectRoot, fullPath),
            ext,
          });
        }
      }
    }

    if (children.length === 0) {
      return null;
    }

    // Sort: folders first, then alphabetical
    children.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1;
      }
      return (a.name as string).localeCompare(b.name as string);
    });

    return {
      type: 'folder',
      name: dirName,
      path: dirPath,
      children,
    };
  }

  const tree = scanDir(projectRoot) || {
    type: 'folder',
    name: path.default.basename(projectRoot),
    path: projectRoot,
    children: [],
  };
  res.json({ success: true, data: tree });
});

/**
 * GET /api/v1/commands/files/read
 * Read file content (limited to projectRoot)
 */
router.get(
  '/files/read',
  validateQuery(FileReadQuery),
  async (req: Request, res: Response): Promise<void> => {
    const filePath = req.query.path as string;

    const path = await import('node:path');
    const container = getServiceContainer();
    const projectRoot = (container.singletons?._projectRoot as string | undefined) || process.cwd();
    const resolved = path.default.resolve(projectRoot, filePath);

    // 防止路径遍历：确保解析后的路径在 projectRoot 内
    if (!resolved.startsWith(projectRoot + path.default.sep) && resolved !== projectRoot) {
      return void res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Access denied: path outside project root' },
      });
    }

    const fs = await import('node:fs');
    try {
      const content = fs.default.readFileSync(resolved, 'utf8');
      res.json({ success: true, data: { content } });
    } catch {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'File not found' } });
    }
  }
);

/**
 * POST /api/v1/commands/files/save
 * Save file content (limited to projectRoot)
 */
router.post(
  '/files/save',
  validate(FileSaveBody),
  async (req: Request, res: Response): Promise<void> => {
    const { path: filePath, content } = req.body;

    const pathMod = await import('node:path');
    const container = getServiceContainer();
    const projectRoot = (container.singletons?._projectRoot as string | undefined) || process.cwd();
    const resolved = pathMod.default.resolve(projectRoot, filePath);

    // 防止路径遍历：确保解析后的路径在 projectRoot 内
    if (!resolved.startsWith(projectRoot + pathMod.default.sep) && resolved !== projectRoot) {
      return void res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Access denied: path outside project root' },
      });
    }

    try {
      const wz = container.singletons?.writeZone as
        | import('../../infrastructure/io/WriteZone.js').WriteZone
        | undefined;
      if (wz) {
        const rel = resolved.replace(wz.projectRoot, '').replace(/^\//, '');
        wz.writeFile(wz.project(rel), content);
      } else {
        const fs = await import('node:fs');
        fs.default.writeFileSync(resolved, content, 'utf8');
      }
      res.json({ success: true });
    } catch (err: unknown) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
      });
    }
  }
);

export default router;

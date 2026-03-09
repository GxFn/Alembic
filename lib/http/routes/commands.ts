/**
 * Commands API 路由
 * 执行 Install (同步 Snippet 到 IDE)、SPM Map 刷新、Embed (重建索引) 等命令
 */

import express, { type Request, type Response } from 'express';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { FileReadQuery, FileSaveBody } from '../../shared/schemas/http-requests.js';
import { validate, validateQuery } from '../middleware/validate.js';

const router = express.Router();
const logger = Logger.getInstance();

/**
 * POST /api/v1/commands/install
 * 从 Recipe 生成并同步 Snippet 到 IDE
 * Body: { target?: 'xcode' | 'vscode' | 'all' }
 */
router.post('/install', async (req: Request, res: Response) => {
  const container = getServiceContainer();
  const knowledgeRepository = container.get('knowledgeRepository');
  const target = req.body?.target || 'all';

  // 获取所有活跃 Recipe（V3: lifecycle='active' 即 Recipe）
  const result = await knowledgeRepository.findWithPagination(
    { lifecycle: 'active' },
    { page: 1, pageSize: 9999 }
  );
  const recipes = (
    (result?.data ??
      (result as unknown as Record<string, unknown>)?.items ??
      []) as unknown as Record<string, unknown>[]
  )
    .map((r: Record<string, unknown>) => ({
      id: r.id,
      title: r.title,
      trigger: r.trigger,
      code: (r.content as Record<string, unknown>)?.pattern || '',
      description: r.description || r.summaryCn || '',
      language: r.language || 'unknown',
    }))
    .filter((r: Record<string, unknown>) => String(r.code).trim().length > 0);

  const installResults: Record<string, unknown> = {};

  // Xcode
  if ((target === 'all' || target === 'xcode') && process.platform === 'darwin') {
    try {
      const xcodeInstaller = container.get('snippetInstaller');
      installResults.xcode = xcodeInstaller.installFromRecipes(
        recipes as unknown as Parameters<typeof xcodeInstaller.installFromRecipes>[0]
      );
    } catch (e: unknown) {
      installResults.xcode = { success: false, error: (e as Error).message };
    }
  }

  // VSCode
  if (target === 'all' || target === 'vscode') {
    try {
      const vscodeInstaller = container.get('vscodeSnippetInstaller');
      installResults.vscode = vscodeInstaller.installFromRecipes(
        recipes as unknown as Parameters<typeof vscodeInstaller.installFromRecipes>[0]
      );
    } catch (e: unknown) {
      installResults.vscode = { success: false, error: (e as Error).message };
    }
  }

  logger.info('Snippets installed via dashboard', { target, results: installResults });
  res.json({
    success: true,
    data: installResults,
  });
});

/**
 * POST /api/v1/commands/spm-map
 * 执行 SPM 依赖映射刷新（向后兼容）
 */
router.post('/spm-map', async (req: Request, res: Response) => {
  const container = getServiceContainer();

  const moduleService = container.get('moduleService');
  const result = await moduleService.updateModuleMap({ aggressive: true });

  logger.info('Module map updated via dashboard', { result });
  res.json({
    success: true,
    data: result,
  });
});

/**
 * POST /api/v1/commands/embed
 * 全量重建语义索引
 */
router.post('/embed', async (req: Request, res: Response) => {
  const container = getServiceContainer();

  // 优先使用 VectorService (新架构), 降级到 indexingPipeline (旧架构)
  const vectorService = container.services.vectorService ? container.get('vectorService') : null;

  let result: Record<string, unknown>;

  if (vectorService) {
    const clearFirst = req.body?.clear !== false;
    if (clearFirst) {
      await vectorService.clear();
    }
    const buildResult = await vectorService.fullBuild({
      force: req.body?.force ?? false,
    });
    result = {
      scanned: buildResult.scanned,
      chunked: buildResult.chunked,
      embedded: buildResult.embedded,
      upserted: buildResult.upserted,
      skipped: buildResult.skipped,
      errors: buildResult.errors,
    };
  } else {
    const indexingPipeline = container.get('indexingPipeline');
    result = await indexingPipeline.run({
      clear: req.body?.clear !== false,
      force: req.body?.force ?? false,
    });
  }

  logger.info('Semantic index rebuilt via dashboard', { result });
  res.json({
    success: true,
    data: {
      scanned: result.scanned || 0,
      chunked: result.chunked || 0,
      embedded: result.embedded || 0,
      upserted: result.upserted || 0,
      skipped: result.skipped || 0,
      errors: result.errors || 0,
    },
  });
});

/**
 * GET /api/v1/commands/status
 * 获取命令执行状态（Snippet 同步状态、索引状态等）
 */
router.get('/status', async (req: Request, res: Response) => {
  const container = getServiceContainer();

  const status = {
    snippets: { xcode: { synced: false }, vscode: { synced: false } },
    index: { ready: false },
    spmMap: { available: false },
  };

  try {
    const snippetInstaller = container.get('snippetInstaller');
    status.snippets.xcode.synced = (await snippetInstaller.listInstalled?.())?.length > 0;
  } catch {
    /* ignore */
  }

  try {
    const vscodeInstaller = container.get('vscodeSnippetInstaller');
    status.snippets.vscode.synced = (await vscodeInstaller.listInstalled?.())?.length > 0;
  } catch {
    /* ignore */
  }

  try {
    const indexingPipeline = container.get('indexingPipeline');
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

    const fs = await import('node:fs');
    try {
      fs.default.writeFileSync(resolved, content, 'utf8');
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

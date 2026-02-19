/**
 * Commands API 路由
 * 执行 Install (同步 Xcode)、SPM Map 刷新、Embed (重建索引) 等命令
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import Logger from '../../infrastructure/logging/Logger.js';

const router = express.Router();
const logger = Logger.getInstance();

/**
 * POST /api/v1/commands/install
 * 从 Recipe 生成并同步 Snippet 到 Xcode
 */
router.post('/install', asyncHandler(async (req, res) => {
  const container = getServiceContainer();
  const snippetFactory = container.get('snippetFactory');
  const snippetInstaller = container.get('snippetInstaller');
  const recipeRepository = container.get('recipeRepository');

  // 获取所有活跃 Recipe
  const result = await recipeRepository.findWithPagination(
    { status: 'active' },
    { page: 1, pageSize: 9999 },
  );
  const recipes = (result?.data || result?.items || [])
    .map(r => ({
      id: r.id,
      title: r.title,
      trigger: r.trigger,
      code: r.content?.pattern || '',
      description: r.description || r.summaryCn || '',
      language: r.language || 'swift',
    }))
    .filter(r => r.code.trim().length > 0); // 跳过没有代码内容的 Recipe

  const installResult = snippetInstaller.installFromRecipes(recipes);

  logger.info('Xcode snippets installed via dashboard', { result: installResult });
  res.json({
    success: true,
    data: installResult,
  });
}));

/**
 * POST /api/v1/commands/spm-map
 * 执行 SPM 依赖映射刷新
 */
router.post('/spm-map', asyncHandler(async (req, res) => {
  const container = getServiceContainer();
  const spmService = container.get('spmService');

  const result = await spmService.updateDependencyMap({
    aggressive: true,
  });

  logger.info('SPM map updated via dashboard', { result });
  res.json({
    success: true,
    data: result,
  });
}));

/**
 * POST /api/v1/commands/embed
 * 全量重建语义索引
 */
router.post('/embed', asyncHandler(async (req, res) => {
  const container = getServiceContainer();
  const indexingPipeline = container.get('indexingPipeline');

  const result = await indexingPipeline.run({
    clear: req.body?.clear !== false,
  });

  logger.info('Semantic index rebuilt via dashboard', { result });
  res.json({
    success: true,
    data: {
      indexed: result.indexed || 0,
      skipped: result.skipped || 0,
      removed: result.removed || 0,
    },
  });
}));

/**
 * GET /api/v1/commands/status
 * 获取命令执行状态（Xcode 同步状态、索引状态等）
 */
router.get('/status', asyncHandler(async (req, res) => {
  const container = getServiceContainer();
  
  const status = {
    xcode: { synced: false },
    index: { ready: false },
    spmMap: { available: false },
  };

  try {
    const snippetInstaller = container.get('snippetInstaller');
    status.xcode.synced = await snippetInstaller.isInstalled?.() ?? false;
  } catch { /* ignore */ }

  try {
    const indexingPipeline = container.get('indexingPipeline');
    status.index.ready = indexingPipeline.isReady?.() ?? false;
  } catch { /* ignore */ }

  try {
    const spmService = container.get('spmService');
    status.spmMap.available = spmService.hasMap?.() ?? false;
  } catch { /* ignore */ }

  res.json({ success: true, data: status });
}));

// ─── File Operations (for Xcode Simulator page) ─────

/**
 * GET /api/v1/commands/files/tree
 * Get project file tree – only .h / .m / .swift source files
 */
router.get('/files/tree', asyncHandler(async (req, res) => {
  const fs   = await import('node:fs');
  const path = await import('node:path');
  const container   = getServiceContainer();
  const projectRoot = container.singletons?._projectRoot || process.cwd();

  const SOURCE_EXTS = new Set(['.h', '.m', '.swift']);
  const SKIP_DIRS   = new Set(['node_modules', '.git', 'Pods', 'build', 'DerivedData', '.build', 'dist', 'vendor']);

  /**
   * Recursively scan dir, returning FileNode or null if folder has no matching files.
   */
  function scanDir(dirPath) {
    const dirName = path.default.basename(dirPath);
    if (SKIP_DIRS.has(dirName)) return null;

    let entries;
    try { entries = fs.default.readdirSync(dirPath, { withFileTypes: true }); } catch { return null; }

    const children = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;                       // skip hidden
      const fullPath = path.default.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const sub = scanDir(fullPath);
        if (sub) children.push(sub);
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

    if (children.length === 0) return null;

    // Sort: folders first, then alphabetical
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      type: 'folder',
      name: dirName,
      path: dirPath,
      children,
    };
  }

  const tree = scanDir(projectRoot) || { type: 'folder', name: path.default.basename(projectRoot), path: projectRoot, children: [] };
  res.json({ success: true, data: tree });
}));

/**
 * GET /api/v1/commands/files/read
 * Read file content (limited to projectRoot)
 */
router.get('/files/read', asyncHandler(async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'path is required' } });

  const path = await import('node:path');
  const container = getServiceContainer();
  const projectRoot = container.singletons?._projectRoot || process.cwd();
  const resolved = path.default.resolve(projectRoot, filePath);

  // 防止路径遍历：确保解析后的路径在 projectRoot 内
  if (!resolved.startsWith(projectRoot + path.default.sep) && resolved !== projectRoot) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied: path outside project root' } });
  }

  const fs = await import('node:fs');
  try {
    const content = fs.default.readFileSync(resolved, 'utf8');
    res.json({ success: true, data: { content } });
  } catch {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'File not found' } });
  }
}));

/**
 * POST /api/v1/commands/files/save
 * Save file content (limited to projectRoot)
 */
router.post('/files/save', asyncHandler(async (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content === undefined) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'path and content required' } });

  const pathMod = await import('node:path');
  const container = getServiceContainer();
  const projectRoot = container.singletons?._projectRoot || process.cwd();
  const resolved = pathMod.default.resolve(projectRoot, filePath);

  // 防止路径遍历：确保解析后的路径在 projectRoot 内
  if (!resolved.startsWith(projectRoot + pathMod.default.sep) && resolved !== projectRoot) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied: path outside project root' } });
  }

  const fs = await import('node:fs');
  try {
    fs.default.writeFileSync(resolved, content, 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
}));

export default router;

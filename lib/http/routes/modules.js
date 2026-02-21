/**
 * Modules API 路由 — 统一多语言模块扫描
 * 替代 spm.js，提供语言无关的模块管理、依赖图、AI 扫描
 *
 * 所有端点通过 container.get('moduleService') 获取 ModuleService 实例
 */

import express from 'express';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { ValidationError } from '../../shared/errors/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createStreamSession, getStreamSession } from '../utils/sse-sessions.js';

const router = express.Router();
const logger = Logger.getInstance();

/**
 * GET /api/v1/modules/targets
 * 获取所有模块 Target 列表（多语言合并）
 */
router.get(
  '/targets',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();
    const targets = await moduleService.listTargets();

    res.json({
      success: true,
      data: {
        targets,
        total: targets.length,
        projectInfo: moduleService.getProjectInfo(),
      },
    });
  })
);

/**
 * GET /api/v1/modules/dep-graph
 * 获取模块依赖关系图
 */
router.get(
  '/dep-graph',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();
    const level = req.query.level || 'package'; // 'package' | 'target' | 'module'
    const graph = await moduleService.getDependencyGraph({ level });

    if (!graph || (!graph.nodes && !graph.packages)) {
      return res.json({
        success: true,
        data: { nodes: [], edges: [], projectRoot: null },
      });
    }

    // 标准化为 { nodes, edges } 格式
    let nodes = [];
    let edges = [];

    if (graph.nodes && graph.edges) {
      nodes = graph.nodes;
      edges = graph.edges;
    } else if (graph.packages) {
      // SPM 格式兼容：从 packages 构建图
      if (level === 'target') {
        for (const [pkgName, pkgInfo] of Object.entries(graph.packages)) {
          const targetsInfo = pkgInfo?.targetsInfo || {};
          for (const [targetName, info] of Object.entries(targetsInfo)) {
            const id = `${pkgName}::${targetName}`;
            nodes.push({
              id,
              label: targetName,
              type: 'target',
              packageName: pkgName,
            });
            for (const d of info?.dependencies || []) {
              if (!d?.name) continue;
              const depPkg = d?.package || pkgName;
              edges.push({ from: id, to: `${depPkg}::${d.name}`, source: 'base' });
            }
          }
        }
      } else {
        nodes = Object.keys(graph.packages).map((id) => ({
          id,
          label: id,
          type: 'package',
          packageDir: graph.packages[id]?.packageDir,
          targets: graph.packages[id]?.targets,
        }));
        for (const [from, tos] of Object.entries(graph.edges || {})) {
          for (const to of tos || []) {
            edges.push({ from, to, source: 'base' });
          }
        }
      }
    }

    res.json({
      success: true,
      data: {
        nodes,
        edges,
        projectRoot: graph.projectRoot || null,
        generatedAt: graph.generatedAt || null,
      },
    });
  })
);

/**
 * GET /api/v1/modules/browse-dirs
 * 浏览项目目录结构 — 供前端选择要扫描的文件夹
 */
router.get(
  '/browse-dirs',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();

    const basePath = req.query.path || '';
    const maxDepth = Math.min(Number.parseInt(req.query.depth || '3', 10), 5);

    const dirs = await moduleService.browseDirectories(basePath, maxDepth);

    res.json({
      success: true,
      data: {
        directories: dirs,
        total: dirs.length,
        basePath: basePath || '.',
        projectRoot: moduleService.getProjectInfo().projectRoot,
      },
    });
  })
);

/**
 * POST /api/v1/modules/scan-folder
 * 扫描任意目录 — 直接走 AI 管线（无需 Discoverer 检测）
 */
router.post(
  '/scan-folder',
  asyncHandler(async (req, res) => {
    const { path: folderPath, options = {} } = req.body;

    if (!folderPath) {
      throw new ValidationError('path (relative folder path) is required');
    }

    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();

    const result = await moduleService.scanFolder(folderPath, options);

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * POST /api/v1/modules/scan-folder/stream
 * 流式扫描任意目录 — SSE Session 架构
 */
router.post(
  '/scan-folder/stream',
  asyncHandler(async (req, res) => {
    const { path: folderPath, options = {} } = req.body;

    if (!folderPath) {
      throw new ValidationError('path (relative folder path) is required');
    }

    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();

    const sessionId = createStreamSession();
    const session = getStreamSession(sessionId);

    res.json({ sessionId });

    // 异步执行扫描，事件推送到 session
    setImmediate(async () => {
      try {
        const result = await moduleService.scanFolder(folderPath, {
          ...options,
          onProgress: (evt) => {
            if (session) session.push(evt);
          },
        });

        if (session) {
          session.push({
            type: 'scan:result',
            recipes: result.recipes || [],
            scannedFiles: result.scannedFiles || [],
            message: result.message || '',
            noAi: !!result.noAi,
          });
          session.push({ type: 'scan:done' });
        }
      } catch (err) {
        logger.error(`[modules] scan-folder/stream error: ${err.message}`);
        if (session) {
          session.push({ type: 'scan:error', message: err.message });
          session.push({ type: 'scan:done' });
        }
      }
    });
  })
);

/**
 * POST /api/v1/modules/target-files
 * 获取模块的文件列表
 */
router.post(
  '/target-files',
  asyncHandler(async (req, res) => {
    const { target, targetName } = req.body;

    if (!target && !targetName) {
      throw new ValidationError('target object or targetName is required');
    }

    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();

    let resolvedTarget = target;
    if (!resolvedTarget && targetName) {
      const targets = await moduleService.listTargets();
      resolvedTarget = targets.find((t) => t.name === targetName);
      if (!resolvedTarget) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `Module not found: ${targetName}` },
        });
      }
    }

    const files = await moduleService.getTargetFiles(resolvedTarget);

    res.json({
      success: true,
      data: {
        target: resolvedTarget.name || targetName,
        files,
        total: files.length,
      },
    });
  })
);

/**
 * POST /api/v1/modules/scan
 * AI 扫描模块，发现候选项
 */
router.post(
  '/scan',
  asyncHandler(async (req, res) => {
    const { target, targetName, options = {} } = req.body;

    if (!target && !targetName) {
      throw new ValidationError('target object or targetName is required');
    }

    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();

    let resolvedTarget = target;
    if (!resolvedTarget && targetName) {
      const targets = await moduleService.listTargets();
      resolvedTarget = targets.find((t) => t.name === targetName);
      if (!resolvedTarget) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `Module not found: ${targetName}` },
        });
      }
    }

    logger.info('Module scan started via dashboard', {
      target: resolvedTarget.name,
      discoverer: resolvedTarget.discovererId,
    });
    const result = await moduleService.scanTarget(resolvedTarget, options);

    res.json({
      success: true,
      data: result,
    });
  })
);

// ── 流式 Target 扫描（SSE Session + EventSource 架构） ─────────

/**
 * POST /api/v1/modules/scan/stream
 * 创建流式扫描会话，后台异步执行 AI 扫描
 */
router.post(
  '/scan/stream',
  asyncHandler(async (req, res) => {
    const { target, targetName, options = {} } = req.body;

    if (!target && !targetName) {
      throw new ValidationError('target object or targetName is required');
    }

    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();

    let resolvedTarget = target;
    if (!resolvedTarget && targetName) {
      const targets = await moduleService.listTargets();
      resolvedTarget = targets.find((t) => t.name === targetName);
      if (!resolvedTarget) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `Module not found: ${targetName}` },
        });
      }
    }

    // 创建 SSE session
    const session = createStreamSession('scan');
    const tName = resolvedTarget.name || targetName;

    // 立即返回 sessionId
    res.json({ sessionId: session.sessionId });

    // 异步执行扫描，通过 session 推送进度事件
    setImmediate(async () => {
      try {
        logger.info('Module stream scan started', {
          target: tName,
          sessionId: session.sessionId,
        });
        const result = await moduleService.scanTarget(resolvedTarget, {
          ...options,
          onProgress(event) {
            session.send(event);
          },
        });

        // 发送最终结果
        session.send({
          type: 'scan:result',
          recipes: result.recipes || [],
          scannedFiles: result.scannedFiles || [],
          message: result.message || '',
          noAi: !!result.noAi,
          recipeCount: (result.recipes || []).length,
          fileCount: (result.scannedFiles || []).length,
        });
        session.end();
      } catch (err) {
        logger.error('Module stream scan failed', { target: tName, error: err.message });
        session.error(err.message, 'SCAN_ERROR');
      }
    });
  })
);

/**
 * GET /api/v1/modules/scan/events/:sessionId
 * EventSource SSE 端点 — 消费扫描进度事件
 */
router.get('/scan/events/:sessionId', (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found or expired' });
  }

  // ─── SSE Headers ───
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setTimeout(0);
  }

  function writeEvent(event) {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  // 1) 回放缓冲区
  let isDone = false;
  for (const event of session.buffer) {
    writeEvent(event);
    if (event.type === 'stream:done' || event.type === 'stream:error') {
      isDone = true;
    }
  }

  if (isDone || session.completed) {
    res.end();
    return;
  }

  // 2) 订阅实时事件
  const unsubscribe = session.on((event) => {
    writeEvent(event);
    if (event.type === 'stream:done' || event.type === 'stream:error') {
      unsubscribe();
      clearInterval(heartbeat);
      res.end();
    }
  });

  // 心跳保活 (每 15 秒)
  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);

  // 客户端断开连接时清理
  res.on('close', () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
});

/**
 * POST /api/v1/modules/scan-project
 * 全项目扫描：AI 提取候选 + Guard 审计
 */
router.post(
  '/scan-project',
  asyncHandler(async (req, res) => {
    const { options = {} } = req.body;

    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();
    logger.info('Full project scan started via dashboard (ModuleService)');
    const result = await moduleService.scanProject(options);

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * POST /api/v1/modules/update-map
 * 刷新模块映射（替代 spm-map）
 */
router.post(
  '/update-map',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    const result = await moduleService.updateModuleMap({
      aggressive: true,
    });

    logger.info('Module map updated via dashboard', { result });
    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * GET /api/v1/modules/project-info
 * 项目信息（检测到的语言、框架等）
 */
router.get(
  '/project-info',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();
    const info = moduleService.getProjectInfo();

    res.json({
      success: true,
      data: info,
    });
  })
);

/**
 * POST /api/v1/modules/bootstrap
 * 冷启动：快速骨架 + 异步逐维度填充
 */
router.post(
  '/bootstrap',
  asyncHandler(async (req, res) => {
    const { maxFiles, skipGuard, contentMaxLines } = req.body || {};

    const container = getServiceContainer();
    const chatAgent = container.get('chatAgent');

    logger.info('Bootstrap cold start initiated (ModuleService path)');

    const bootstrapResult = await chatAgent.executeTool('bootstrap_knowledge', {
      maxFiles: maxFiles || 500,
      skipGuard: skipGuard || false,
      contentMaxLines: contentMaxLines || 120,
      loadSkills: true,
    });

    res.json({
      success: true,
      data: {
        ...bootstrapResult,
        asyncFill: true,
      },
    });
  })
);

/**
 * GET /api/v1/modules/bootstrap/status
 * 查询 bootstrap 异步填充进度
 */
router.get(
  '/bootstrap/status',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();

    let taskManager = null;
    try {
      taskManager = container.get('bootstrapTaskManager');
    } catch {
      /* not registered */
    }
    if (!taskManager) {
      return res.json({
        success: true,
        data: { status: 'idle', message: 'No bootstrap task manager initialized' },
      });
    }

    res.json({
      success: true,
      data: taskManager.getSessionStatus(),
    });
  })
);

export default router;

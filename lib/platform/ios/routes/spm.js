/**
 * SPM API 路由 — 向后兼容层
 *
 * 所有端点统一委派到 ModuleService（语言无关模块扫描服务）。
 * SPM Discoverer 作为 ModuleService 的一个 discoverer 自动匹配 Swift/SPM 项目。
 * 新代码应直接使用 /api/v1/modules/* 端点。
 */

import express from 'express';
import Logger from '../../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../../injection/ServiceContainer.js';
import { ValidationError } from '../../../shared/errors/index.js';
import { asyncHandler } from '../../../http/middleware/errorHandler.js';
import { createStreamSession, getStreamSession } from '../../../http/utils/sse-sessions.js';

const router = express.Router();
const logger = Logger.getInstance();

/** 获取 moduleService 并确保已加载 */
async function getModuleService() {
  const container = getServiceContainer();
  const moduleService = container.get('moduleService');
  await moduleService.load();
  return moduleService;
}

/**
 * GET /api/v1/spm/targets
 */
router.get(
  '/targets',
  asyncHandler(async (req, res) => {
    const moduleService = await getModuleService();
    const targets = await moduleService.listTargets();

    res.json({
      success: true,
      data: { targets, total: targets.length },
    });
  })
);

/**
 * GET /api/v1/spm/dep-graph
 */
router.get(
  '/dep-graph',
  asyncHandler(async (req, res) => {
    const moduleService = await getModuleService();
    const level = req.query.level || 'package';
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
      // 已经是标准格式
      nodes = graph.nodes;
      edges = graph.edges;
    } else if (graph.packages) {
      // 从 packages 构建图
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
              if (!d?.name) {
                continue;
              }
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
 * POST /api/v1/spm/target-files
 * 获取 Target 的文件列表
 */
router.post(
  '/target-files',
  asyncHandler(async (req, res) => {
    const { target, targetName } = req.body;

    if (!target && !targetName) {
      throw new ValidationError('target object or targetName is required');
    }

    const moduleService = await getModuleService();

    let resolvedTarget = target;
    if (!resolvedTarget && targetName) {
      const targets = await moduleService.listTargets();
      resolvedTarget = targets.find((t) => t.name === targetName);
      if (!resolvedTarget) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `Target not found: ${targetName}` },
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
 * POST /api/v1/spm/scan
 * AI 扫描 Target，发现候选项
 */
router.post(
  '/scan',
  asyncHandler(async (req, res) => {
    const { target, targetName, options = {} } = req.body;

    if (!target && !targetName) {
      throw new ValidationError('target object or targetName is required');
    }

    const moduleService = await getModuleService();

    let resolvedTarget = target;
    if (!resolvedTarget && targetName) {
      const targets = await moduleService.listTargets();
      resolvedTarget = targets.find((t) => t.name === targetName);
      if (!resolvedTarget) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `Target not found: ${targetName}` },
        });
      }
    }

    logger.info('Module scan started via /spm/', { target: resolvedTarget.name });
    const result = await moduleService.scanTarget(resolvedTarget, options);

    res.json({
      success: true,
      data: result,
    });
  })
);

// ── 流式 Target 扫描（SSE Session + EventSource 架构） ─────────

/**
 * POST /api/v1/spm/scan/stream
 * 创建流式扫描会话，后台异步执行 AI 扫描
 *
 * 协议事件（通过 SSE session 缓冲 + EventSource 交付）:
 *   scan:started       — 扫描启动
 *   scan:files-loaded   — 文件列表就绪，含 files[] + count
 *   scan:reading        — 读取文件内容中
 *   scan:ai-extracting  — AI 提取开始（耗时阶段）
 *   scan:enriching      — 后处理阶段
 *   scan:completed      — 最终结果 {recipes, scannedFiles, recipeCount, fileCount}
 *   scan:error          — 发生错误
 *   stream:done         — 会话结束标记
 */
router.post(
  '/scan/stream',
  asyncHandler(async (req, res) => {
    const { target, targetName, options = {} } = req.body;

    if (!target && !targetName) {
      throw new ValidationError('target object or targetName is required');
    }

    const moduleService = await getModuleService();

    let resolvedTarget = target;
    if (!resolvedTarget && targetName) {
      const targets = await moduleService.listTargets();
      resolvedTarget = targets.find((t) => t.name === targetName);
      if (!resolvedTarget) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `Target not found: ${targetName}` },
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
        logger.info('Module stream scan started via /spm/', { target: tName, sessionId: session.sessionId });
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
          recipeCount: (result.recipes || []).length,
          fileCount: (result.scannedFiles || []).length,
        });
        session.end();
      } catch (err) {
        logger.error('Module stream scan failed via /spm/', { target: tName, error: err.message });
        session.error(err.message, 'SCAN_ERROR');
      }
    });
  })
);

/**
 * GET /api/v1/spm/scan/events/:sessionId
 * EventSource SSE 端点 — 消费扫描进度事件
 *
 * 复用 chat/events 相同的 SSE 交付模式：回放缓冲 → 订阅实时 → 心跳保活
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
    if (res.writableEnded) {
      return;
    }
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
 * POST /api/v1/spm/scan-project
 * 全项目扫描：AI 提取候选 + Guard 审计
 */
router.post(
  '/scan-project',
  asyncHandler(async (req, res) => {
    const { options = {} } = req.body;

    const moduleService = await getModuleService();

    logger.info('Full project scan started via /spm/');
    const result = await moduleService.scanProject(options);

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * POST /api/v1/spm/bootstrap
 * 冷启动：快速骨架 + 异步逐维度填充（v5）
 *
 * 执行策略：
 *   ① 同步阶段: Phase 1-4（文件收集 + AST + SPM + Guard + 骨架响应）→ 立即返回
 *   ② 异步阶段: Phase 5/5.5（逐维度提取 + Candidate/Skill 创建）→ 后台逐一执行
 *   ③ 进度推送: 通过 Socket.io 实时推送每个维度的完成状态
 *
 * 前端立即获得骨架 + 任务清单，每个维度完成后通过 Socket.io 推送更新。
 */
router.post(
  '/bootstrap',
  asyncHandler(async (req, res) => {
    const { maxFiles, skipGuard, contentMaxLines } = req.body || {};

    const container = getServiceContainer();
    const chatAgent = container.get('chatAgent');

    logger.info('Bootstrap cold start initiated (v5: async fill mode)');

    // ── 同步阶段: 快速执行 Phase 1-4 → 返回骨架 ──
    const bootstrapResult = await chatAgent.executeTool('bootstrap_knowledge', {
      maxFiles: maxFiles || 500,
      skipGuard: skipGuard || false,
      contentMaxLines: contentMaxLines || 120,
      loadSkills: true,
    });

    // 立即返回骨架结果给前端
    res.json({
      success: true,
      data: {
        ...bootstrapResult,
        asyncFill: true, // 告知前端：内容正在异步填充中
      },
    });

    // 注意：Phase 5/5.5 异步填充已在 bootstrapKnowledge() 内部通过 setImmediate 启动
    // 进度通过 BootstrapTaskManager → Socket.io 推送到前端
  })
);

/**
 * GET /api/v1/spm/bootstrap/status
 * 查询当前 bootstrap 异步填充进度
 *
 * 返回当前 session 的任务状态列表，供前端轮询（Socket.io 不可用时的 fallback）
 */
router.get(
  '/bootstrap/status',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();

    // 从容器获取 BootstrapTaskManager（正式 DI 注册）
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

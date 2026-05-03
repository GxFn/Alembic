/**
 * Modules API 路由 — 统一多语言模块扫描
 * 替代 spm.js，提供语言无关的模块管理、依赖图、AI 扫描
 *
 * 所有端点通过 container.get('moduleService') 获取 ModuleService 实例
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import {
  ModuleBootstrapBody,
  ModuleRescanBody,
  ScanFolderBody,
  ScanProjectBody,
  ScanTargetBody,
} from '#shared/schemas/http-requests.js';
import { DASHBOARD_OPERATION_IDS } from '#tools/adapters/DashboardOperations.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { resolveDataRoot } from '../../shared/resolveProjectRoot.js';
import { validate } from '../middleware/validate.js';
import {
  executeDashboardOperation,
  sendDashboardOperationResponse,
} from '../utils/dashboard-operation.js';
import { createStreamSession, getStreamSession } from '../utils/sse-sessions.js';

const router = express.Router();
const logger = Logger.getInstance();
const SAFE_REPORT_ID = /^[a-zA-Z0-9_.:-]+$/;

/**
 * GET /api/v1/modules/targets
 * 获取所有模块 Target 列表（多语言合并）
 */
router.get('/targets', async (req: Request, res: Response): Promise<void> => {
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
});

/**
 * GET /api/v1/modules/dep-graph
 * 获取模块依赖关系图
 */
router.get('/dep-graph', async (req: Request, res: Response): Promise<void> => {
  const container = getServiceContainer();
  const moduleService = container.get('moduleService');

  await moduleService.load();
  const level = String(req.query.level || 'package') as 'target' | 'package';
  const _graphBase = await moduleService.getDependencyGraph({ level });
  const graph = _graphBase as typeof _graphBase & {
    packages?: Record<string, Record<string, unknown>>;
  };

  if (!graph || (!graph.nodes && !graph.packages)) {
    return void res.json({
      success: true,
      data: { nodes: [], edges: [], projectRoot: null },
    });
  }

  // 标准化为 { nodes, edges } 格式
  let nodes: Record<string, unknown>[] = [];
  let edges: { from: string; to: string; source: string }[] = [];

  if (graph.nodes && graph.edges) {
    nodes = graph.nodes;
    edges = graph.edges;
  } else if (graph.packages) {
    // SPM 格式兼容：从 packages 构建图
    if (level === 'target') {
      for (const [pkgName, pkgInfo] of Object.entries(graph.packages)) {
        const pkgRecord = pkgInfo as Record<string, unknown>;
        const targetsInfo = (pkgRecord?.targetsInfo || {}) as Record<
          string,
          Record<string, unknown>
        >;
        for (const [targetName, info] of Object.entries(targetsInfo)) {
          const id = `${pkgName}::${targetName}`;
          nodes.push({
            id,
            label: targetName,
            type: 'target',
            packageName: pkgName,
          });
          const deps = (info?.dependencies || []) as Array<{ name?: string; package?: string }>;
          for (const d of deps) {
            if (!d?.name) {
              continue;
            }
            const depPkg = d?.package || pkgName;
            edges.push({ from: id, to: `${depPkg}::${d.name}`, source: 'base' });
          }
        }
      }
    } else {
      const pkgs = graph.packages;
      nodes = Object.keys(pkgs).map((id) => ({
        id,
        label: id,
        type: 'package',
        packageDir: pkgs[id]?.packageDir,
        targets: pkgs[id]?.targets,
      }));
      for (const [from, tos] of Object.entries(graph.edges || {})) {
        for (const to of (tos as unknown as string[]) || []) {
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
});

/**
 * GET /api/v1/modules/browse-dirs
 * 浏览项目目录结构 — 供前端选择要扫描的文件夹
 */
router.get('/browse-dirs', async (req: Request, res: Response): Promise<void> => {
  const container = getServiceContainer();
  const moduleService = container.get('moduleService');

  await moduleService.load();

  const basePath = (req.query.path as string) || '';
  const maxDepth = Math.min(Number.parseInt((req.query.depth as string) || '3', 10), 5);

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
});

/**
 * POST /api/v1/modules/scan-folder
 * 扫描任意目录 — 直接走 AI 管线（无需 Discoverer 检测）
 */
router.post(
  '/scan-folder',
  validate(ScanFolderBody),
  async (req: Request, res: Response): Promise<void> => {
    const { path: folderPath, options = {} } = req.body;

    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();

    const result = await moduleService.scanFolder(folderPath, options);

    res.json({
      success: true,
      data: result,
    });
  }
);

/**
 * POST /api/v1/modules/scan-folder/stream
 * 流式扫描任意目录 — SSE Session 架构
 */
router.post(
  '/scan-folder/stream',
  validate(ScanFolderBody),
  async (req: Request, res: Response): Promise<void> => {
    const { path: folderPath, options = {} } = req.body;

    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();

    const streamSession = createStreamSession('scan');
    const sessionId = streamSession.sessionId;
    const session = getStreamSession(sessionId);

    res.json({ sessionId });

    // 异步执行扫描，事件推送到 session
    setImmediate(async () => {
      try {
        const result = await moduleService.scanFolder(folderPath, {
          ...options,
          onProgress: (evt: Record<string, unknown>) => {
            if (session) {
              session.push(evt);
            }
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
      } catch (err: unknown) {
        logger.error(`[modules] scan-folder/stream error: ${(err as Error).message}`);
        if (session) {
          session.push({ type: 'scan:error', message: (err as Error).message });
          session.push({ type: 'scan:done' });
        }
      }
    });
  }
);

/**
 * POST /api/v1/modules/target-files
 * 获取模块的文件列表
 */
router.post(
  '/target-files',
  validate(ScanTargetBody),
  async (req: Request, res: Response): Promise<void> => {
    const { target, targetName } = req.body;

    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();

    let resolvedTarget = target;
    if (!resolvedTarget && targetName) {
      const targets = await moduleService.listTargets();
      resolvedTarget = targets.find((t: Record<string, unknown>) => t.name === targetName);
      if (!resolvedTarget) {
        return void res.status(404).json({
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
  }
);

/**
 * POST /api/v1/modules/scan
 * AI 扫描模块，发现候选项
 */
router.post(
  '/scan',
  validate(ScanTargetBody),
  async (req: Request, res: Response): Promise<void> => {
    const { target, targetName, options = {} } = req.body;

    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();

    let resolvedTarget = target;
    if (!resolvedTarget && targetName) {
      const targets = await moduleService.listTargets();
      resolvedTarget = targets.find((t: Record<string, unknown>) => t.name === targetName);
      if (!resolvedTarget) {
        return void res.status(404).json({
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
  }
);

// ── 流式 Target 扫描（SSE Session + EventSource 架构） ─────────

/**
 * POST /api/v1/modules/scan/stream
 * 创建流式扫描会话，后台异步执行 AI 扫描
 */
router.post(
  '/scan/stream',
  validate(ScanTargetBody),
  async (req: Request, res: Response): Promise<void> => {
    const { target, targetName, options = {} } = req.body;

    const container = getServiceContainer();
    const moduleService = container.get('moduleService');

    await moduleService.load();

    let resolvedTarget = target;
    if (!resolvedTarget && targetName) {
      const targets = await moduleService.listTargets();
      resolvedTarget = targets.find((t: Record<string, unknown>) => t.name === targetName);
      if (!resolvedTarget) {
        return void res.status(404).json({
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
          onProgress(event: Record<string, unknown>) {
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
          recipeCount: ((result.recipes || []) as unknown[]).length,
          fileCount: ((result.scannedFiles || []) as unknown[]).length,
        });
        session.end();
      } catch (err: unknown) {
        logger.error('Module stream scan failed', { target: tName, error: (err as Error).message });
        session.error((err as Error).message, 'SCAN_ERROR');
      }
    });
  }
);

/**
 * GET /api/v1/modules/scan/events/:sessionId
 * EventSource SSE 端点 — 消费扫描进度事件
 */
router.get('/scan/events/:sessionId', (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found or expired' });
    return;
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

  function writeEvent(event: Record<string, unknown>) {
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
  const unsubscribe = session.on((event: Record<string, unknown>) => {
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
  validate(ScanProjectBody),
  async (req: Request, res: Response): Promise<void> => {
    const { options = {} } = req.body;

    const container = getServiceContainer();
    const envelope = await executeDashboardOperation(
      container,
      req,
      DASHBOARD_OPERATION_IDS.scanProject,
      { options }
    );
    sendDashboardOperationResponse(res, envelope);
  }
);

/**
 * POST /api/v1/modules/update-map
 * 刷新模块映射（替代 spm-map）
 */
router.post('/update-map', async (req: Request, res: Response): Promise<void> => {
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
 * GET /api/v1/modules/project-info
 * 项目信息（检测到的语言、框架等）
 */
router.get('/project-info', async (req: Request, res: Response): Promise<void> => {
  const container = getServiceContainer();
  const moduleService = container.get('moduleService');

  await moduleService.load();
  const info = moduleService.getProjectInfo();

  res.json({
    success: true,
    data: info,
  });
});

/**
 * POST /api/v1/modules/bootstrap
 * 冷启动：快速骨架 + 异步逐维度填充
 */
router.post(
  '/bootstrap',
  validate(ModuleBootstrapBody),
  async (req: Request, res: Response): Promise<void> => {
    const { maxFiles, skipGuard, contentMaxLines } = req.body || {};

    const container = getServiceContainer();
    const envelope = await executeDashboardOperation(
      container,
      req,
      DASHBOARD_OPERATION_IDS.bootstrapProject,
      { maxFiles, skipGuard, contentMaxLines }
    );
    sendDashboardOperationResponse(res, envelope);
  }
);

router.get('/bootstrap/report/latest', async (_req: Request, res: Response): Promise<void> => {
  const dataRoot = getModulesDataRoot();
  const report = await readJsonFile(path.join(dataRoot, '.asd', 'bootstrap-report.json'));
  res.json({ success: true, data: report });
});

router.get('/bootstrap/reports', async (_req: Request, res: Response): Promise<void> => {
  const dataRoot = getModulesDataRoot();
  const index = await readJsonFile(path.join(dataRoot, '.asd', 'bootstrap-reports', 'index.json'));
  const reports = Array.isArray(index?.reports)
    ? index.reports.filter((entry) => typeof entry.sessionId === 'string' && entry.sessionId)
    : [];
  res.json({ success: true, data: { ...(index || {}), reports } });
});

router.get(
  '/bootstrap/reports/:sessionId/diff',
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = singleParam(req.params.sessionId);
    const base = typeof req.query.base === 'string' ? req.query.base : '';
    if (!isSafeReportId(sessionId) || !isSafeReportId(base)) {
      return void res.status(400).json({ success: false, error: 'Invalid report id' });
    }
    const dataRoot = getModulesDataRoot();
    const current = await readBootstrapHistoryReport(dataRoot, sessionId);
    const baseline = await readBootstrapHistoryReport(dataRoot, base);
    if (!current || !baseline) {
      return void res.status(404).json({ success: false, error: 'Report not found' });
    }
    res.json({ success: true, data: diffBootstrapReports(current, baseline) });
  }
);

router.get(
  '/bootstrap/reports/:sessionId/artifacts/:artifactId',
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = singleParam(req.params.sessionId);
    const artifactId = singleParam(req.params.artifactId);
    if (!isSafeReportId(sessionId) || !isSafeReportId(artifactId)) {
      return void res.status(400).json({ success: false, error: 'Invalid artifact id' });
    }
    const dataRoot = getModulesDataRoot();
    const artifactRoot = path.join(dataRoot, '.asd', 'bootstrap-reports', 'artifacts', sessionId);
    const artifactPath = path.join(artifactRoot, artifactId);
    if (!artifactPath.startsWith(artifactRoot + path.sep)) {
      return void res.status(400).json({ success: false, error: 'Invalid artifact path' });
    }
    try {
      const content = await fs.readFile(artifactPath, 'utf8');
      res.type('text/plain').send(content);
    } catch {
      res.status(404).json({ success: false, error: 'Artifact not found' });
    }
  }
);

router.get('/bootstrap/reports/:sessionId', async (req: Request, res: Response): Promise<void> => {
  const sessionId = singleParam(req.params.sessionId);
  if (!isSafeReportId(sessionId)) {
    return void res.status(400).json({ success: false, error: 'Invalid report id' });
  }
  const dataRoot = getModulesDataRoot();
  const report = await readBootstrapHistoryReport(dataRoot, sessionId);
  if (!report) {
    return void res.status(404).json({ success: false, error: 'Report not found' });
  }
  res.json({ success: true, data: report });
});

/**
 * GET /api/v1/modules/bootstrap/status
 * 查询 bootstrap 异步填充进度
 */
router.get('/bootstrap/status', async (req: Request, res: Response): Promise<void> => {
  const container = getServiceContainer();

  let taskManager: { getSessionStatus(): Record<string, unknown> } | null = null;
  try {
    taskManager = container.get('bootstrapTaskManager');
  } catch {
    /* not registered */
  }
  if (!taskManager) {
    return void res.json({
      success: true,
      data: { status: 'idle', message: 'No bootstrap task manager initialized' },
    });
  }

  const { getTestModeConfig } = await import('#shared/test-mode.js');
  const sessionStatus = taskManager.getSessionStatus();
  const testMode = getTestModeConfig();
  const includeTestMode = testMode.enabled;
  res.json({
    success: true,
    data: { ...sessionStatus, ...(includeTestMode ? { testMode } : {}) },
  });
});

/**
 * GET /api/v1/modules/test-mode
 * 返回当前测试模式配置（前端 Header 持久展示测试标识）
 */
router.get('/test-mode', async (_req: Request, res: Response): Promise<void> => {
  const { getTestModeConfig } = await import('#shared/test-mode.js');
  const cfg = getTestModeConfig();
  res.json({ success: true, data: cfg });
});

/**
 * POST /api/v1/modules/bootstrap/cancel
 * 取消正在运行的 bootstrap / rescan 异步填充会话
 */
router.post('/bootstrap/cancel', async (req: Request, res: Response): Promise<void> => {
  const container = getServiceContainer();
  const reason =
    ((req.body as Record<string, unknown>)?.reason as string) || 'Cancelled by user via Dashboard';
  const envelope = await executeDashboardOperation(
    container,
    req,
    DASHBOARD_OPERATION_IDS.cancelBootstrap,
    { reason }
  );
  sendDashboardOperationResponse(res, envelope);
});

/**
 * POST /api/v1/modules/rescan
 * 增量扫描：保留已有 Recipe，重新分析项目，补齐缺失知识
 * 使用内部 Agent pipeline 自动完成知识补齐
 */
router.post(
  '/rescan',
  validate(ModuleRescanBody),
  async (req: Request, res: Response): Promise<void> => {
    const { reason, dimensions } = req.body || {};

    const container = getServiceContainer();
    const envelope = await executeDashboardOperation(
      container,
      req,
      DASHBOARD_OPERATION_IDS.rescanProject,
      { reason, dimensions }
    );
    sendDashboardOperationResponse(res, envelope);
  }
);

function getModulesDataRoot() {
  const container = getServiceContainer();
  return resolveDataRoot(container as { singletons?: Record<string, unknown> }) || process.cwd();
}

function singleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

async function readBootstrapHistoryReport(dataRoot: string, sessionId: string) {
  return readJsonFile(path.join(dataRoot, '.asd', 'bootstrap-reports', `${sessionId}.json`));
}

async function readJsonFile(filePath: string) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isSafeReportId(value: string) {
  return value.length > 0 && SAFE_REPORT_ID.test(value);
}

function diffBootstrapReports(current: Record<string, unknown>, baseline: Record<string, unknown>) {
  return {
    sessionId: (current.session as { id?: unknown } | undefined)?.id || null,
    baseSessionId: (baseline.session as { id?: unknown } | undefined)?.id || null,
    duration: diffNumber(current, baseline, ['duration', 'totalMs']),
    candidates: diffNumber(current, baseline, ['totals', 'candidates']),
    toolCalls: diffNumber(current, baseline, ['toolUsage', 'total']),
    terminal: {
      enabled: getNested(current, ['terminal', 'enabled']) === true,
      baseEnabled: getNested(baseline, ['terminal', 'enabled']) === true,
      successRate: diffNumber(current, baseline, ['terminal', 'successRate']),
      blocked: diffNumber(current, baseline, ['terminal', 'blocked']),
    },
  };
}

function diffNumber(
  current: Record<string, unknown>,
  baseline: Record<string, unknown>,
  pathKeys: string[]
) {
  const currentValue = Number(getNested(current, pathKeys) || 0);
  const baselineValue = Number(getNested(baseline, pathKeys) || 0);
  return { current: currentValue, base: baselineValue, delta: currentValue - baselineValue };
}

function getNested(input: Record<string, unknown>, pathKeys: string[]) {
  let current: unknown = input;
  for (const key of pathKeys) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export default router;

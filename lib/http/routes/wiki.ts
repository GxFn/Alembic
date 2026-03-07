/**
 * Wiki API 路由
 *
 * 提供 Repo Wiki 的生成、查询、更新操作。
 * 支持异步生成 + Socket.io 进度推送。
 *
 * 端点:
 *   POST   /api/v1/wiki/generate       — 触发全量生成
 *   POST   /api/v1/wiki/update          — 增量更新
 *   POST   /api/v1/wiki/abort           — 中止生成
 *   GET    /api/v1/wiki/status          — 获取 Wiki 状态
 *   GET    /api/v1/wiki/files           — 列出 Wiki 文件
 *   GET    /api/v1/wiki/file/:path      — 读取某个 Wiki 文件内容
 */

import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import {
  type WikiAiProvider,
  WikiGenerator,
  type WikiKnowledgeService,
  type WikiModuleService,
  type WikiProjectGraph,
} from '../../service/wiki/WikiGenerator.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();
const logger = Logger.getInstance();

/* ═══ 进程内 Wiki 任务状态 ═══════════════════════════════ */

let wikiTask: Record<string, any> = {
  status: 'idle', // idle | running | done | error
  phase: null,
  progress: 0,
  message: null,
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
};

/** @type {WikiGenerator|null} */
let currentGenerator: WikiGenerator | null = null;

function resetWikiTask() {
  wikiTask = {
    status: 'idle',
    phase: null,
    progress: 0,
    message: null,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  };
  currentGenerator = null;
}

/**
 * 外部读取 wikiTask 状态（供 bootstrap orchestrator 等外部流程同步使用）
 * @returns {typeof wikiTask}
 */
export function getWikiTask() {
  return wikiTask;
}

/**
 * 外部设置 wikiTask 状态（供 bootstrap orchestrator 等外部流程同步使用）
 * @param {Partial<typeof wikiTask>} patch
 */
export function patchWikiTask(patch: Record<string, unknown>) {
  Object.assign(wikiTask, patch);
}

/**
 * 创建 WikiGenerator 实例
 */
function createGenerator(container: ReturnType<typeof getServiceContainer>) {
  const projectRoot =
    (container.singletons?._projectRoot as string | undefined) ||
    process.env.ASD_PROJECT_DIR ||
    process.cwd();

  // 尝试获取可用的服务（非必须的优雅降级）
  let moduleService: unknown = null;
  let knowledgeService: unknown = null;
  let codeEntityGraph: unknown = null;

  try {
    moduleService = container.get('moduleService');
  } catch {
    /* ok */
  }
  try {
    knowledgeService = container.get('knowledgeService');
  } catch {
    /* ok */
  }
  try {
    codeEntityGraph = container.get('codeEntityGraph');
  } catch {
    /* ok */
  }

  // 尝试获取已缓存的 ProjectGraph（可能在 bootstrap 中构建过）
  const projectGraph = (container.singletons?.projectGraph || null) as Record<
    string,
    unknown
  > | null;

  // 获取 RealtimeService 用于推送进度
  let realtimeService: { broadcastEvent?: (name: string, data: unknown) => void } | null = null;
  try {
    realtimeService = container.singletons?.realtimeService || null;
  } catch {
    /* ok */
  }

  const generator = new WikiGenerator({
    projectRoot,
    moduleService: moduleService as WikiModuleService | null,
    knowledgeService: knowledgeService as WikiKnowledgeService | null,
    projectGraph: projectGraph as WikiProjectGraph | null,
    codeEntityGraph: codeEntityGraph as Record<string, unknown> | null,
    aiProvider: (container.singletons?.aiProvider || null) as WikiAiProvider | null,
    onProgress: (phase: string, progress: number, message: string) => {
      wikiTask.phase = phase;
      wikiTask.progress = progress;
      wikiTask.message = message;

      // 通过 Socket.io 推送进度
      if (realtimeService) {
        try {
          realtimeService.broadcastEvent?.('wiki:progress', {
            phase,
            progress,
            message,
            timestamp: Date.now(),
          });
        } catch {
          /* non-critical */
        }
      }
    },
    options: {
      language: process.env.ASD_WIKI_LANG || 'zh',
    },
  });

  return generator;
}

/* ═══ POST /api/v1/wiki/generate ═══════════════════════ */

router.post(
  '/generate',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    if (wikiTask.status === 'running') {
      return void res.status(409).json({
        success: false,
        error: { code: 'ALREADY_RUNNING', message: 'Wiki 生成正在进行中' },
        data: { progress: wikiTask.progress, phase: wikiTask.phase },
      }) as unknown as void;
    }

    const container = getServiceContainer();
    resetWikiTask();

    wikiTask.status = 'running';
    wikiTask.startedAt = Date.now();

    const generator = createGenerator(container);
    currentGenerator = generator;

    // 异步执行，立即返回 202
    res.status(202).json({
      success: true,
      message: 'Wiki 生成已启动，通过 /api/v1/wiki/status 或 Socket.io wiki:progress 事件追踪进度',
    });

    // 后台执行生成
    try {
      const result = (await generator.generate()) as {
        success: boolean;
        error?: string;
        filesGenerated?: number;
        duration?: number;
        [key: string]: unknown;
      };
      wikiTask.status = result.success ? 'done' : 'error';
      wikiTask.finishedAt = Date.now();
      wikiTask.result = result;
      if (!result.success) {
        wikiTask.error = result.error;
      }

      // 推送完成事件
      const realtimeService = (container.singletons?.realtimeService || null) as {
        broadcastEvent?: (name: string, data: unknown) => void;
      } | null;
      if (realtimeService) {
        realtimeService.broadcastEvent?.('wiki:completed', {
          success: result.success,
          filesGenerated: result.filesGenerated,
          duration: result.duration,
        });
      }
    } catch (err: unknown) {
      wikiTask.status = 'error';
      wikiTask.finishedAt = Date.now();
      wikiTask.error = (err as Error).message;
      logger.error('[Wiki Route] Generation failed', { error: (err as Error).message });
    }

    currentGenerator = null;
  })
);

/* ═══ POST /api/v1/wiki/update ═══════════════════════ */

router.post(
  '/update',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    if (wikiTask.status === 'running') {
      return void res.status(409).json({
        success: false,
        error: { code: 'ALREADY_RUNNING', message: 'Wiki 生成正在进行中' },
      }) as unknown as void;
    }

    const container = getServiceContainer();
    resetWikiTask();

    wikiTask.status = 'running';
    wikiTask.startedAt = Date.now();

    const generator = createGenerator(container);
    currentGenerator = generator;

    res.status(202).json({
      success: true,
      message: 'Wiki 增量更新已启动',
    });

    try {
      const result = (await generator.update()) as { success: boolean; error?: string };
      wikiTask.status = result.success ? 'done' : 'error';
      wikiTask.finishedAt = Date.now();
      wikiTask.result = result;
      if (!result.success) {
        wikiTask.error = result.error;
      }
    } catch (err: unknown) {
      wikiTask.status = 'error';
      wikiTask.finishedAt = Date.now();
      wikiTask.error = (err as Error).message;
    }

    currentGenerator = null;
  })
);

/* ═══ POST /api/v1/wiki/abort ═══════════════════════ */

router.post(
  '/abort',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    if (wikiTask.status !== 'running' || !currentGenerator) {
      return void res.json({ success: true, message: '没有正在运行的 Wiki 任务' });
    }

    currentGenerator.abort();
    wikiTask.status = 'error';
    wikiTask.error = 'Aborted by user';
    wikiTask.finishedAt = Date.now();

    res.json({ success: true, message: 'Wiki 生成已中止' });
  })
);

/* ═══ GET /api/v1/wiki/status ═══════════════════════ */

router.get(
  '/status',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const container = getServiceContainer();

    // 如果没有活跃任务，从磁盘读取元数据
    if (wikiTask.status === 'idle') {
      const generator = createGenerator(container);
      const diskStatus = generator.getStatus();
      return void res.json({
        success: true,
        data: {
          task: wikiTask,
          wiki: diskStatus,
        },
      });
    }

    res.json({
      success: true,
      data: {
        task: { ...wikiTask },
      },
    });
  })
);

/* ═══ GET /api/v1/wiki/files ═══════════════════════ */

router.get(
  '/files',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();
    const wikiDir = path.join(projectRoot, 'AutoSnippet', 'wiki');

    if (!fs.existsSync(wikiDir)) {
      return void res.json({
        success: true,
        data: { files: [], exists: false },
      }) as unknown as void;
    }

    const files: { path: string; name: string; size: number; modifiedAt: string }[] = [];
    const readDir = (dir: string, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          readDir(path.join(dir, entry.name), rel);
        } else if (entry.name.endsWith('.md')) {
          const stat = fs.statSync(path.join(dir, entry.name));
          files.push({
            path: rel,
            name: entry.name,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        }
      }
    };

    readDir(wikiDir);

    res.json({
      success: true,
      data: { files, exists: true, wikiDir },
    });
  })
);

/* ═══ GET /api/v1/wiki/file/:path(*) ═══════════════ */

router.get(
  '/file/*',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();
    const wikiDir = path.join(projectRoot, 'AutoSnippet', 'wiki');
    const requestedPath = req.params[0];

    if (!requestedPath) {
      return void res.status(400).json({ success: false, error: { message: 'path required' } });
    }

    // 安全检查：防止路径穿越
    const fullPath = path.resolve(wikiDir, requestedPath);
    if (!fullPath.startsWith(wikiDir)) {
      return void res
        .status(403)
        .json({ success: false, error: { message: 'Path traversal not allowed' } });
    }

    if (!fs.existsSync(fullPath)) {
      return void res.status(404).json({ success: false, error: { message: 'File not found' } });
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    res.json({
      success: true,
      data: {
        path: requestedPath,
        content,
        size: Buffer.byteLength(content),
      },
    });
  })
);

export default router;

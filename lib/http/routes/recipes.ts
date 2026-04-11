/**
 * Recipes API 路由
 * 提供 Recipe 知识图谱关系发现等操作
 *
 * 说明: Recipe 的 CRUD 已由 knowledge.js 统一提供，
 * 此路由仅处理 Recipe 特有的批量 AI 操作。
 */

import express, { type Request, type Response } from 'express';
import { COUNTABLE_LIFECYCLES } from '../../domain/knowledge/Lifecycle.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';

const router = express.Router();
const logger = Logger.getInstance();

/* ═══ 进程内任务状态（单实例足够） ═══════════════════════ */

let discoverTask: Record<string, any> = {
  status: 'idle', // idle | running | done | error
  startedAt: null,
  finishedAt: null,
  discovered: 0,
  totalPairs: 0,
  batchErrors: 0,
  error: null,
  elapsed: 0,
  message: null,
};

function resetTask() {
  discoverTask = {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    discovered: 0,
    totalPairs: 0,
    batchErrors: 0,
    error: null,
    elapsed: 0,
    message: null,
  };
}

/* ═══ POST /api/v1/recipes/discover-relations ═══════════ */

/**
 * 异步启动 AI 批量发现 Recipe 知识图谱关系
 * Body: { batchSize?: number }
 *
 * 立即返回 { status: 'started' }，后台执行。
 * Dashboard 通过 GET /discover-relations/status 轮询进度。
 */
router.post('/discover-relations', async (req: Request, res: Response): Promise<void> => {
  const { batchSize: _batchSize = 20 } = req.body;

  // 如果已有任务在运行，返回当前状态
  if (discoverTask.status === 'running') {
    const elapsed = Math.round((Date.now() - new Date(discoverTask.startedAt).getTime()) / 1000);
    return void res.json({
      success: true,
      data: {
        status: 'running',
        startedAt: discoverTask.startedAt,
        elapsed,
        message: 'AI 分析仍在进行中',
      },
    });
  }

  // 检查 ToolRegistry 是否可用
  const container = getServiceContainer();
  let agentFactory: import('../../agent/AgentFactory.js').AgentFactory;
  try {
    agentFactory = container.get('agentFactory');
  } catch {
    return void res.json({
      success: true,
      data: { status: 'error', error: 'AgentFactory 不可用，请检查 AI Provider 配置' },
    });
  }

  // Mock 模式下跳过 AI 关系发现
  if (agentFactory.getAiProviderInfo?.()?.name === 'mock') {
    return void res.json({
      success: true,
      data: { status: 'error', error: 'AI Provider 未配置，当前为 Mock 模式。请先配置 API Key。' },
    });
  }

  // 快速检查：至少需要 2 条可消费 Recipe（active/staging/pending/evolving）
  try {
    const knowledgeRepo = container.get('knowledgeRepository') as {
      countByLifecycles(lifecycles: readonly string[]): Promise<number>;
    };
    const count = await knowledgeRepo.countByLifecycles(COUNTABLE_LIFECYCLES);
    if (count < 2) {
      return void res.json({
        success: true,
        data: {
          status: 'empty',
          message: `只有 ${count} 条活跃 Recipe，至少需要 2 条才能分析关系`,
        },
      });
    }
  } catch {
    // 如果查询失败，继续尝试（让 runTask 给出具体错误）
  }

  // 重置并启动后台任务
  resetTask();
  discoverTask.status = 'running';
  discoverTask.startedAt = new Date().toISOString();

  // 异步执行，不 await
  (async () => {
    try {
      const result = await agentFactory.discoverRelations();
      discoverTask.status = 'done';
      discoverTask.finishedAt = new Date().toISOString();
      discoverTask.discovered = result.discovered || 0;
      discoverTask.totalPairs = result.totalPairs || 0;
      discoverTask.batchErrors = result.batchErrors || 0;
      discoverTask.elapsed = Math.round(
        (new Date(discoverTask.finishedAt).getTime() - new Date(discoverTask.startedAt).getTime()) /
          1000
      );
      logger.info('Discover relations completed', {
        discovered: discoverTask.discovered,
        totalPairs: discoverTask.totalPairs,
        batchErrors: discoverTask.batchErrors,
        elapsed: discoverTask.elapsed,
      });
    } catch (err: unknown) {
      discoverTask.status = 'error';
      discoverTask.finishedAt = new Date().toISOString();
      discoverTask.error = (err as Error).message;
      discoverTask.elapsed = Math.round(
        (new Date(discoverTask.finishedAt).getTime() - new Date(discoverTask.startedAt).getTime()) /
          1000
      );
      logger.error('Discover relations failed', { error: (err as Error).message });
    }
  })();

  res.json({
    success: true,
    data: {
      status: 'started',
      startedAt: discoverTask.startedAt,
      message: 'AI 分析已启动，正在后台运行',
    },
  });
});

/* ═══ GET /api/v1/recipes/discover-relations/status ═════ */

/** 查询关系发现任务状态 */
router.get('/discover-relations/status', async (req: Request, res: Response) => {
  const data = { ...discoverTask };

  // 计算实时 elapsed
  if (data.status === 'running' && data.startedAt) {
    data.elapsed = Math.round((Date.now() - new Date(data.startedAt).getTime()) / 1000);
  }

  res.json({ success: true, data });
});

export default router;

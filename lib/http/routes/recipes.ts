/**
 * Recipes API 路由
 * 提供 Recipe 知识图谱关系发现等操作
 *
 * 说明: Recipe 的 CRUD 已由 knowledge.js 统一提供，
 * 此路由仅处理 Recipe 特有的批量 AI 操作。
 */

import express from 'express';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();
const logger = Logger.getInstance();

/* ═══ 进程内任务状态（单实例足够） ═══════════════════════ */

let discoverTask = {
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
router.post(
  '/discover-relations',
  asyncHandler(async (req, res) => {
    const { batchSize: _batchSize = 20 } = req.body;

    // 如果已有任务在运行，返回当前状态
    if (discoverTask.status === 'running') {
      const elapsed = Math.round((Date.now() - new Date(discoverTask.startedAt).getTime()) / 1000);
      return res.json({
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
    let agentFactory;
    try {
      agentFactory = container.get('agentFactory');
    } catch {
      return res.json({
        success: true,
        data: { status: 'error', error: 'AgentFactory 不可用，请检查 AI Provider 配置' },
      });
    }

    // 快速检查：至少需要 2 条活跃 Recipe
    try {
      const knowledgeService = container.get('knowledgeService');
      const { items = [], data = [] } = await knowledgeService.list(
        { lifecycle: 'active' },
        { page: 1, pageSize: 5 }
      );
      const count = items.length || data.length;
      if (count < 2) {
        return res.json({
          success: true,
          data: {
            status: 'empty',
            message: `只有 ${count} 条活跃 Recipe，至少需要 2 条才能分析关系`,
          },
        });
      }
    } catch {
      // 如果 list 失败，继续尝试（让 runTask 给出具体错误）
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
          (new Date(discoverTask.finishedAt).getTime() -
            new Date(discoverTask.startedAt).getTime()) /
            1000
        );
        logger.info('Discover relations completed', {
          discovered: discoverTask.discovered,
          totalPairs: discoverTask.totalPairs,
          batchErrors: discoverTask.batchErrors,
          elapsed: discoverTask.elapsed,
        });
      } catch (err: any) {
        discoverTask.status = 'error';
        discoverTask.finishedAt = new Date().toISOString();
        discoverTask.error = err.message;
        discoverTask.elapsed = Math.round(
          (new Date(discoverTask.finishedAt).getTime() -
            new Date(discoverTask.startedAt).getTime()) /
            1000
        );
        logger.error('Discover relations failed', { error: err.message });
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
  })
);

/* ═══ GET /api/v1/recipes/discover-relations/status ═════ */

/**
 * 查询关系发现任务状态
 */
router.get(
  '/discover-relations/status',
  asyncHandler(async (req, res) => {
    const data = { ...discoverTask };

    // 计算实时 elapsed
    if (data.status === 'running' && data.startedAt) {
      data.elapsed = Math.round((Date.now() - new Date(data.startedAt).getTime()) / 1000);
    }

    res.json({ success: true, data });
  })
);

export default router;

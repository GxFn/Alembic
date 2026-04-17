/**
 * file-changes.ts — 文件变更事件接收路由（领域无关）
 *
 * POST /api/v1/file-changes
 *
 * 接收 FileChangeCollector 推送的事件，交由 FileChangeDispatcher 分发。
 * 不直接依赖任何业务服务（如 ReactiveEvolutionService）。
 *
 * @module http/routes/file-changes
 */

import express, { type Request, type Response } from 'express';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import type { FileChangeDispatcher } from '../../service/FileChangeDispatcher.js';
import type { FileChangeEvent } from '../../types/reactive-evolution.js';

const router = express.Router();
const logger = Logger.getInstance();

const VALID_TYPES = new Set(['created', 'renamed', 'deleted', 'modified']);

/**
 * POST /api/v1/file-changes
 *
 * Body: { events: FileChangeEvent[] }
 *
 * 返回: { success: true } — 火即忘，不返回业务数据
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { events } = req.body as { events?: unknown };

    if (!Array.isArray(events) || events.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'events must be a non-empty array' },
      });
      return;
    }

    const validEvents: FileChangeEvent[] = [];

    for (const event of events) {
      if (
        typeof event !== 'object' ||
        event === null ||
        !VALID_TYPES.has((event as Record<string, unknown>).type as string) ||
        typeof (event as Record<string, unknown>).path !== 'string'
      ) {
        continue;
      }
      validEvents.push(event as FileChangeEvent);
    }

    if (validEvents.length === 0) {
      res.json({ success: true });
      return;
    }

    const container = getServiceContainer();
    const dispatcher = container.get('fileChangeDispatcher') as FileChangeDispatcher;

    // 非阻塞分发：立即响应，后台处理
    dispatcher.dispatch(validEvents).catch((err: unknown) => {
      logger.warn('[file-changes] dispatch error', {
        error: (err as Error).message,
      });
    });

    logger.info('[file-changes] received', {
      total: events.length,
      valid: validEvents.length,
    });

    res.json({ success: true });
  } catch (err: unknown) {
    logger.warn('[file-changes] error', {
      error: (err as Error).message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

export default router;

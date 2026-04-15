/**
 * evolution.ts — 文件变更事件路由
 *
 * POST /api/v1/evolution/file-changed
 *   接收 VSCode 扩展发送的文件变更事件，
 *   驱动 ReactiveEvolutionService 自动修复或弃用 Recipe。
 *
 * @module http/routes/evolution
 */

import express, { type Request, type Response } from 'express';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import type { ReactiveEvolutionService } from '../../service/evolution/ReactiveEvolutionService.js';
import type { FileChangeEvent } from '../../types/reactive-evolution.js';

const router = express.Router();
const logger = Logger.getInstance();

/**
 * POST /api/v1/evolution/file-changed
 *
 * Body: { events: FileChangeEvent[] }
 *
 * 返回: { success, data: ReactiveEvolutionReport }
 */
router.post('/file-changed', async (req: Request, res: Response) => {
  try {
    const { events } = req.body as { events?: unknown };

    // ── 参数校验 ──
    if (!Array.isArray(events) || events.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'events must be a non-empty array' },
      });
      return;
    }

    // 校验每个事件的基本结构
    const validTypes = new Set(['renamed', 'deleted', 'modified']);
    const validEvents: FileChangeEvent[] = [];

    for (const event of events) {
      if (
        typeof event !== 'object' ||
        event === null ||
        !validTypes.has((event as Record<string, unknown>).type as string) ||
        typeof (event as Record<string, unknown>).oldPath !== 'string'
      ) {
        continue; // 跳过格式无效的事件
      }
      validEvents.push(event as FileChangeEvent);
    }

    if (validEvents.length === 0) {
      res.json({ success: true, data: { fixed: 0, deprecated: 0, skipped: 0, details: [] } });
      return;
    }

    // ── 执行 ──
    const container = getServiceContainer();
    const service = container.get('reactiveEvolutionService') as ReactiveEvolutionService;

    const report = await service.handleFileChanges(validEvents);

    logger.info('[evolution/file-changed] processed', {
      eventsReceived: events.length,
      valid: validEvents.length,
      fixed: report.fixed,
      deprecated: report.deprecated,
    });

    res.json({ success: true, data: report });
  } catch (err: unknown) {
    logger.warn('[evolution/file-changed] error', {
      error: (err as Error).message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

export default router;

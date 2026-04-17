/**
 * file-changes.ts — 文件变更事件接收路由（领域无关）
 *
 * POST /api/v1/file-changes
 *
 * 接收 FileChangeCollector 推送的事件，交由 FileChangeDispatcher 分发。
 * 不直接依赖任何业务服务（如 ReactiveEvolutionService）。
 *
 * 响应体回传 {@link ReactiveEvolutionReport}（文档 §5.1 I1）——
 * 订阅者处理毫秒级，VSCode 扩展据此决定是否弹窗。
 *
 * @module http/routes/file-changes
 */

import express, { type Request, type Response } from 'express';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import type { FileChangeDispatcher } from '../../service/FileChangeDispatcher.js';
import type { FileChangeEvent, FileChangeEventSource } from '../../types/reactive-evolution.js';

const router = express.Router();
const logger = Logger.getInstance();

const VALID_TYPES = new Set(['created', 'renamed', 'deleted', 'modified']);
const VALID_SOURCES = new Set<FileChangeEventSource>(['ide-edit', 'git-head', 'git-worktree']);

/**
 * POST /api/v1/file-changes
 *
 * Body: { events: FileChangeEvent[] }
 *
 * 返回:
 *   200 { success: true, data: ReactiveEvolutionReport }  — 正常分发
 *   200 { success: true, data: { empty report } }          — 事件全被过滤
 *   400 { success: false, error }                         — 入参非法
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
      const obj = event as Record<string, unknown>;
      const normalized: FileChangeEvent = {
        type: obj.type as FileChangeEvent['type'],
        path: obj.path as string,
      };
      if (typeof obj.oldPath === 'string') {
        normalized.oldPath = obj.oldPath;
      }
      // 向后兼容：旧版客户端不传 eventSource，服务端透传 undefined，由 Dispatcher 统计推断
      if (
        typeof obj.eventSource === 'string' &&
        VALID_SOURCES.has(obj.eventSource as FileChangeEventSource)
      ) {
        normalized.eventSource = obj.eventSource as FileChangeEventSource;
      }
      validEvents.push(normalized);
    }

    if (validEvents.length === 0) {
      res.json({
        success: true,
        data: {
          fixed: 0,
          deprecated: 0,
          skipped: 0,
          needsReview: 0,
          suggestReview: false,
          details: [],
        },
      });
      return;
    }

    const container = getServiceContainer();
    const dispatcher = container.get('fileChangeDispatcher') as FileChangeDispatcher;

    // 同步分发 — FileChangeHandler 是纯代码路径毫秒级（文档 §5.1 备注）
    let report;
    try {
      report = await dispatcher.dispatch(validEvents);
    } catch (err: unknown) {
      logger.warn('[file-changes] dispatch error', { error: (err as Error).message });
      report = {
        fixed: 0,
        deprecated: 0,
        skipped: 0,
        needsReview: 0,
        suggestReview: false,
        details: [],
      };
    }

    logger.info('[file-changes] handled', {
      total: events.length,
      valid: validEvents.length,
      needsReview: report.needsReview,
      eventSource: report.eventSource,
    });

    res.json({ success: true, data: report });
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

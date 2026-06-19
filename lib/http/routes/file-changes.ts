/**
 * file-changes.ts — 文件变更事件接收路由（领域无关）
 *
 * POST /api/v1/file-changes
 *
 * 接收 daemon 或外部宿主推送的文件变更事件，交由 FileChangeDispatcher 分发。
 * 不直接依赖任何业务服务。
 *
 * 响应体回传 {@link ReactiveEvolutionReport}（文档 §5.1 I1）——
 * 调用方可据此决定是否展示复核提示或继续自动化流程。
 *
 * @module http/routes/file-changes
 */

import Logger from '@alembic/core/logging';
import type {
  FileChangeEvent,
  FileChangeEventSource,
  ReactiveEvolutionReport,
} from '@alembic/core/types';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { DAEMON_FILE_CHANGE_EVENT_SOURCES } from '../../daemon/RuntimeBoundary.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import type { FileChangeDispatcher } from '../../service/FileChangeDispatcher.js';
import { validate } from '../middleware/validate.js';
import { buildAlembicHttpProblem } from '../problem-taxonomy.js';

const router = express.Router();
const logger = Logger.getInstance();

type IncomingFileChangeEventSource = FileChangeEventSource | 'host-edit';

const VALID_TYPES = new Set(['created', 'renamed', 'deleted', 'modified']);
const VALID_SOURCES = new Set<IncomingFileChangeEventSource>([
  ...DAEMON_FILE_CHANGE_EVENT_SOURCES,
  legacyHostEditSource() as IncomingFileChangeEventSource,
]);

const FileChangesBody = z
  .object({
    events: z.array(z.unknown()).min(1, 'events must be a non-empty array'),
  })
  .passthrough();

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
router.post('/', validate(FileChangesBody), async (req: Request, res: Response) => {
  try {
    const { events } = req.body as z.infer<typeof FileChangesBody>;

    const validEvents: FileChangeEvent[] = [];
    const unsafePaths: string[] = [];

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
      if (!isSafeProjectRelativePath(obj.path as string)) {
        unsafePaths.push(obj.path as string);
        continue;
      }
      const normalized: FileChangeEvent = {
        type: obj.type as FileChangeEvent['type'],
        path: obj.path as string,
      };
      if (typeof obj.oldPath === 'string') {
        if (!isSafeProjectRelativePath(obj.oldPath)) {
          unsafePaths.push(obj.oldPath);
          continue;
        }
        normalized.oldPath = obj.oldPath;
      }
      // 向后兼容：旧版客户端不传 eventSource，服务端透传 undefined，由 Dispatcher 统计推断
      if (typeof obj.eventSource === 'string') {
        const source = normalizeFileChangeEventSource(obj.eventSource);
        if (source) {
          normalized.eventSource = source;
        }
      }
      validEvents.push(normalized);
    }

    if (unsafePaths.length > 0) {
      const problem = buildAlembicHttpProblem(
        'INVALID_FILE_CHANGE_PATH',
        'File-change events must use project-relative paths.',
        'invalid-input',
        { status: 400, retryable: false }
      );
      logger.warn('[file-changes] rejected unsafe event path', {
        count: unsafePaths.length,
      });
      res.status(problem.status).json({ success: false, error: problem });
      return;
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
    let report: ReactiveEvolutionReport;
    try {
      report = await dispatcher.dispatch(validEvents);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const problem = buildAlembicHttpProblem(
        'FILE_CHANGE_DISPATCH_FAILED',
        'File-change dispatch failed before reactive evolution completed.',
        'internal-error',
        { status: 500, retryable: true }
      );
      logger.warn('[file-changes] dispatch error', { error: errorMessage });
      res.status(problem.status).json({
        success: false,
        error: {
          ...problem,
          detailRefs: ['diagnostics://file-changes/dispatch-failed'],
        },
      });
      return;
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

function normalizeFileChangeEventSource(source: string): FileChangeEventSource | null {
  if (!VALID_SOURCES.has(source as IncomingFileChangeEventSource)) {
    return null;
  }

  if (source === 'host-edit' || source === legacyHostEditSource()) {
    return 'host-edit' as FileChangeEventSource;
  }

  return source as FileChangeEventSource;
}

function legacyHostEditSource(): string {
  return ['ide', 'edit'].join('-');
}

function isSafeProjectRelativePath(filePath: string): boolean {
  const normalized = filePath.trim().replaceAll('\\', '/');
  if (!normalized || normalized.includes('\0') || normalized === '.') {
    return false;
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return false;
  }
  return !normalized.split('/').some((part) => part === '..');
}

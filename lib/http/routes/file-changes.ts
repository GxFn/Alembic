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
import type { ScanRunRecord } from '../../repository/scan/ScanRunRepository.js';
import type { FileChangeDispatcher } from '../../service/FileChangeDispatcher.js';
import type { FileChangeEvent, ReactiveEvolutionReport } from '../../types/reactive-evolution.js';
import {
  ScanLifecycleRunner,
  ScanLifecycleServiceUnavailableError,
} from '../../workflows/scan/lifecycle/ScanLifecycleRunner.js';
import { normalizeFileChangeEvents } from '../../workflows/scan/normalization/ScanChangeSetNormalizer.js';
import {
  type FileChangesScanOptions,
  ScanRequestNormalizer,
} from '../../workflows/scan/normalization/ScanRequestNormalizer.js';
import type { IncrementalCorrectionResult } from '../../workflows/scan/ScanTypes.js';

const router = express.Router();
const logger = Logger.getInstance();

interface ServiceContainerLike {
  singletons?: Record<string, unknown>;
  get?: (name: string) => unknown;
}

type FileChangesScanResponse =
  | { success: true; data: IncrementalCorrectionResult; run: ScanRunRecord | null }
  | { success: false; error: { code: string; message: string }; run?: ScanRunRecord | null };

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
    const body = asRecord(req.body);
    const normalizedEvents = normalizeFileChangeEvents(body.events);

    if (!normalizedEvents.wasArray || normalizedEvents.inputCount === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'events must be a non-empty array' },
      });
      return;
    }

    const validEvents = normalizedEvents.events;

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

    const container = getServiceContainer() as ServiceContainerLike;
    const dispatcher = container.get?.('fileChangeDispatcher') as FileChangeDispatcher | undefined;
    if (!dispatcher) {
      throw new Error('fileChangeDispatcher unavailable');
    }

    // 同步分发 — FileChangeHandler 是纯代码路径毫秒级（文档 §5.1 备注）
    let report: ReactiveEvolutionReport;
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
      total: normalizedEvents.inputCount,
      valid: validEvents.length,
      needsReview: report.needsReview,
      eventSource: report.eventSource,
    });

    const response: Record<string, unknown> = { success: true, data: report };
    const scanOptions = readScanOptions(body.scan, body, container);
    if (scanOptions.enabled) {
      response.scan = await runIncrementalScan(container, validEvents, report, scanOptions);
    }

    res.json(response);
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

async function runIncrementalScan(
  container: ServiceContainerLike,
  events: FileChangeEvent[],
  reactiveReport: ReactiveEvolutionReport,
  options: FileChangesScanOptions
): Promise<FileChangesScanResponse> {
  try {
    const request = new ScanRequestNormalizer({
      defaultProjectRoot: readProjectRoot(container),
    }).toFileChangesLifecycleRequest(
      {
        enabled: true,
        projectRoot: options.projectRoot,
        runAgent: options.runAgent,
        depth: options.depth,
        budget: options.budget,
        primaryLang: options.primaryLang,
      },
      {},
      events,
      reactiveReport
    );
    if (!request) {
      throw new Error('file changes scan request was not enabled');
    }
    const { result, run } = await resolveScanLifecycleRunner(
      container
    ).run<IncrementalCorrectionResult>(request, {
      reason: 'HTTP file changes incremental scan',
    });
    return { success: true, data: result, run };
  } catch (err: unknown) {
    logger.warn('[file-changes] incremental scan failed', {
      error: toErrorMessage(err),
    });
    return {
      success: false,
      error: {
        code:
          err instanceof ScanLifecycleServiceUnavailableError
            ? 'SCAN_UNAVAILABLE'
            : 'SCAN_INCREMENTAL_ERROR',
        message: toErrorMessage(err),
      },
    };
  }
}

function resolveScanLifecycleRunner(container: ServiceContainerLike): ScanLifecycleRunner {
  const runner = container.get?.('scanLifecycleRunner') as ScanLifecycleRunner | undefined;
  return runner && typeof runner.runIncrementalCorrection === 'function'
    ? runner
    : ScanLifecycleRunner.fromContainer(container, logger);
}

function readScanOptions(
  value: unknown,
  body: Record<string, unknown>,
  container: ServiceContainerLike
): FileChangesScanOptions {
  return new ScanRequestNormalizer({
    defaultProjectRoot: readProjectRoot(container),
  }).toFileChangesScanOptions(value, body);
}

function readProjectRoot(container: ServiceContainerLike): string {
  return readString(container.singletons?._projectRoot) || process.cwd();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default router;

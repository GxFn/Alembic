/**
 * scan.ts — 扫描生命周期路由
 *
 * POST /api/v1/scan/plan                    只规划，不执行
 * POST /api/v1/scan/retrieve                只组装 evidence pack，不调用 Agent
 * POST /api/v1/scan/incremental-correction  增量修正；默认不调用 Agent
 * POST /api/v1/scan/deep-mining             深度挖掘；默认只检索，runAgent=true 才执行 Agent
 * POST /api/v1/scan/maintenance             日常维护扫描
 */

import express, { type Request, type Response } from 'express';
import Logger from '#infra/logging/Logger.js';
import { getServiceContainer } from '#inject/ServiceContainer.js';
import type { ScanEvidencePackRepository } from '#repo/scan/ScanEvidencePackRepository.js';
import type {
  ScanRecommendationRecord,
  ScanRecommendationRepository,
} from '#repo/scan/ScanRecommendationRepository.js';
import type { ScanRunRepository, ScanRunStatus } from '#repo/scan/ScanRunRepository.js';
import {
  ScanLifecycleBaselineRequiredError,
  ScanLifecycleRunner,
} from '#workflows/scan/lifecycle/ScanLifecycleRunner.js';
import { ScanRecommendationScheduler } from '#workflows/scan/lifecycle/ScanRecommendationScheduler.js';
import { normalizeFileChangeEvents } from '#workflows/scan/normalization/ScanChangeSetNormalizer.js';
import { ScanRequestNormalizer } from '#workflows/scan/normalization/ScanRequestNormalizer.js';
import type { KnowledgeRetrievalPipeline } from '#workflows/scan/retrieval/KnowledgeRetrievalPipeline.js';
import type { ScanJobQueue, ScanJobStatus } from '#workflows/scan/ScanJobQueue.js';
import type { ScanPlanService } from '#workflows/scan/ScanPlanService.js';
import type {
  ScanMode,
  ScanRecommendationStatus,
  ScanRecommendedRun,
} from '#workflows/scan/ScanTypes.js';

const router = express.Router();
const logger = Logger.getInstance();

const VALID_SCAN_MODES = new Set<ScanMode>([
  'cold-start',
  'deep-mining',
  'incremental-correction',
  'maintenance',
]);
const VALID_RUN_STATUSES = new Set<ScanRunStatus>(['running', 'completed', 'failed', 'cancelled']);
const VALID_RECOMMENDATION_STATUSES = new Set<ScanRecommendationStatus>([
  'pending',
  'queued',
  'dismissed',
  'executed',
]);
const VALID_JOB_STATUSES = new Set<ScanJobStatus>([
  'queued',
  'running',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
]);

router.get('/runs', (req: Request, res: Response): void => {
  try {
    const container = getServiceContainer();
    const runRepository = requireScanRunRepository(container);
    const runs = runRepository.find({
      projectRoot: readOptionalString(req.query.projectRoot),
      mode: readScanMode(req.query.mode),
      status: readRunStatus(req.query.status),
      limit: readPositiveInteger(req.query.limit, 50),
    });
    res.json({ success: true, data: runs });
  } catch (err: unknown) {
    respondError(res, 'SCAN_RUNS_ERROR', err);
  }
});

router.get('/runs/:id', (req: Request, res: Response): void => {
  try {
    const container = getServiceContainer();
    const runRepository = requireScanRunRepository(container);
    const run = runRepository.findById(String(req.params.id));
    if (!run) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Scan run not found' },
      });
      return;
    }
    res.json({ success: true, data: run });
  } catch (err: unknown) {
    respondError(res, 'SCAN_RUN_ERROR', err);
  }
});

router.get('/runs/:id/evidence', (req: Request, res: Response): void => {
  try {
    const container = getServiceContainer();
    const runRepository = requireScanRunRepository(container);
    const runId = String(req.params.id);
    const run = runRepository.findById(runId);
    if (!run) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Scan run not found' },
      });
      return;
    }
    const evidenceRepository = requireScanEvidencePackRepository(container);
    const packs = evidenceRepository.findByRunId(runId);
    res.json({ success: true, data: packs });
  } catch (err: unknown) {
    respondError(res, 'SCAN_EVIDENCE_ERROR', err);
  }
});

router.get('/jobs', (req: Request, res: Response): void => {
  try {
    const container = getServiceContainer();
    const queue = requireScanJobQueue(container);
    const jobs = queue.list({
      mode: readScanMode(req.query.mode),
      status: readJobStatus(req.query.status),
      limit: readPositiveInteger(req.query.limit, 50),
    });
    res.json({ success: true, data: jobs, stats: queue.stats() });
  } catch (err: unknown) {
    respondError(res, 'SCAN_JOBS_ERROR', err);
  }
});

router.get('/jobs/:id', (req: Request, res: Response): void => {
  try {
    const container = getServiceContainer();
    const queue = requireScanJobQueue(container);
    const job = queue.get(String(req.params.id));
    if (!job) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Scan job not found' },
      });
      return;
    }
    res.json({ success: true, data: job });
  } catch (err: unknown) {
    respondError(res, 'SCAN_JOB_ERROR', err);
  }
});

router.post('/jobs/:id/cancel', (req: Request, res: Response): void => {
  try {
    const container = getServiceContainer();
    const queue = requireScanJobQueue(container);
    const reason = readOptionalString(asRecord(req.body).reason) ?? 'Cancelled by user';
    const job = queue.cancel(String(req.params.id), reason);
    if (!job) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Scan job not found' },
      });
      return;
    }
    res.json({ success: true, data: job });
  } catch (err: unknown) {
    respondError(res, 'SCAN_JOB_CANCEL_ERROR', err);
  }
});

router.post('/jobs/:id/retry', (req: Request, res: Response): void => {
  try {
    const container = getServiceContainer();
    const queue = requireScanJobQueue(container);
    const body = asRecord(req.body);
    const job = queue.retry(
      String(req.params.id),
      body.maxAttempts === undefined ? undefined : readPositiveInteger(body.maxAttempts, 1)
    );
    if (!job) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Scan job not found' },
      });
      return;
    }
    res.json({ success: true, data: job });
  } catch (err: unknown) {
    respondError(res, 'SCAN_JOB_RETRY_ERROR', err);
  }
});

router.get('/recommendations', (req: Request, res: Response): void => {
  try {
    const container = getServiceContainer();
    const repository = requireScanRecommendationRepository(container);
    const filter: Parameters<typeof repository.find>[0] = {
      limit: readPositiveInteger(req.query.limit, 50),
    };
    const projectRoot = readOptionalString(req.query.projectRoot);
    const sourceRunId = readOptionalString(req.query.sourceRunId);
    const mode = readRecommendationMode(req.query.mode);
    const status = readRecommendationStatus(req.query.status);
    if (projectRoot) {
      filter.projectRoot = projectRoot;
    }
    if (sourceRunId) {
      filter.sourceRunId = sourceRunId;
    }
    if (mode) {
      filter.mode = mode;
    }
    if (status) {
      filter.status = status;
    }
    res.json({ success: true, data: repository.find(filter) });
  } catch (err: unknown) {
    respondError(res, 'SCAN_RECOMMENDATIONS_ERROR', err);
  }
});

router.post('/recommendations/:id/queue', (req: Request, res: Response): void => {
  try {
    const container = getServiceContainer();
    const body = asRecord(req.body);
    const recommendation = ScanRecommendationScheduler.fromContainer(container).markQueued(
      String(req.params.id),
      readOptionalString(body.jobId)
    );
    respondRecommendationMutation(res, recommendation);
  } catch (err: unknown) {
    respondError(res, 'SCAN_RECOMMENDATION_QUEUE_ERROR', err);
  }
});

router.post('/recommendations/:id/execute', (req: Request, res: Response): void => {
  try {
    const container = getServiceContainer();
    const body = asRecord(req.body);
    const recommendation = ScanRecommendationScheduler.fromContainer(container).markExecuted(
      String(req.params.id),
      readOptionalString(body.runId)
    );
    respondRecommendationMutation(res, recommendation);
  } catch (err: unknown) {
    respondError(res, 'SCAN_RECOMMENDATION_EXECUTE_ERROR', err);
  }
});

router.post('/recommendations/:id/dismiss', (req: Request, res: Response): void => {
  try {
    const container = getServiceContainer();
    const reason = readOptionalString(asRecord(req.body).reason) ?? 'Dismissed by user';
    const recommendation = ScanRecommendationScheduler.fromContainer(container).dismiss(
      String(req.params.id),
      reason
    );
    respondRecommendationMutation(res, recommendation);
  } catch (err: unknown) {
    respondError(res, 'SCAN_RECOMMENDATION_DISMISS_ERROR', err);
  }
});

router.post('/plan', (req: Request, res: Response): void => {
  try {
    const container = getServiceContainer();
    const planner = container.get('scanPlanService') as ScanPlanService;
    const normalizer = resolveScanRequestNormalizer(container);
    const plan = planner.plan(normalizer.toScanPlanRequest(req.body));
    res.json({ success: true, data: plan });
  } catch (err: unknown) {
    respondError(res, 'SCAN_PLAN_ERROR', err);
  }
});

router.post('/retrieve', async (req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const retrieval = container.get('knowledgeRetrievalPipeline') as KnowledgeRetrievalPipeline;
    const normalizer = resolveScanRequestNormalizer(container);
    const pack = await retrieval.retrieve(normalizer.toKnowledgeRetrievalInput(req.body));
    res.json({ success: true, data: pack });
  } catch (err: unknown) {
    respondError(res, 'SCAN_RETRIEVE_ERROR', err);
  }
});

router.post('/incremental-correction', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = asRecord(req.body);
    const { events } = normalizeFileChangeEvents(body.events);
    if (events.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'events must contain at least one valid event' },
      });
      return;
    }

    const container = getServiceContainer();
    const normalizer = resolveScanRequestNormalizer(container);
    const request = normalizer.toIncrementalCorrectionLifecycleRequest(body, events);
    const runner = resolveScanLifecycleRunner(container);
    if (readBoolean(body.async, false)) {
      const job = runner.enqueue(request, {
        label: 'HTTP incremental correction scan',
        maxAttempts: readPositiveInteger(body.maxAttempts, 1),
        reason: 'HTTP incremental correction scan',
      });
      res.status(202).json({ success: true, job });
      return;
    }
    const { result, run } = await runner.run(request, {
      reason: 'HTTP incremental correction scan',
    });
    res.json({ success: true, data: result, run });
  } catch (err: unknown) {
    respondError(res, 'SCAN_INCREMENTAL_ERROR', err);
  }
});

router.post('/deep-mining', async (req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const runner = resolveScanLifecycleRunner(container);
    const request = resolveScanRequestNormalizer(container).toDeepMiningLifecycleRequest(req.body);
    if (readBoolean(asRecord(req.body).async, false)) {
      const job = runner.enqueue(request, {
        label: 'HTTP deep mining scan',
        maxAttempts: readPositiveInteger(asRecord(req.body).maxAttempts, 1),
        reason: 'HTTP deep mining scan',
      });
      res.status(202).json({ success: true, job });
      return;
    }
    const { result, run } = await runner.run(request, {
      reason: 'HTTP deep mining scan',
    });
    res.json({ success: true, data: result, run });
  } catch (err: unknown) {
    if (err instanceof ScanLifecycleBaselineRequiredError) {
      res.status(409).json({
        success: false,
        error: {
          code: 'BASELINE_REQUIRED',
          message: err.message,
        },
      });
      return;
    }
    respondError(res, 'SCAN_DEEP_MINING_ERROR', err);
  }
});

router.post('/maintenance', async (req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const runner = resolveScanLifecycleRunner(container);
    const request = resolveScanRequestNormalizer(container).toMaintenanceLifecycleRequest(req.body);
    if (readBoolean(asRecord(req.body).async, false)) {
      const job = runner.enqueue(request, {
        label: 'HTTP maintenance scan',
        maxAttempts: readPositiveInteger(asRecord(req.body).maxAttempts, 1),
        reason: 'HTTP maintenance scan',
      });
      res.status(202).json({ success: true, job });
      return;
    }
    const { result, run, recommendations } = await runner.run(request, {
      reason: 'HTTP maintenance scan',
    });
    res.json({ success: true, data: result, run, recommendations });
  } catch (err: unknown) {
    respondError(res, 'SCAN_MAINTENANCE_ERROR', err);
  }
});

function respondRecommendationMutation(
  res: Response,
  recommendation: ScanRecommendationRecord | null
): void {
  if (!recommendation) {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Scan recommendation not found' },
    });
    return;
  }
  res.json({ success: true, data: recommendation });
}

function readScanEvidencePackRepository(container: {
  get?: (name: string) => unknown;
}): ScanEvidencePackRepository | null {
  try {
    const repository = container.get?.('scanEvidencePackRepository') as
      | ScanEvidencePackRepository
      | undefined;
    return repository && typeof repository.create === 'function' ? repository : null;
  } catch {
    return null;
  }
}

function requireScanEvidencePackRepository(container: {
  get?: (name: string) => unknown;
}): ScanEvidencePackRepository {
  const repository = readScanEvidencePackRepository(container);
  if (!repository) {
    throw new Error('scanEvidencePackRepository unavailable');
  }
  return repository;
}

function readScanRecommendationRepository(container: {
  get?: (name: string) => unknown;
}): ScanRecommendationRepository | null {
  try {
    const repository = container.get?.('scanRecommendationRepository') as
      | ScanRecommendationRepository
      | undefined;
    return repository && typeof repository.find === 'function' ? repository : null;
  } catch {
    return null;
  }
}

function requireScanRecommendationRepository(container: {
  get?: (name: string) => unknown;
}): ScanRecommendationRepository {
  const repository = readScanRecommendationRepository(container);
  if (!repository) {
    throw new Error('scanRecommendationRepository unavailable');
  }
  return repository;
}

function readScanRunRepository(container: {
  get?: (name: string) => unknown;
}): ScanRunRepository | null {
  try {
    const repository = container.get?.('scanRunRepository') as ScanRunRepository | undefined;
    return repository && typeof repository.create === 'function' ? repository : null;
  } catch {
    return null;
  }
}

function requireScanRunRepository(container: {
  get?: (name: string) => unknown;
}): ScanRunRepository {
  const repository = readScanRunRepository(container);
  if (!repository) {
    throw new Error('scanRunRepository unavailable');
  }
  return repository;
}

function requireScanJobQueue(container: { get?: (name: string) => unknown }): ScanJobQueue {
  const queue = container.get?.('scanJobQueue') as ScanJobQueue | undefined;
  if (!queue) {
    throw new Error('scanJobQueue unavailable');
  }
  return queue;
}

function resolveScanLifecycleRunner(container: {
  get?: (name: string) => unknown;
}): ScanLifecycleRunner {
  const runner = container.get?.('scanLifecycleRunner') as ScanLifecycleRunner | undefined;
  return runner && typeof runner.runIncrementalCorrection === 'function'
    ? runner
    : ScanLifecycleRunner.fromContainer(container, logger);
}

function resolveScanRequestNormalizer(container: { singletons?: Record<string, unknown> }) {
  return new ScanRequestNormalizer({
    defaultProjectRoot: readProjectRootFromContainer(container),
  });
}

function readScanMode(value: unknown): ScanMode | undefined {
  return typeof value === 'string' && VALID_SCAN_MODES.has(value as ScanMode)
    ? (value as ScanMode)
    : undefined;
}

function readRunStatus(value: unknown): ScanRunStatus | undefined {
  return typeof value === 'string' && VALID_RUN_STATUSES.has(value as ScanRunStatus)
    ? (value as ScanRunStatus)
    : undefined;
}

function readRecommendationStatus(value: unknown): ScanRecommendationStatus | undefined {
  return typeof value === 'string' &&
    VALID_RECOMMENDATION_STATUSES.has(value as ScanRecommendationStatus)
    ? (value as ScanRecommendationStatus)
    : undefined;
}

function readRecommendationMode(value: unknown): ScanRecommendedRun['mode'] | undefined {
  return value === 'incremental-correction' || value === 'deep-mining' ? value : undefined;
}

function readJobStatus(value: unknown): ScanJobStatus | undefined {
  return typeof value === 'string' && VALID_JOB_STATUSES.has(value as ScanJobStatus)
    ? (value as ScanJobStatus)
    : undefined;
}

function readProjectRootFromContainer(container: { singletons?: Record<string, unknown> }): string {
  return readString(container.singletons?._projectRoot) || process.cwd();
}

function respondError(res: Response, code: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn(`[scan] ${code}`, { error: message });
  res.status(500).json({ success: false, error: { code, message } });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : readOptionalNumber(value);
  if (!parsed || !Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export default router;

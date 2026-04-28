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
import {
  normalizeFileChangeEvents,
  normalizeScanChangeSet,
} from '#workflows/scan/normalization/ScanChangeSetNormalizer.js';
import type { KnowledgeRetrievalPipeline } from '#workflows/scan/retrieval/KnowledgeRetrievalPipeline.js';
import type { ScanJobQueue, ScanJobStatus } from '#workflows/scan/ScanJobQueue.js';
import type { ScanPlanService } from '#workflows/scan/ScanPlanService.js';
import type {
  DeepMiningRequest,
  KnowledgeRetrievalInput,
  MaintenanceWorkflowOptions,
  ScanBudget,
  ScanDepth,
  ScanFileEvidenceInput,
  ScanMode,
  ScanPlanRequest,
  ScanRecommendationStatus,
  ScanRecommendedRun,
  ScanScope,
} from '#workflows/scan/ScanTypes.js';

const router = express.Router();
const logger = Logger.getInstance();

const VALID_SCAN_MODES = new Set<ScanMode>([
  'cold-start',
  'deep-mining',
  'incremental-correction',
  'maintenance',
]);
const VALID_SCAN_DEPTHS = new Set<ScanDepth>(['light', 'standard', 'deep', 'exhaustive']);
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
    const plan = planner.plan(toScanPlanRequest(req.body));
    res.json({ success: true, data: plan });
  } catch (err: unknown) {
    respondError(res, 'SCAN_PLAN_ERROR', err);
  }
});

router.post('/retrieve', async (req: Request, res: Response): Promise<void> => {
  try {
    const container = getServiceContainer();
    const retrieval = container.get('knowledgeRetrievalPipeline') as KnowledgeRetrievalPipeline;
    const pack = await retrieval.retrieve(toKnowledgeRetrievalInput(req.body));
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
    const projectRoot = readString(body.projectRoot) || readProjectRootFromContainer(container);
    const depth = readScanDepth(body.depth) ?? 'standard';
    const budget = readBudget(body.budget);
    const request = {
      projectRoot,
      events,
      runDeterministic: readBoolean(body.runDeterministic, true),
      runAgent: readBoolean(body.runAgent, false),
      depth,
      budget,
      primaryLang: readOptionalString(body.primaryLang),
    };
    const runner = resolveScanLifecycleRunner(container);
    if (readBoolean(body.async, false)) {
      const job = runner.enqueueIncrementalCorrection(request, {
        label: 'HTTP incremental correction scan',
        maxAttempts: readPositiveInteger(body.maxAttempts, 1),
        reason: 'HTTP incremental correction scan',
      });
      res.status(202).json({ success: true, job });
      return;
    }
    const { result, run } = await runner.runIncrementalCorrection(request, {
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
    const request = toDeepMiningRequest(req.body, readProjectRootFromContainer(container));
    if (readBoolean(asRecord(req.body).async, false)) {
      const job = runner.enqueueDeepMining(request, {
        label: 'HTTP deep mining scan',
        maxAttempts: readPositiveInteger(asRecord(req.body).maxAttempts, 1),
        reason: 'HTTP deep mining scan',
      });
      res.status(202).json({ success: true, job });
      return;
    }
    const { result, run } = await runner.runDeepMining(request, {
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
    const options = toMaintenanceOptions(req.body, readProjectRootFromContainer(container));
    if (readBoolean(asRecord(req.body).async, false)) {
      const job = runner.enqueueMaintenance(options, {
        label: 'HTTP maintenance scan',
        maxAttempts: readPositiveInteger(asRecord(req.body).maxAttempts, 1),
        reason: 'HTTP maintenance scan',
      });
      res.status(202).json({ success: true, job });
      return;
    }
    const { result, run, recommendations } = await runner.runMaintenance(options, {
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

function toScanPlanRequest(value: unknown): ScanPlanRequest {
  const body = asRecord(value);
  const baseline = readBaseline(body.baseline);
  return {
    projectRoot:
      readString(body.projectRoot) || readProjectRootFromContainer(getServiceContainer()),
    intent: readIntent(body.intent),
    requestedMode: readScanMode(body.requestedMode),
    force: readOptionalBoolean(body.force),
    hasBaseline: readOptionalBoolean(body.hasBaseline),
    baselineRunId: readOptionalString(body.baselineRunId) ?? baseline.runId,
    baselineSnapshotId: readOptionalString(body.baselineSnapshotId) ?? baseline.snapshotId,
    totalFileCount: readOptionalNumber(body.totalFileCount),
    allDimensionIds: readStringArray(body.allDimensionIds),
    currentFiles: readFileInputs(body.currentFiles),
    dimensions: readStringArray(body.dimensions),
    modules: readStringArray(body.modules),
    recipeIds: readStringArray(body.recipeIds),
    query: readOptionalString(body.query),
    changeSet: readChangeSet(body.changeSet),
    impactedRecipeIds: readStringArray(body.impactedRecipeIds),
    budget: readBudget(body.budget),
  };
}

function toKnowledgeRetrievalInput(value: unknown): KnowledgeRetrievalInput {
  const body = asRecord(value);
  const mode = readScanMode(body.mode) ?? 'maintenance';
  return {
    projectRoot:
      readString(body.projectRoot) || readProjectRootFromContainer(getServiceContainer()),
    mode,
    intent: readRetrievalIntent(body.intent) ?? intentForMode(mode),
    depth: readScanDepth(body.depth),
    scope: readScope(body.scope ?? body),
    changeSet: readChangeSet(body.changeSet),
    files: readFileInputs(body.files),
    budget: readBudget(body.budget),
    primaryLang: readOptionalString(body.primaryLang),
  };
}

function toDeepMiningRequest(value: unknown, defaultProjectRoot: string): DeepMiningRequest {
  const body = asRecord(value);
  const depth = readScanDepth(body.depth);
  const baseline = readBaseline(body.baseline);
  return {
    projectRoot: readString(body.projectRoot) || defaultProjectRoot,
    baselineRunId: readOptionalString(body.baselineRunId) ?? baseline.runId,
    baselineSnapshotId: readOptionalString(body.baselineSnapshotId) ?? baseline.snapshotId,
    dimensions: readStringArray(body.dimensions),
    modules: readStringArray(body.modules),
    query: readOptionalString(body.query),
    depth: depth === 'exhaustive' ? 'exhaustive' : 'deep',
    maxNewCandidates: readOptionalNumber(body.maxNewCandidates),
    files: readFileInputs(body.files),
    runAgent: readBoolean(body.runAgent, false),
    primaryLang: readOptionalString(body.primaryLang),
  };
}

function readBaseline(value: unknown): { runId: string | null; snapshotId: string | null } {
  const baseline = asRecord(value);
  return {
    runId: readOptionalString(baseline.runId) ?? null,
    snapshotId: readOptionalString(baseline.snapshotId) ?? null,
  };
}

function toMaintenanceOptions(
  value: unknown,
  defaultProjectRoot: string
): MaintenanceWorkflowOptions {
  const body = asRecord(value);
  return {
    projectRoot: readString(body.projectRoot) || defaultProjectRoot,
    forceSourceRefReconcile: readOptionalBoolean(body.forceSourceRefReconcile),
    refreshSearchIndex: readOptionalBoolean(body.refreshSearchIndex),
    includeDecay: readOptionalBoolean(body.includeDecay),
    includeEnhancements: readOptionalBoolean(body.includeEnhancements),
    includeRedundancy: readOptionalBoolean(body.includeRedundancy),
  };
}

function readScope(value: unknown): ScanScope {
  const body = asRecord(value);
  return {
    dimensions: readStringArray(body.dimensions),
    files: readStringArray(body.files),
    modules: readStringArray(body.modules),
    symbols: readStringArray(body.symbols),
    recipeIds: readStringArray(body.recipeIds),
    query: readOptionalString(body.query),
  };
}

const readChangeSet = normalizeScanChangeSet;

function readFileInputs(value: unknown): ScanFileEvidenceInput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    const relativePath = readString(record.relativePath) || readString(record.path);
    if (!relativePath) {
      return [];
    }

    const file: ScanFileEvidenceInput = { relativePath };
    const path = readOptionalString(record.path);
    const name = readOptionalString(record.name);
    const language = readOptionalString(record.language);
    const content = readOptionalString(record.content);
    const hash = readOptionalString(record.hash);

    if (path) {
      file.path = path;
    }
    if (name) {
      file.name = name;
    }
    if (language) {
      file.language = language;
    }
    if (content) {
      file.content = content;
    }
    if (hash) {
      file.hash = hash;
    }

    return [file];
  });
}

function readBudget(value: unknown): ScanBudget | undefined {
  const body = asRecord(value);
  if (Object.keys(body).length === 0) {
    return undefined;
  }
  return {
    maxFiles: readOptionalNumber(body.maxFiles),
    maxFileChars: readOptionalNumber(body.maxFileChars),
    maxKnowledgeItems: readOptionalNumber(body.maxKnowledgeItems),
    maxGraphEdges: readOptionalNumber(body.maxGraphEdges),
    maxTotalChars: readOptionalNumber(body.maxTotalChars),
  };
}

function readIntent(value: unknown): ScanPlanRequest['intent'] {
  return value === 'bootstrap' ||
    value === 'change-set' ||
    value === 'deep-mining' ||
    value === 'maintenance'
    ? value
    : undefined;
}

function readRetrievalIntent(value: unknown): KnowledgeRetrievalInput['intent'] | undefined {
  return value === 'build-baseline' ||
    value === 'fill-coverage-gap' ||
    value === 'repair-stale-knowledge' ||
    value === 'audit-impacted-recipes' ||
    value === 'maintain-health'
    ? value
    : undefined;
}

function intentForMode(mode: ScanMode): KnowledgeRetrievalInput['intent'] {
  switch (mode) {
    case 'cold-start':
      return 'build-baseline';
    case 'deep-mining':
      return 'fill-coverage-gap';
    case 'incremental-correction':
      return 'audit-impacted-recipes';
    case 'maintenance':
      return 'maintain-health';
  }
}

function readScanMode(value: unknown): ScanMode | undefined {
  return typeof value === 'string' && VALID_SCAN_MODES.has(value as ScanMode)
    ? (value as ScanMode)
    : undefined;
}

function readScanDepth(value: unknown): ScanDepth | undefined {
  return typeof value === 'string' && VALID_SCAN_DEPTHS.has(value as ScanDepth)
    ? (value as ScanDepth)
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

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
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

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export default router;

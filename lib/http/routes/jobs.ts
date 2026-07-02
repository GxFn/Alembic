import { timingSafeEqual } from 'node:crypto';
import {
  ALEMBIC_JOB_DISPLAY_SNAPSHOT_PATH,
  ALEMBIC_JOB_PROCESS_EVENTS_PATH,
  type DaemonJobKind,
  type DaemonJobRecord,
  type DaemonJobStatus,
  type JobDisplaySnapshot,
  validateJobDisplaySnapshot,
} from '@alembic/core/daemon';
import {
  MAX_KNOWLEDGE_RESCAN_CONTENT_MAX_LINES,
  MAX_KNOWLEDGE_RESCAN_MAX_FILES,
} from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import { resolveDataRoot } from '@alembic/core/workspace';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import {
  mergeAgentEfficiencySummaries,
  normalizeAgentEfficiencySummary,
} from '#recipe-pipeline/generate/runtime/GenerateEfficiency.js';
import {
  cancelDaemonJob,
  enqueueDaemonJob,
  getJobDisplaySnapshotStore,
  getJobProcessEventRecorder,
  getJobStore,
} from '../../daemon/DaemonJobRunner.js';
import {
  buildJobDisplaySnapshotApiRef,
  type JobDisplaySnapshotStore,
  summarizeJobDisplaySnapshotForApi,
} from '../../daemon/JobDisplaySnapshotStore.js';
import { readJobProcessEventArtifact } from '../../daemon/JobProcessEventArtifacts.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();
const logger = Logger.getInstance();

const BootstrapJobBody = z.object({
  maxFiles: z.number().int().min(1).max(10000).default(500),
  skipGuard: z.boolean().default(false),
  contentMaxLines: z.number().int().min(1).max(10000).default(120),
});

const RescanJobBody = z
  .object({
    reason: z.string().optional(),
    dimensions: z.array(z.string()).optional(),
    maxFiles: z.coerce.number().int().min(1).max(MAX_KNOWLEDGE_RESCAN_MAX_FILES).optional(),
    contentMaxLines: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_KNOWLEDGE_RESCAN_CONTENT_MAX_LINES)
      .optional(),
    generationStage: z.enum(['deepMining', 'moduleMining']).optional(),
    maxRounds: z.coerce.number().int().min(1).max(100).optional(),
    minNewRecipes: z.coerce.number().int().min(1).max(500).optional(),
    scaleCap: z.coerce.number().int().min(1).max(500).optional(),
    miningMode: z.enum(['deepMining', 'moduleMining', 'per-module']).optional(),
    moduleScope: z.array(z.string().min(1)).optional(),
    perDimensionTargets: z.record(z.string().min(1), z.coerce.number().int().min(0)).optional(),
    moduleDimensionTargets: z
      .array(
        z.object({
          dimensionId: z.string().min(1),
          moduleId: z.string().min(1).optional(),
          moduleName: z.string().min(1).optional(),
          targetRecipes: z.coerce.number().int().min(1).max(500),
        })
      )
      .optional(),
    roundIndex: z.coerce.number().int().min(1).max(100).optional(),
  })
  .superRefine((body, ctx) => {
    if (!body.generationStage || !body.miningMode) {
      return;
    }
    const miningModeMatchesStage =
      body.miningMode === body.generationStage ||
      (body.generationStage === 'moduleMining' && body.miningMode === 'per-module');
    if (!miningModeMatchesStage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'miningMode must match generationStage',
        path: ['miningMode'],
      });
    }
  });
export type RescanJobRequest = z.infer<typeof RescanJobBody>;

export function parseRescanJobBody(input: unknown): RescanJobRequest {
  return RescanJobBody.parse(input);
}

const CancelJobBody = z.object({
  reason: z.string().optional(),
});

export interface DaemonJobApiProgress {
  activeTaskEventCount?: number;
  activeTaskId?: string;
  activeTaskLabel?: string;
  activeTaskStartedAt?: number;
  activeTaskStatus?: string;
  activeTaskUpdatedAt?: number;
  cancelled?: number;
  completed?: number;
  failed?: number;
  filling?: number;
  percent?: number;
  sessionId?: string;
  skeleton?: number;
  status: string;
  total?: number;
  totalToolCalls?: number;
  updatedAt?: string;
}

export interface DaemonJobApiRecord extends DaemonJobRecord {
  compact?: boolean;
  displaySnapshot?: Record<string, unknown> | null;
  progress?: DaemonJobApiProgress;
  summary?: Record<string, unknown>;
}

type DaemonJobApiProgressNumberKey =
  | 'activeTaskEventCount'
  | 'activeTaskStartedAt'
  | 'activeTaskUpdatedAt'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'filling'
  | 'percent'
  | 'skeleton'
  | 'total'
  | 'totalToolCalls';

router.get('/', (req: Request, res: Response): void => {
  const container = getServiceContainer();
  const store = getJobStore(container);
  const liveSession = getLiveBootstrapSession(container);
  const snapshotStore = getJobDisplaySnapshotStore(container);
  const kind = parseKind(req.query.kind);
  const status = parseStatus(req.query.status);
  const limit = parseLimit(req.query.limit);
  const compact = parseBooleanQuery(req.query.compact);

  res.json({
    success: true,
    data: {
      jobs: store
        .list({ kind, limit: status ? 200 : limit })
        .map((job) =>
          decorateJobForResponse(job, liveSession, {
            compact,
            displaySnapshot: buildJobDisplaySnapshotSummary(job, snapshotStore),
          })
        )
        .filter((job) => !status || job.status === status)
        .slice(0, limit),
    },
  });
});

router.get('/:jobId/events', (req: Request, res: Response): void => {
  const container = getServiceContainer();
  const store = getJobStore(container);
  const jobId = singleParam(req.params.jobId);
  const job = store.get(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }

  const recorder = getJobProcessEventRecorder(container);
  const events = buildJobProcessEventsResponse({
    afterSequence: parseSequence(req.query.afterSequence ?? req.query.after),
    jobId,
    limit: parseLimit(req.query.limit),
    recorder,
  });
  res.json({
    success: true,
    data: events,
  });
});

router.get('/:jobId/display-snapshot', (req: Request, res: Response): void => {
  const container = getServiceContainer();
  const store = getJobStore(container);
  const jobId = singleParam(req.params.jobId);
  const job = store.get(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }

  res.json({
    success: true,
    data: buildJobDisplaySnapshotResponse({
      job,
      recorder: getJobProcessEventRecorder(container),
      snapshotStore: getJobDisplaySnapshotStore(container),
    }),
  });
});

router.get('/:jobId/artifacts/:artifactId', (req: Request, res: Response): void => {
  const container = getServiceContainer();
  const store = getJobStore(container);
  const jobId = singleParam(req.params.jobId);
  const artifactId = singleParam(req.params.artifactId);
  const job = store.get(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }

  const artifact = readJobProcessEventArtifact({
    artifactId,
    dataRoot: job.dataRoot || resolveDataRoot(container),
    jobId,
  });
  if (!artifact) {
    res.status(404).json({ success: false, error: 'Artifact not found' });
    return;
  }
  res.type(artifact.mimeType).send(artifact.content);
});

router.get('/:jobId', (req: Request, res: Response): void => {
  const container = getServiceContainer();
  const store = getJobStore(container);
  const job = store.get(singleParam(req.params.jobId));
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }
  const compact = parseBooleanQuery(req.query.compact);
  const snapshotStore = getJobDisplaySnapshotStore(container);
  res.json({
    success: true,
    data: {
      job: decorateJobForResponse(job, getLiveBootstrapSession(container), {
        compact,
        displaySnapshot: buildJobDisplaySnapshotSummary(job, snapshotStore),
      }),
    },
  });
});

router.post('/bootstrap', validate(BootstrapJobBody), (req: Request, res: Response): void => {
  if (!rejectInvalidProvidedDaemonToken(req, res)) {
    return;
  }
  const container = getServiceContainer();
  const job = enqueueDaemonJob({
    args: req.body as z.infer<typeof BootstrapJobBody>,
    container,
    kind: 'bootstrap',
    logger,
    source: inferJobSource(req),
  });
  res.status(202).json({
    success: true,
    data: {
      job: decorateJobForResponse(job, getLiveBootstrapSession(container)),
      jobId: job.id,
      statusUrl: buildJobStatusUrl(req, job.id),
      eventsUrl: buildJobProcessEventsUrl(req, job.id),
      displaySnapshotUrl: buildJobDisplaySnapshotUrl(req, job.id),
      dashboardUrl: buildJobsApiOrigin(req),
    },
  });
});

router.post('/rescan', validate(RescanJobBody), (req: Request, res: Response): void => {
  if (!rejectInvalidProvidedDaemonToken(req, res)) {
    return;
  }
  const container = getServiceContainer();
  const job = enqueueDaemonJob({
    args: req.body as z.infer<typeof RescanJobBody>,
    container,
    kind: 'rescan',
    logger,
    source: inferJobSource(req),
  });
  res.status(202).json({
    success: true,
    data: {
      job: decorateJobForResponse(job, getLiveBootstrapSession(container)),
      jobId: job.id,
      statusUrl: buildJobStatusUrl(req, job.id),
      eventsUrl: buildJobProcessEventsUrl(req, job.id),
      displaySnapshotUrl: buildJobDisplaySnapshotUrl(req, job.id),
      dashboardUrl: buildJobsApiOrigin(req),
    },
  });
});

export function buildJobsApiOrigin(request: Request): string {
  const host = request.get('host');
  if (host) {
    return `${request.protocol}://${host}`;
  }

  const address = normalizeLocalAddress(request.socket.localAddress || '127.0.0.1');
  const port = request.socket.localPort;
  return `${request.protocol}://${address}${port ? `:${port}` : ''}`;
}

export function buildJobStatusUrl(request: Request, jobId: string): string {
  return `${buildJobsApiOrigin(request)}/api/v1/jobs/${encodeURIComponent(jobId)}`;
}

export function buildJobProcessEventsUrl(request: Request, jobId: string): string {
  return `${buildJobsApiOrigin(request)}${ALEMBIC_JOB_PROCESS_EVENTS_PATH.replace(
    ':jobId',
    encodeURIComponent(jobId)
  )}`;
}

export function buildJobDisplaySnapshotUrl(request: Request, jobId: string): string {
  return `${buildJobsApiOrigin(request)}${ALEMBIC_JOB_DISPLAY_SNAPSHOT_PATH.replace(
    ':jobId',
    encodeURIComponent(jobId)
  )}`;
}

export function buildJobProcessArtifactUrl(
  request: Request,
  jobId: string,
  artifactId: string
): string {
  return `${buildJobsApiOrigin(request)}/api/v1/jobs/${encodeURIComponent(
    jobId
  )}/artifacts/${encodeURIComponent(artifactId)}`;
}

export function buildJobProcessEventsResponse(options: {
  afterSequence?: number;
  includeHidden?: boolean;
  jobId: string;
  limit?: number;
  recorder: ReturnType<typeof getJobProcessEventRecorder>;
}) {
  return options.recorder.list(options.jobId, {
    afterSequence: options.afterSequence,
    includeHidden: options.includeHidden,
    limit: options.limit,
  });
}

export interface JobDisplaySnapshotResponse {
  persisted: boolean;
  snapshot: JobDisplaySnapshot;
  snapshotPath: string | null;
  validation: ReturnType<typeof validateJobDisplaySnapshot>;
}

export function buildJobDisplaySnapshotResponse(options: {
  job: DaemonJobRecord;
  recorder: ReturnType<typeof getJobProcessEventRecorder>;
  snapshotStore: JobDisplaySnapshotStore;
}): JobDisplaySnapshotResponse {
  const persisted = options.snapshotStore.readForJob(options.job);
  if (persisted) {
    return {
      persisted: true,
      snapshot: persisted.snapshot,
      snapshotPath: persisted.absolutePath,
      validation: persisted.validation,
    };
  }

  const events = options.recorder.list(options.job.id, {
    includeHidden: true,
    limit: options.recorder.maxEventsPerJob,
  });
  if (events.retainedCount > 0 || events.events.length > 0) {
    const written = options.snapshotStore.writeFromJob({
      job: options.job,
      recorder: options.recorder,
    });
    return {
      persisted: true,
      snapshot: written.snapshot,
      snapshotPath: written.absolutePath,
      validation: written.validation,
    };
  }

  const snapshot = options.snapshotStore.buildIncompleteSnapshot({ job: options.job });
  return {
    persisted: false,
    snapshot,
    snapshotPath: null,
    validation: validateJobDisplaySnapshot(snapshot),
  };
}

router.post('/:jobId/cancel', validate(CancelJobBody), (req: Request, res: Response): void => {
  if (!rejectInvalidProvidedDaemonToken(req, res)) {
    return;
  }
  const container = getServiceContainer();
  const job = cancelDaemonJob({
    container,
    jobId: singleParam(req.params.jobId),
    reason: (req.body as z.infer<typeof CancelJobBody>).reason || 'Cancelled via jobs API',
  });
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }
  res.json({
    success: true,
    data: { job: decorateJobForResponse(job, getLiveBootstrapSession(container)) },
  });
});

export function decorateJobForResponse(
  job: DaemonJobRecord,
  liveSession?: Record<string, unknown> | null,
  options: { compact?: boolean; displaySnapshot?: Record<string, unknown> | null } = {}
): DaemonJobApiRecord {
  const matchingLiveSession = getMatchingLiveBootstrapSession(job, liveSession);
  const embeddedSession = getEmbeddedBootstrapSession(job);
  const session = matchingLiveSession || embeddedSession;
  const status = resolveJobStatusForResponse(job, session);
  const progress = buildJobProgress(job, session, status);
  const summary = getJobSummary(job, session, status);
  const base = options.compact ? omitHeavyJobPayload(job) : job;

  return {
    ...base,
    status,
    ...(options.compact ? { compact: true } : {}),
    ...(options.displaySnapshot !== undefined ? { displaySnapshot: options.displaySnapshot } : {}),
    ...(progress ? { progress } : {}),
    ...(summary ? { summary } : {}),
  };
}

function buildJobDisplaySnapshotSummary(
  job: DaemonJobRecord,
  snapshotStore: JobDisplaySnapshotStore
): Record<string, unknown> {
  const existing = snapshotStore.readForJob(job);
  const summary = summarizeJobDisplaySnapshotForApi(existing?.snapshot);
  if (summary) {
    return summary;
  }
  return {
    available: false,
    reason: 'snapshot_missing',
    ref: buildJobDisplaySnapshotApiRef(job.id),
  };
}

function omitHeavyJobPayload(job: DaemonJobRecord): Omit<DaemonJobRecord, 'result'> {
  const { result: _omitted, ...compactJob } = job;
  return compactJob;
}

function getLiveBootstrapSession(container: { get(name: string): unknown }) {
  try {
    const taskManager = container.get('generateTaskManager') as
      | { getSessionStatus?: () => unknown }
      | undefined;
    const status = taskManager?.getSessionStatus?.();
    return isRecord(status) ? status : null;
  } catch {
    return null;
  }
}

function getMatchingLiveBootstrapSession(
  job: DaemonJobRecord,
  liveSession?: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!liveSession || liveSession.status === 'idle') {
    return null;
  }

  const liveSessionId = getSessionId(liveSession);
  const jobSessionId = getJobSessionId(job);
  if (liveSessionId && jobSessionId) {
    return liveSessionId === jobSessionId ? liveSession : null;
  }

  if (
    !jobSessionId &&
    job.kind === 'bootstrap' &&
    job.status === 'running' &&
    sessionTimingFitsJob(liveSession, job)
  ) {
    return liveSession;
  }

  return null;
}

function getEmbeddedBootstrapSession(job: DaemonJobRecord): Record<string, unknown> | null {
  const result = asRecordOrNull(job.result);
  if (!result) {
    return null;
  }
  return asRecordOrNull(result.finalSession) || asRecordOrNull(result.bootstrapSession);
}

function buildJobProgress(
  job: DaemonJobRecord,
  session: Record<string, unknown> | null,
  responseStatus: DaemonJobStatus
): DaemonJobApiProgress | null {
  const summary = getSummaryRecord(session);
  const status = normalizeJobStatus(
    stringField(session, 'status'),
    responseStatus,
    summary,
    session?.userCancelled === true
  );
  const total = numberField(session, 'total') ?? numberField(summary, 'totalTasks');
  const completed = numberField(session, 'completed') ?? numberField(summary, 'completed');
  let failed = numberField(session, 'failed') ?? numberField(summary, 'failed');
  let cancelled = numberField(session, 'cancelled') ?? numberField(summary, 'cancelled');
  if (
    status === 'cancelled' &&
    cancelled === undefined &&
    typeof failed === 'number' &&
    failed > 0 &&
    summary?.aborted === true
  ) {
    cancelled = failed;
    failed = 0;
  }
  const computedPercent =
    typeof total === 'number' && total > 0 && typeof completed === 'number'
      ? Math.round((((completed || 0) + (failed || 0) + (cancelled || 0)) / total) * 100)
      : undefined;
  const fallbackPercent = fallbackPercentForStatus(status);
  const percent = clampPercent(
    numberField(session, 'progress') ?? computedPercent ?? fallbackPercent
  );

  if (!session && percent === undefined) {
    return null;
  }

  const activeTask = getActiveTask(session);
  const progress: DaemonJobApiProgress = { status };
  if (activeTask?.id) {
    progress.activeTaskId = activeTask.id;
  }
  if (activeTask?.label) {
    progress.activeTaskLabel = activeTask.label;
  }
  if (activeTask?.status) {
    progress.activeTaskStatus = activeTask.status;
  }
  setNumber(progress, 'activeTaskStartedAt', activeTask?.startedAt);
  setNumber(progress, 'activeTaskUpdatedAt', activeTask?.updatedAt);
  setNumber(progress, 'activeTaskEventCount', activeTask?.eventCount);
  setNumber(progress, 'cancelled', cancelled);
  setNumber(progress, 'completed', completed);
  setNumber(progress, 'failed', failed);
  setNumber(progress, 'filling', numberField(session, 'filling'));
  setNumber(progress, 'percent', percent);
  setNumber(progress, 'skeleton', numberField(session, 'skeleton'));
  setNumber(progress, 'total', total);
  setNumber(progress, 'totalToolCalls', numberField(session, 'totalToolCalls'));
  const updatedAt = resolveProgressUpdatedAt(session, job);
  if (updatedAt) {
    progress.updatedAt = updatedAt;
  }

  const sessionId = getSessionId(session);
  if (sessionId) {
    progress.sessionId = sessionId;
  }

  return progress;
}

function resolveJobStatusForResponse(
  job: DaemonJobRecord,
  session: Record<string, unknown> | null
): DaemonJobStatus {
  return normalizeJobStatus(
    stringField(session, 'status'),
    job.status,
    getSummaryRecord(session),
    session?.userCancelled === true
  );
}

function normalizeJobStatus(
  rawStatus: string | undefined,
  fallback: DaemonJobStatus,
  summary?: Record<string, unknown> | null,
  userCancelled = false
): DaemonJobStatus {
  if (userCancelled || summary?.aborted === true || rawStatus === 'aborted') {
    return 'cancelled';
  }
  if (fallback === 'cancelled') {
    return 'cancelled';
  }
  if (fallback === 'failed') {
    return 'failed';
  }
  if (rawStatus === 'failed' || rawStatus === 'completed_with_errors') {
    return 'failed';
  }
  if (fallback === 'completed' && (rawStatus === 'queued' || rawStatus === 'running')) {
    return 'completed';
  }
  if (
    rawStatus === 'queued' ||
    rawStatus === 'running' ||
    rawStatus === 'completed' ||
    rawStatus === 'cancelled'
  ) {
    return rawStatus;
  }
  return fallback;
}

function getJobSummary(
  job: DaemonJobRecord,
  session: Record<string, unknown> | null,
  responseStatus: DaemonJobStatus
): Record<string, unknown> | undefined {
  const sessionSummary = buildSessionSummaryRecord(session, responseStatus, job);
  if (sessionSummary) {
    return sessionSummary;
  }

  const result = asRecordOrNull(job.result);
  const candidateSummary = asRecordOrNull(result?.bootstrapCandidates);
  if (candidateSummary) {
    return normalizeSummaryForStatus(candidateSummary, responseStatus, job, session);
  }

  const terminalSummary = normalizeSummaryForStatus({}, responseStatus, job, session);
  return Object.keys(terminalSummary).length > 0 ? terminalSummary : undefined;
}

function getSummaryRecord(
  session: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  return asRecordOrNull(session?.summary);
}

function buildSessionSummaryRecord(
  session: Record<string, unknown> | null | undefined,
  responseStatus?: DaemonJobStatus,
  job?: DaemonJobRecord
): Record<string, unknown> | null {
  if (!session) {
    return responseStatus ? normalizeSummaryForStatus({}, responseStatus, job, null) : null;
  }
  const explicit = getSummaryRecord(session);
  const efficiency = extractSessionEfficiency(session);
  const diagnostics = extractSessionDiagnostics(session);
  if (explicit) {
    return normalizeSummaryForStatus(
      {
        ...explicit,
        ...(efficiency ? { efficiency } : {}),
        ...(diagnostics ? { diagnostics } : {}),
      },
      responseStatus,
      job,
      session
    );
  }

  const total = numberField(session, 'total');
  const completed = numberField(session, 'completed');
  const failed = numberField(session, 'failed');
  const cancelled = numberField(session, 'cancelled');
  const duration =
    typeof numberField(session, 'completedAt') === 'number' &&
    typeof numberField(session, 'startedAt') === 'number'
      ? (numberField(session, 'completedAt') ?? 0) - (numberField(session, 'startedAt') ?? 0)
      : undefined;
  if (
    typeof total !== 'number' &&
    typeof completed !== 'number' &&
    typeof failed !== 'number' &&
    typeof cancelled !== 'number' &&
    !efficiency &&
    !responseStatus
  ) {
    return null;
  }
  return normalizeSummaryForStatus(
    {
      ...(typeof duration === 'number' ? { duration } : {}),
      ...(typeof total === 'number' ? { totalTasks: total } : {}),
      ...(typeof cancelled === 'number' ? { cancelled } : {}),
      ...(typeof completed === 'number' ? { completed } : {}),
      ...(typeof failed === 'number' ? { failed } : {}),
      ...(session.userCancelled === true ? { aborted: true } : {}),
      ...(efficiency ? { efficiency } : {}),
      ...(diagnostics ? { diagnostics } : {}),
    },
    responseStatus,
    job,
    session
  );
}

function normalizeSummaryForStatus(
  summary: Record<string, unknown>,
  responseStatus?: DaemonJobStatus,
  job?: DaemonJobRecord,
  session?: Record<string, unknown> | null
): Record<string, unknown> {
  if (responseStatus === 'cancelled') {
    const summaryFailed = numberField(summary, 'failed');
    const summaryCancelled = numberField(summary, 'cancelled');
    const normalizedCounts =
      summaryCancelled === undefined &&
      typeof summaryFailed === 'number' &&
      summaryFailed > 0 &&
      summary.aborted === true
        ? { cancelled: summaryFailed, failed: 0 }
        : {};
    return {
      ...summary,
      ...normalizedCounts,
      status: 'cancelled',
      aborted: true,
      reason: getCancellationReason(summary, session, job),
    };
  }
  if (responseStatus === 'failed') {
    const reason = getFailureReason(summary, session, job);
    return {
      ...summary,
      status: 'failed',
      ...(reason ? { reason } : {}),
    };
  }
  if (responseStatus === 'completed') {
    return { ...summary, status: 'completed' };
  }
  return summary;
}

function getCancellationReason(
  summary: Record<string, unknown>,
  session?: Record<string, unknown> | null,
  job?: DaemonJobRecord
): string {
  return (
    stringField(summary, 'reason') ||
    stringField(session, 'reason') ||
    stringField(session, 'cancelReason') ||
    job?.error?.message ||
    'Cancelled'
  );
}

function getFailureReason(
  summary: Record<string, unknown>,
  session?: Record<string, unknown> | null,
  job?: DaemonJobRecord
): string | undefined {
  return stringField(summary, 'reason') || stringField(session, 'reason') || job?.error?.message;
}

function extractSessionEfficiency(session: Record<string, unknown> | null | undefined): unknown {
  if (!session) {
    return null;
  }
  const summary = getSummaryRecord(session);
  const explicit =
    normalizeAgentEfficiencySummary(summary?.efficiency) ||
    normalizeAgentEfficiencySummary(session.efficiency);
  if (explicit) {
    return explicit;
  }
  const tasks = Array.isArray(session.tasks) ? session.tasks : [];
  return mergeAgentEfficiencySummaries(
    tasks
      .map((task) => asRecordOrNull(task))
      .map((task) => asRecordOrNull(task?.result)?.efficiency),
    { cancelReason: stringField(summary, 'reason') }
  );
}

function extractSessionDiagnostics(
  session: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!session) {
    return null;
  }
  const tasks = Array.isArray(session.tasks) ? session.tasks : [];
  const statuses: Record<string, number> = {};
  const gateFailures: unknown[] = [];
  const timedOutStages = new Set<string>();
  const issues: Array<{ taskId?: string; status?: string; reason?: string }> = [];
  let degraded = false;
  let forcedSummary = false;
  let cancelReason: string | undefined;

  for (const taskValue of tasks) {
    const task = asRecordOrNull(taskValue);
    const result = asRecordOrNull(task?.result);
    const diagnostics = asRecordOrNull(result?.diagnostics);
    const status = stringField(result, 'status') || stringField(task, 'status');
    if (status) {
      statuses[status] = (statuses[status] || 0) + 1;
    }
    const reason =
      stringField(result, 'reason') || stringField(result, 'error') || stringField(task, 'error');
    if (isIssueStatus(status) || reason) {
      issues.push({
        ...(stringField(task, 'id') ? { taskId: stringField(task, 'id') } : {}),
        ...(status ? { status } : {}),
        ...(reason ? { reason } : {}),
      });
    }
    if (diagnostics?.degraded === true || result?.degraded === true) {
      degraded = true;
    }
    if (Array.isArray(diagnostics?.gateFailures)) {
      gateFailures.push(...diagnostics.gateFailures);
    }
    if (Array.isArray(diagnostics?.timedOutStages)) {
      for (const stage of diagnostics.timedOutStages) {
        if (typeof stage === 'string' && stage.trim()) {
          timedOutStages.add(stage.trim());
        }
      }
    }
    const efficiency = asRecordOrNull(result?.efficiency);
    forcedSummary = forcedSummary || efficiency?.forcedSummary === true;
    cancelReason = stringField(efficiency, 'cancelReason') || cancelReason;
  }

  const hasDiagnostics =
    Object.keys(statuses).length > 0 ||
    gateFailures.length > 0 ||
    timedOutStages.size > 0 ||
    issues.length > 0 ||
    degraded ||
    forcedSummary ||
    Boolean(cancelReason);
  if (!hasDiagnostics) {
    return null;
  }
  return {
    statuses,
    ...(issues.length > 0 ? { issues } : {}),
    ...(gateFailures.length > 0 ? { gateFailures } : {}),
    ...(timedOutStages.size > 0 ? { timedOutStages: [...timedOutStages] } : {}),
    ...(degraded ? { degraded: true } : {}),
    ...(forcedSummary ? { forcedSummary: true } : {}),
    ...(cancelReason ? { cancelReason } : {}),
  };
}

function getJobSessionId(job: DaemonJobRecord): string | undefined {
  if (job.bootstrapSessionId) {
    return job.bootstrapSessionId;
  }
  return getSessionId(getEmbeddedBootstrapSession(job));
}

function getSessionId(session: Record<string, unknown> | null | undefined): string | undefined {
  return stringField(session, 'id') || stringField(session, 'sessionId');
}

function getActiveTask(session: Record<string, unknown> | null): {
  eventCount?: number;
  id?: string;
  label?: string;
  startedAt?: number;
  status?: string;
  updatedAt?: number;
} | null {
  const tasks = Array.isArray(session?.tasks) ? session.tasks : [];
  const task = tasks
    .map((value) => asRecordOrNull(value))
    .find((candidate) => candidate?.status === 'filling');
  if (!task) {
    return null;
  }
  const meta = asRecordOrNull(task.meta);
  return {
    eventCount: numberField(task, 'eventCount'),
    id: stringField(task, 'id'),
    label: stringField(meta, 'label') || stringField(meta, 'dimId') || stringField(task, 'id'),
    startedAt: numberField(task, 'startedAt'),
    status: stringField(task, 'status'),
    updatedAt: numberField(task, 'updatedAt'),
  };
}

function resolveProgressUpdatedAt(
  session: Record<string, unknown> | null,
  job: DaemonJobRecord
): string | undefined {
  const sessionUpdatedAt = numberField(session, 'updatedAt');
  if (typeof sessionUpdatedAt === 'number') {
    return new Date(sessionUpdatedAt).toISOString();
  }
  const tasks = Array.isArray(session?.tasks) ? session.tasks : [];
  const latestTaskUpdatedAt = tasks
    .map((task) => numberField(asRecordOrNull(task), 'updatedAt'))
    .filter((value): value is number => typeof value === 'number')
    .reduce((latest, value) => Math.max(latest, value), 0);
  if (latestTaskUpdatedAt > 0) {
    return new Date(latestTaskUpdatedAt).toISOString();
  }
  return job.updatedAt;
}

function isIssueStatus(status: string | undefined): boolean {
  return [
    'failed',
    'timeout',
    'blocked',
    'aborted',
    'error',
    'degraded_budget_exhausted',
    'degraded_no_findings',
    'record_repair_incomplete',
    'l4_compaction_failed_budget_exhausted',
  ].includes(status || '');
}

function sessionTimingFitsJob(session: Record<string, unknown>, job: DaemonJobRecord): boolean {
  const sessionStartedAt = numberField(session, 'startedAt');
  if (sessionStartedAt === undefined) {
    return true;
  }

  const jobCreatedAt = Date.parse(job.createdAt);
  if (!Number.isFinite(jobCreatedAt)) {
    return true;
  }

  const jobCompletedAt = job.completedAt ? Date.parse(job.completedAt) : Date.now();
  const upperBound = Number.isFinite(jobCompletedAt) ? jobCompletedAt + 60_000 : Date.now();
  return sessionStartedAt >= jobCreatedAt - 60_000 && sessionStartedAt <= upperBound;
}

function fallbackPercentForStatus(status: DaemonJobStatus): number | undefined {
  if (status === 'completed') {
    return 100;
  }
  if (status === 'queued' || status === 'running') {
    return 0;
  }
  return undefined;
}

function setNumber(
  target: DaemonJobApiProgress,
  key: DaemonJobApiProgressNumberKey,
  value: number | undefined
) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    target[key] = value;
  }
}

function numberField(
  record: Record<string, unknown> | null | undefined,
  key: string
): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(
  record: Record<string, unknown> | null | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function clampPercent(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, value));
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function inferJobSource(req: Request) {
  return req.headers['x-alembic-daemon-token'] ? 'http' : 'dashboard';
}

function rejectInvalidProvidedDaemonToken(req: Request, res: Response): boolean {
  const providedHeader = req.headers['x-alembic-daemon-token'];
  if (!providedHeader) {
    return true;
  }

  const expected = process.env.ALEMBIC_DAEMON_TOKEN;
  const provided = Array.isArray(providedHeader) ? providedHeader[0] : providedHeader;
  if (!expected || typeof provided !== 'string') {
    res.status(401).json({ success: false, error: 'Invalid Alembic daemon token' });
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  const valid =
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer);
  if (!valid) {
    res.status(401).json({ success: false, error: 'Invalid Alembic daemon token' });
  }
  return valid;
}

function parseKind(value: unknown): DaemonJobKind | undefined {
  return value === 'bootstrap' || value === 'rescan' ? value : undefined;
}

function parseStatus(value: unknown): DaemonJobStatus | undefined {
  return value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
    ? value
    : undefined;
}

function parseLimit(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
  return Number.isFinite(parsed) ? parsed : 50;
}

function parseSequence(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

function parseBooleanQuery(value: unknown): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === true || raw === 'true' || raw === '1';
}

function singleParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function normalizeLocalAddress(address: string): string {
  if (address === '::' || address === '0.0.0.0') {
    return '127.0.0.1';
  }
  return address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
}

export default router;

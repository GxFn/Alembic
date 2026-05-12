import { timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { cancelDaemonJob, enqueueDaemonJob, getJobStore } from '../../daemon/DaemonJobRunner.js';
import type { DaemonJobKind, DaemonJobRecord, DaemonJobStatus } from '../../daemon/JobStore.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();
const logger = Logger.getInstance();

const JobContextBody = z.object({
  actor: z
    .object({
      role: z.string().optional(),
      user: z.string().optional(),
    })
    .optional(),
  channelId: z.string().optional(),
  client: z.string().optional(),
  createdByTool: z.string().optional(),
  sessionId: z.string().optional(),
});

const BootstrapJobBody = z.object({
  maxFiles: z.number().int().min(1).max(10000).default(500),
  skipGuard: z.boolean().default(false),
  contentMaxLines: z.number().int().min(1).max(10000).default(120),
  jobContext: JobContextBody.optional(),
});

const RescanJobBody = z.object({
  reason: z.string().optional(),
  dimensions: z.array(z.string()).optional(),
  jobContext: JobContextBody.optional(),
});

const CancelJobBody = z.object({
  reason: z.string().optional(),
});

export interface DaemonJobApiProgress {
  activeTaskId?: string;
  activeTaskLabel?: string;
  completed?: number;
  failed?: number;
  filling?: number;
  percent?: number;
  sessionId?: string;
  skeleton?: number;
  status: string;
  total?: number;
  totalToolCalls?: number;
}

export interface DaemonJobApiRecord extends DaemonJobRecord {
  progress?: DaemonJobApiProgress;
  summary?: Record<string, unknown>;
}

type DaemonJobApiProgressNumberKey =
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
  const kind = parseKind(req.query.kind);
  const status = parseStatus(req.query.status);
  const limit = parseLimit(req.query.limit);

  res.json({
    success: true,
    data: {
      jobs: store
        .list({ kind, limit, status })
        .map((job) => decorateJobForResponse(job, liveSession)),
    },
  });
});

router.get('/:jobId', (req: Request, res: Response): void => {
  const container = getServiceContainer();
  const store = getJobStore(container);
  const job = store.get(singleParam(req.params.jobId));
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }
  res.json({
    success: true,
    data: { job: decorateJobForResponse(job, getLiveBootstrapSession(container)) },
  });
});

router.post('/bootstrap', validate(BootstrapJobBody), (req: Request, res: Response): void => {
  if (!rejectInvalidProvidedDaemonToken(req, res)) {
    return;
  }
  const container = getServiceContainer();
  const body = req.body as z.infer<typeof BootstrapJobBody>;
  const { jobContext, ...args } = body;
  const job = enqueueDaemonJob({
    args,
    container,
    context: jobContext,
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
      dashboardUrl: buildJobsApiOrigin(req),
    },
  });
});

router.post('/rescan', validate(RescanJobBody), (req: Request, res: Response): void => {
  if (!rejectInvalidProvidedDaemonToken(req, res)) {
    return;
  }
  const container = getServiceContainer();
  const body = req.body as z.infer<typeof RescanJobBody>;
  const { jobContext, ...args } = body;
  const job = enqueueDaemonJob({
    args,
    container,
    context: jobContext,
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
  liveSession?: Record<string, unknown> | null
): DaemonJobApiRecord {
  const matchingLiveSession = getMatchingLiveBootstrapSession(job, liveSession);
  const embeddedSession = getEmbeddedBootstrapSession(job);
  const session = matchingLiveSession || embeddedSession;
  const progress = buildJobProgress(job, session);
  const summary = getJobSummary(job, session);

  return {
    ...job,
    ...(progress ? { progress } : {}),
    ...(summary ? { summary } : {}),
  };
}

function getLiveBootstrapSession(container: { get(name: string): unknown }) {
  try {
    const taskManager = container.get('bootstrapTaskManager') as
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
  session: Record<string, unknown> | null
): DaemonJobApiProgress | null {
  const summary = getSummaryRecord(session);
  const status = stringField(session, 'status') || job.status;
  const total = numberField(session, 'total') ?? numberField(summary, 'totalTasks');
  const completed = numberField(session, 'completed') ?? numberField(summary, 'completed');
  const failed = numberField(session, 'failed') ?? numberField(summary, 'failed');
  const computedPercent =
    typeof total === 'number' && total > 0 && typeof completed === 'number'
      ? Math.round((((completed || 0) + (failed || 0)) / total) * 100)
      : undefined;
  const fallbackPercent = fallbackPercentForStatus(job.status);
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
  setNumber(progress, 'completed', completed);
  setNumber(progress, 'failed', failed);
  setNumber(progress, 'filling', numberField(session, 'filling'));
  setNumber(progress, 'percent', percent);
  setNumber(progress, 'skeleton', numberField(session, 'skeleton'));
  setNumber(progress, 'total', total);
  setNumber(progress, 'totalToolCalls', numberField(session, 'totalToolCalls'));

  const sessionId = getSessionId(session);
  if (sessionId) {
    progress.sessionId = sessionId;
  }

  return progress;
}

function getJobSummary(
  job: DaemonJobRecord,
  session: Record<string, unknown> | null
): Record<string, unknown> | undefined {
  const sessionSummary = getSummaryRecord(session);
  if (sessionSummary) {
    return sessionSummary;
  }

  const result = asRecordOrNull(job.result);
  const candidateSummary = asRecordOrNull(result?.bootstrapCandidates);
  return candidateSummary || undefined;
}

function getSummaryRecord(
  session: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  return asRecordOrNull(session?.summary);
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

function getActiveTask(
  session: Record<string, unknown> | null
): { id?: string; label?: string } | null {
  const tasks = Array.isArray(session?.tasks) ? session.tasks : [];
  const task = tasks
    .map((value) => asRecordOrNull(value))
    .find((candidate) => candidate?.status === 'filling');
  if (!task) {
    return null;
  }
  const meta = asRecordOrNull(task.meta);
  return {
    id: stringField(task, 'id'),
    label: stringField(meta, 'label') || stringField(meta, 'dimId') || stringField(task, 'id'),
  };
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
  return req.headers['x-alembic-daemon-token'] ? 'codex' : 'dashboard';
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

import {
  type DaemonJobKind,
  type DaemonJobRecord,
  type DaemonJobSource,
  type DaemonJobStatus,
  JobStore,
} from '@alembic/core/daemon';
import { resolveProjectRoot } from '@alembic/core/workspace';
import type { ServiceContainer } from '../injection/ServiceContainer.js';
import {
  JobProcessEventRecorder,
  type JobProcessEventRecordInput,
} from './JobProcessEventRecorder.js';

interface LoggerLike {
  error(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

type BootstrapProcessEventName =
  | 'bootstrap:all-completed'
  | 'bootstrap:started'
  | 'bootstrap:task-completed'
  | 'bootstrap:task-failed'
  | 'bootstrap:task-started';

const fallbackJobProcessEventRecorder = new JobProcessEventRecorder();

export interface DaemonJobOptions {
  args?: Record<string, unknown>;
  container: ServiceContainer;
  kind: DaemonJobKind;
  logger: LoggerLike;
  source?: DaemonJobSource;
}

export interface RunDaemonJobOptions extends DaemonJobOptions {
  jobId: string;
}

export interface RunDaemonJobResult {
  job: DaemonJobRecord | null;
  result: unknown;
}

export function createDaemonJob(options: DaemonJobOptions): DaemonJobRecord {
  const store = getJobStore(options.container);
  return store.create({
    kind: options.kind,
    request: options.args || {},
    source: options.source || 'system',
  });
}

export function enqueueDaemonJob(options: DaemonJobOptions): DaemonJobRecord {
  const job = createDaemonJob(options);
  const recorder = getJobProcessEventRecorder(options.container);
  recorder.resetJob(job.id);
  recordJobProcessEvent(recorder, {
    jobId: job.id,
    kind: 'workflow',
    metadata: {
      kind: options.kind,
      requestKeys: Object.keys(options.args || {}),
      source: options.source || 'system',
    },
    phase: 'reset',
    summary: 'Process event recorder initialized for this daemon job.',
    title: 'Process event recorder reset',
  });
  recordJobProcessEvent(recorder, {
    jobId: job.id,
    kind: 'workflow',
    metadata: {
      kind: options.kind,
      source: options.source || 'system',
    },
    phase: 'queued',
    summary: `${options.kind} job accepted by the daemon queue.`,
    title: 'Daemon job enqueued',
  });
  options.logger.info('Daemon job enqueued', {
    jobId: job.id,
    kind: options.kind,
    source: options.source || 'system',
    request: options.args || {},
  });
  queueMicrotask(() => {
    void runDaemonJob({ ...options, jobId: job.id }).catch((err: unknown) => {
      options.logger.error('Daemon job failed after enqueue', {
        jobId: job.id,
        kind: options.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
  return job;
}

export async function runDaemonJob(options: RunDaemonJobOptions): Promise<RunDaemonJobResult> {
  const store = getJobStore(options.container);
  const recorder = getJobProcessEventRecorder(options.container);
  const bootstrapBridge =
    options.kind === 'bootstrap'
      ? attachBootstrapProcessEventBridge({
          container: options.container,
          jobId: options.jobId,
          logger: options.logger,
          recorder,
        })
      : null;
  let keepBootstrapBridge = false;
  const runningJob = store.markRunning(options.jobId);
  if (!runningJob) {
    bootstrapBridge?.();
    throw new Error(`Daemon job not found: ${options.jobId}`);
  }

  recordJobProcessEvent(recorder, {
    jobId: options.jobId,
    kind: 'workflow',
    metadata: {
      kind: options.kind,
      source: options.source || 'system',
    },
    phase: 'running',
    summary: `${options.kind} job execution started.`,
    title: 'Daemon job started',
  });
  options.logger.info('Daemon job started', {
    jobId: options.jobId,
    kind: options.kind,
    source: options.source,
  });

  try {
    const result = await executeInternalWorkflow(options);
    const bootstrapSessionId = extractBootstrapSessionId(result);

    if (bootstrapSessionId && isBootstrapSessionRunning(result, options.container)) {
      const job = store.update(options.jobId, {
        result,
        bootstrapSessionId,
        status: 'running',
      });
      options.logger.info('Daemon job linked to running bootstrap session', {
        jobId: options.jobId,
        kind: options.kind,
        bootstrapSessionId,
        stage: 'bootstrap-session-running',
      });
      recordJobProcessEvent(recorder, {
        jobId: options.jobId,
        kind: 'checkpoint',
        metadata: { bootstrapSessionId },
        phase: 'session',
        summary: 'Daemon job is now following the live bootstrap session.',
        title: 'Bootstrap session linked',
      });
      keepBootstrapBridge = true;
      linkBootstrapSessionCompletion({
        bootstrapSessionId,
        container: options.container,
        fallbackResult: result,
        jobId: options.jobId,
        logger: options.logger,
        recorder,
        store,
      });
      return { job, result };
    }

    const job = store.complete(options.jobId, result, { bootstrapSessionId });
    recordJobProcessEvent(recorder, {
      artifactRefs: buildJobResultArtifactRefs(job),
      jobId: options.jobId,
      kind: 'artifact',
      metadata: {
        bootstrapSessionId: bootstrapSessionId || null,
        status: 'completed',
      },
      phase: 'artifact',
      summary: 'Daemon job result is available from the jobs API.',
      title: 'Daemon job result retained',
    });
    recordJobProcessEvent(recorder, {
      jobId: options.jobId,
      kind: 'summary',
      metadata: {
        bootstrapSessionId: bootstrapSessionId || null,
        status: 'completed',
      },
      phase: 'complete',
      severity: 'success',
      summary: `${options.kind} job completed.`,
      title: 'Daemon job completed',
    });
    options.logger.info('Daemon job completed', {
      jobId: options.jobId,
      kind: options.kind,
      bootstrapSessionId: bootstrapSessionId || null,
      stage: 'job-complete',
    });
    return { job, result };
  } catch (err: unknown) {
    options.logger.error('Daemon job failed', {
      jobId: options.jobId,
      kind: options.kind,
      source: options.source,
      error: err instanceof Error ? err.message : String(err),
      stage: 'job-failed',
    });
    store.fail(options.jobId, err);
    recordJobProcessEvent(recorder, {
      content: {
        mimeType: 'text/plain',
        role: 'assistant',
        text: err instanceof Error ? err.message : String(err),
      },
      jobId: options.jobId,
      kind: 'error',
      metadata: {
        kind: options.kind,
        source: options.source || 'system',
      },
      phase: 'failed',
      summary: err instanceof Error ? err.message : String(err),
      title: 'Daemon job failed',
    });
    throw err;
  } finally {
    if (!keepBootstrapBridge) {
      bootstrapBridge?.();
    }
  }
}

export function cancelDaemonJob(options: {
  container: ServiceContainer;
  jobId: string;
  reason?: string;
}): DaemonJobRecord | null {
  const store = getJobStore(options.container);
  const job = store.get(options.jobId);
  if (!job) {
    return null;
  }
  const reason = options.reason || 'Cancelled';
  const recorder = getJobProcessEventRecorder(options.container);
  recordJobProcessEvent(recorder, {
    jobId: options.jobId,
    kind: 'workflow',
    metadata: { reason },
    phase: 'cancel',
    severity: 'warning',
    summary: reason,
    title: 'Daemon job cancellation requested',
  });
  const bootstrapSessionId = job.bootstrapSessionId;
  const taskManager = getOptionalService<{
    abortSession(reason: string): void;
    getSessionStatus(): Record<string, unknown>;
    isRunning: boolean;
    markCancelled(): void;
  }>(options.container, 'bootstrapTaskManager');
  const status = taskManager?.getSessionStatus();
  if (taskManager && bootstrapSessionId && status?.id === bootstrapSessionId) {
    if (taskManager.isRunning) {
      taskManager.abortSession(reason);
    } else {
      taskManager.markCancelled();
    }
    return finalizeBootstrapJobFromSession({
      bootstrapSessionId,
      fallbackResult: job.result,
      jobId: options.jobId,
      recorder,
      session: taskManager.getSessionStatus(),
      store,
    });
  }
  const cancelled = store.cancel(options.jobId, reason);
  if (cancelled) {
    recordJobProcessEvent(recorder, {
      jobId: options.jobId,
      kind: 'summary',
      metadata: { reason },
      phase: 'cancelled',
      severity: 'warning',
      summary: reason,
      title: 'Daemon job cancelled',
    });
  }
  return cancelled;
}

export function markInterruptedDaemonJobs(options: {
  code?: string;
  container: ServiceContainer;
  logger: LoggerLike;
  reason: string;
}): DaemonJobRecord[] {
  const store = getJobStore(options.container);
  const jobs = store.markActiveInterrupted({
    code: options.code,
    reason: options.reason,
  });
  if (jobs.length > 0) {
    options.logger.warn('Marked interrupted daemon jobs as failed', {
      count: jobs.length,
      jobIds: jobs.map((job) => job.id),
      reason: options.reason,
    });
  }
  return jobs;
}

export function getJobStore(container: ServiceContainer): JobStore {
  try {
    return container.get('jobStore');
  } catch {
    return new JobStore({ projectRoot: resolveProjectRoot(container) });
  }
}

export function getJobProcessEventRecorder(container: ServiceContainer): JobProcessEventRecorder {
  try {
    return container.get('jobProcessEventRecorder');
  } catch {
    return fallbackJobProcessEventRecorder;
  }
}

function attachBootstrapProcessEventBridge(options: {
  container: ServiceContainer;
  jobId: string;
  logger: LoggerLike;
  recorder: JobProcessEventRecorder;
}): (() => void) | null {
  const eventBus = getOptionalService<{
    off(eventName: BootstrapProcessEventName, listener: (payload: unknown) => void): void;
    on(eventName: BootstrapProcessEventName, listener: (payload: unknown) => void): void;
  }>(options.container, 'eventBus');
  if (!eventBus) {
    return null;
  }

  let currentSessionId: string | undefined;
  let closed = false;
  const listeners: Array<[BootstrapProcessEventName, (payload: unknown) => void]> = [];

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    for (const [eventName, listener] of listeners) {
      try {
        eventBus.off(eventName, listener);
      } catch {
        /* best effort */
      }
    }
  };

  const subscribe = (
    eventName: BootstrapProcessEventName,
    listener: (payload: unknown) => void
  ) => {
    eventBus.on(eventName, listener);
    listeners.push([eventName, listener]);
  };

  const shouldAccept = (payload: Record<string, unknown>): boolean => {
    const payloadSessionId = stringValue(payload.sessionId) || stringValue(payload.id);
    if (payloadSessionId) {
      if (!currentSessionId) {
        currentSessionId = payloadSessionId;
      }
      return currentSessionId === payloadSessionId;
    }
    return !currentSessionId;
  };

  subscribe('bootstrap:started', (payload: unknown) => {
    const event = asRecord(payload);
    if (!shouldAccept(event)) {
      return;
    }
    recordJobProcessEvent(options.recorder, {
      artifactRefs: buildBootstrapArtifactRefs(event, 'bootstrap-session'),
      jobId: options.jobId,
      kind: 'workflow',
      metadata: {
        sessionId: currentSessionId || null,
        total: numberValue(event.total) ?? null,
      },
      phase: 'session',
      summary: `Bootstrap session started with ${numberValue(event.total) ?? 0} tasks.`,
      title: 'Bootstrap session started',
    });
  });

  subscribe('bootstrap:task-started', (payload: unknown) => {
    const event = asRecord(payload);
    if (!shouldAccept(event)) {
      return;
    }
    const taskId = stringValue(event.taskId) || extractDimensionId(event) || 'unknown-task';
    const label = extractTaskLabel(event) || taskId;
    recordJobProcessEvent(options.recorder, {
      dimensionId: extractDimensionId(event) || taskId,
      jobId: options.jobId,
      kind: 'workflow',
      metadata: {
        progress: numberValue(event.progress) ?? null,
        sessionId: currentSessionId || null,
        taskId,
      },
      phase: 'dimension',
      summary: `${label} started.`,
      targetName: label,
      title: 'Bootstrap dimension started',
    });
  });

  subscribe('bootstrap:task-completed', (payload: unknown) => {
    const event = asRecord(payload);
    if (!shouldAccept(event)) {
      return;
    }
    const taskId = stringValue(event.taskId) || extractDimensionId(event) || 'unknown-task';
    const label = extractTaskLabel(event) || taskId;
    const result = asRecord(event.result);
    recordJobProcessEvent(options.recorder, {
      artifactRefs: buildBootstrapArtifactRefs(
        {
          ...event,
          taskId,
        },
        'bootstrap-task'
      ),
      dimensionId: extractDimensionId(event) || taskId,
      displayPolicy: 'summary-only',
      jobId: options.jobId,
      kind: 'summary',
      metadata: {
        completed: numberValue(event.completed) ?? null,
        created: numberValue(result.created) ?? null,
        extracted: numberValue(result.extracted) ?? null,
        progress: numberValue(event.progress) ?? null,
        sessionId: currentSessionId || null,
        status: stringValue(result.status) || 'completed',
        taskId,
        total: numberValue(event.total) ?? null,
        totalToolCalls: numberValue(event.totalToolCalls) ?? null,
      },
      phase: 'dimension',
      severity: result.degraded === true ? 'warning' : 'success',
      summary: `${label} completed.`,
      targetName: label,
      title: 'Bootstrap dimension completed',
    });
  });

  subscribe('bootstrap:task-failed', (payload: unknown) => {
    const event = asRecord(payload);
    if (!shouldAccept(event)) {
      return;
    }
    const taskId = stringValue(event.taskId) || extractDimensionId(event) || 'unknown-task';
    const label = extractTaskLabel(event) || taskId;
    const error = stringValue(event.error) || 'Bootstrap task failed.';
    recordJobProcessEvent(options.recorder, {
      content: {
        mimeType: 'text/plain',
        role: 'assistant',
        text: error,
      },
      dimensionId: extractDimensionId(event) || taskId,
      jobId: options.jobId,
      kind: 'error',
      metadata: {
        progress: numberValue(event.progress) ?? null,
        sessionId: currentSessionId || null,
        taskId,
      },
      phase: 'dimension',
      summary: error,
      targetName: label,
      title: 'Bootstrap dimension failed',
    });
  });

  subscribe('bootstrap:all-completed', (payload: unknown) => {
    const event = asRecord(payload);
    if (!shouldAccept(event)) {
      return;
    }
    const status = stringValue(event.status) || 'completed';
    const summary = asRecord(event.summary);
    recordJobProcessEvent(options.recorder, {
      artifactRefs: buildBootstrapArtifactRefs(event, 'bootstrap-session-summary'),
      displayPolicy: 'summary-only',
      jobId: options.jobId,
      kind: 'summary',
      metadata: {
        cancelled: numberValue(summary.cancelled) ?? null,
        completed: numberValue(summary.completed) ?? null,
        failed: numberValue(summary.failed) ?? null,
        sessionId: currentSessionId || null,
        status,
        totalTasks: numberValue(summary.totalTasks) ?? null,
      },
      phase: 'session',
      severity:
        status === 'completed_with_errors' || status === 'failed'
          ? 'warning'
          : status === 'aborted'
            ? 'warning'
            : 'success',
      summary: `Bootstrap session ${status}.`,
      title: 'Bootstrap session completed',
    });
    cleanup();
  });

  options.logger.info('Bootstrap process event bridge attached', {
    jobId: options.jobId,
  });
  return cleanup;
}

async function executeInternalWorkflow(options: RunDaemonJobOptions): Promise<unknown> {
  if (options.kind === 'bootstrap') {
    const { bootstrapKnowledge } = await import('../resident/tool-handlers/bootstrap-internal.js');
    const raw = await bootstrapKnowledge(
      { container: options.container, logger: options.logger },
      {
        maxFiles: numberArg(options.args?.maxFiles, 500),
        skipGuard: Boolean(options.args?.skipGuard || false),
        contentMaxLines: numberArg(options.args?.contentMaxLines, 120),
        loadSkills: true,
      }
    );
    const result = unwrapEnvelope(raw);
    return { ...asRecord(result), asyncFill: true };
  }

  const { rescanInternal } = await import('../resident/tool-handlers/rescan-internal.js');
  const raw = await rescanInternal(
    { container: options.container, logger: options.logger },
    {
      reason:
        (options.args?.reason as string | undefined) || `${options.source || 'daemon'}-rescan`,
      dimensions: Array.isArray(options.args?.dimensions)
        ? options.args.dimensions.filter(
            (dimension): dimension is string => typeof dimension === 'string'
          )
        : undefined,
    }
  );
  const result = unwrapEnvelope(raw);
  return { ...asRecord(result), asyncFill: true };
}

function linkBootstrapSessionCompletion(options: {
  bootstrapSessionId: string;
  container: ServiceContainer;
  fallbackResult: unknown;
  jobId: string;
  logger: LoggerLike;
  recorder: JobProcessEventRecorder;
  store: JobStore;
}): void {
  const completeFromSession = (session: Record<string, unknown>) => {
    const job = finalizeBootstrapJobFromSession({
      bootstrapSessionId: options.bootstrapSessionId,
      fallbackResult: options.fallbackResult,
      jobId: options.jobId,
      recorder: options.recorder,
      session,
      store: options.store,
    });
    options.logger.info('Daemon bootstrap job finalized from session', {
      jobId: options.jobId,
      bootstrapSessionId: options.bootstrapSessionId,
      cancelReason: bootstrapSessionReason(session) || null,
      sessionStatus: stringValue(session.status) || null,
      stage: 'bootstrap-session-finalize',
      status: job?.status || null,
    });
  };

  const taskManager = getOptionalService<{ getSessionStatus(): Record<string, unknown> }>(
    options.container,
    'bootstrapTaskManager'
  );
  const currentStatus = taskManager?.getSessionStatus();
  if (currentStatus?.id === options.bootstrapSessionId && currentStatus.status !== 'running') {
    completeFromSession(currentStatus);
    return;
  }

  const eventBus = getOptionalService<{
    off(eventName: string, listener: (payload: unknown) => void): void;
    on(eventName: string, listener: (payload: unknown) => void): void;
  }>(options.container, 'eventBus');
  if (!eventBus) {
    options.logger.warn('Daemon job could not subscribe to bootstrap completion events', {
      jobId: options.jobId,
      bootstrapSessionId: options.bootstrapSessionId,
    });
    return;
  }

  const listener = (payload: unknown) => {
    const session = asRecord(payload);
    if (session.sessionId !== options.bootstrapSessionId) {
      return;
    }
    eventBus.off('bootstrap:all-completed', listener);
    completeFromSession(session);
  };
  eventBus.on('bootstrap:all-completed', listener);
}

function finalizeBootstrapJobFromSession(options: {
  bootstrapSessionId?: string;
  fallbackResult: unknown;
  jobId: string;
  recorder?: JobProcessEventRecorder;
  session: Record<string, unknown>;
  store: JobStore;
}): DaemonJobRecord | null {
  const current = options.store.get(options.jobId);
  if (!current || isTerminalJobStatus(current.status)) {
    return current;
  }

  const status = classifyBootstrapSessionForJob(options.session);
  const result = {
    ...asRecord(options.fallbackResult),
    finalSession: options.session,
  };

  if (status === 'cancelled') {
    const job = options.store.update(options.jobId, {
      bootstrapSessionId: options.bootstrapSessionId,
      completedAt: new Date().toISOString(),
      error: { message: bootstrapSessionReason(options.session) || 'Cancelled' },
      result,
      status,
    });
    recordJobProcessEvent(options.recorder, {
      artifactRefs: buildJobResultArtifactRefs(job),
      jobId: options.jobId,
      kind: 'summary',
      metadata: {
        bootstrapSessionId: options.bootstrapSessionId || null,
        sessionStatus: stringValue(options.session.status) || null,
        status,
      },
      phase: 'cancelled',
      severity: 'warning',
      summary: bootstrapSessionReason(options.session) || 'Bootstrap job cancelled.',
      title: 'Bootstrap job cancelled',
    });
    return job;
  }

  if (status === 'failed') {
    const job = options.store.update(options.jobId, {
      bootstrapSessionId: options.bootstrapSessionId,
      completedAt: new Date().toISOString(),
      error: {
        message: bootstrapSessionReason(options.session) || 'Bootstrap completed with errors',
      },
      result,
      status,
    });
    recordJobProcessEvent(options.recorder, {
      artifactRefs: buildJobResultArtifactRefs(job),
      jobId: options.jobId,
      kind: 'summary',
      metadata: {
        bootstrapSessionId: options.bootstrapSessionId || null,
        sessionStatus: stringValue(options.session.status) || null,
        status,
      },
      phase: 'failed',
      severity: 'error',
      summary: bootstrapSessionReason(options.session) || 'Bootstrap completed with errors.',
      title: 'Bootstrap job failed',
    });
    return job;
  }

  const job = options.store.complete(options.jobId, result, {
    bootstrapSessionId: options.bootstrapSessionId,
  });
  recordJobProcessEvent(options.recorder, {
    artifactRefs: buildJobResultArtifactRefs(job),
    jobId: options.jobId,
    kind: 'artifact',
    metadata: {
      bootstrapSessionId: options.bootstrapSessionId || null,
      status: 'completed',
    },
    phase: 'artifact',
    severity: 'success',
    summary: 'Final bootstrap session is retained in the daemon job record.',
    title: 'Bootstrap final session retained',
  });
  recordJobProcessEvent(options.recorder, {
    jobId: options.jobId,
    kind: 'summary',
    metadata: {
      bootstrapSessionId: options.bootstrapSessionId || null,
      sessionStatus: stringValue(options.session.status) || null,
      status: 'completed',
    },
    phase: 'complete',
    severity: 'success',
    summary: 'Bootstrap job completed from the live session.',
    title: 'Bootstrap job completed',
  });
  return job;
}

function classifyBootstrapSessionForJob(session: Record<string, unknown>): DaemonJobStatus {
  const status = stringValue(session.status);
  const summary = asRecord(session.summary);
  if (status === 'aborted' || summary.aborted === true || session.userCancelled === true) {
    return 'cancelled';
  }
  if (status === 'failed' || status === 'completed_with_errors') {
    return 'failed';
  }
  return 'completed';
}

function bootstrapSessionReason(session: Record<string, unknown>): string | undefined {
  const summary = asRecord(session.summary);
  return stringValue(summary.reason) || stringValue(session.error);
}

function isTerminalJobStatus(status: DaemonJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function extractBootstrapSessionId(result: unknown): string | undefined {
  const session = asRecord(result).bootstrapSession;
  return typeof session === 'object' &&
    session &&
    typeof (session as { id?: unknown }).id === 'string'
    ? (session as { id: string }).id
    : undefined;
}

function isBootstrapSessionRunning(result: unknown, container: ServiceContainer): boolean {
  const bootstrapSessionId = extractBootstrapSessionId(result);
  if (!bootstrapSessionId) {
    return false;
  }
  const taskManager = getOptionalService<{ getSessionStatus(): Record<string, unknown> }>(
    container,
    'bootstrapTaskManager'
  );
  const status = taskManager?.getSessionStatus();
  if (status?.id === bootstrapSessionId) {
    return status.status === 'running';
  }
  const session = asRecord(result).bootstrapSession;
  return (
    typeof session === 'object' &&
    session !== null &&
    (session as { status?: unknown }).status === 'running'
  );
}

function getOptionalService<T>(container: ServiceContainer, name: string): T | null {
  try {
    return container.get(name) as T;
  } catch {
    return null;
  }
}

function recordJobProcessEvent(
  recorder: JobProcessEventRecorder | null | undefined,
  input: JobProcessEventRecordInput
): void {
  if (!recorder) {
    return;
  }
  try {
    recorder.record(input);
  } catch {
    /* Process event recording must never fail the daemon job itself. */
  }
}

function buildJobResultArtifactRefs(job: DaemonJobRecord | null | undefined) {
  if (!job) {
    return [];
  }
  return [
    {
      kind: 'daemon-job',
      label: 'Daemon job record',
      mimeType: 'application/json',
      ref: `/api/v1/jobs/${encodeURIComponent(job.id)}`,
    },
  ];
}

function buildBootstrapArtifactRefs(
  payload: Record<string, unknown>,
  kind: 'bootstrap-session' | 'bootstrap-session-summary' | 'bootstrap-task'
) {
  const sessionId = stringValue(payload.sessionId) || stringValue(payload.id);
  if (!sessionId) {
    return [];
  }
  const taskId = stringValue(payload.taskId);
  const suffix = taskId ? `:task:${taskId}` : '';
  const label =
    kind === 'bootstrap-task'
      ? `Bootstrap task ${taskId || 'unknown'}`
      : kind === 'bootstrap-session-summary'
        ? 'Bootstrap session summary'
        : 'Bootstrap session';
  return [
    {
      kind,
      label,
      mimeType: 'application/json',
      ref: `bootstrap-session:${sessionId}${suffix}`,
    },
  ];
}

function extractTaskLabel(payload: Record<string, unknown>): string | undefined {
  const meta = asRecord(payload.meta);
  return (
    stringValue(meta.label) ||
    stringValue(meta.dimId) ||
    stringValue(payload.dimensionId) ||
    stringValue(payload.taskId)
  );
}

function extractDimensionId(payload: Record<string, unknown>): string | undefined {
  const meta = asRecord(payload.meta);
  return stringValue(payload.dimensionId) || stringValue(meta.dimId) || stringValue(payload.taskId);
}

function unwrapEnvelope(raw: unknown): unknown {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (parsed && typeof parsed === 'object' && 'data' in parsed) {
    return (parsed as { data?: unknown }).data || parsed;
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : { value };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

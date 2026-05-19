import {
  type DaemonJobKind,
  type DaemonJobRecord,
  type DaemonJobSource,
  type DaemonJobStatus,
  JobStore,
} from '@alembic/core/daemon';
import { resolveProjectRoot } from '@alembic/core/workspace';
import type { ServiceContainer } from '../injection/ServiceContainer.js';

interface LoggerLike {
  error(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

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
  const runningJob = store.markRunning(options.jobId);
  if (!runningJob) {
    throw new Error(`Daemon job not found: ${options.jobId}`);
  }

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
      linkBootstrapSessionCompletion({
        bootstrapSessionId,
        container: options.container,
        fallbackResult: result,
        jobId: options.jobId,
        logger: options.logger,
        store,
      });
      return { job, result };
    }

    const job = store.complete(options.jobId, result, { bootstrapSessionId });
    return { job, result };
  } catch (err: unknown) {
    store.fail(options.jobId, err);
    throw err;
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
      session: taskManager.getSessionStatus(),
      store,
    });
  }
  return store.cancel(options.jobId, reason);
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

async function executeInternalWorkflow(options: RunDaemonJobOptions): Promise<unknown> {
  if (options.kind === 'bootstrap') {
    const { bootstrapKnowledge } = await import('../external/mcp/handlers/bootstrap-internal.js');
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

  const { rescanInternal } = await import('../external/mcp/handlers/rescan-internal.js');
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
  store: JobStore;
}): void {
  const completeFromSession = (session: Record<string, unknown>) => {
    finalizeBootstrapJobFromSession({
      bootstrapSessionId: options.bootstrapSessionId,
      fallbackResult: options.fallbackResult,
      jobId: options.jobId,
      session,
      store: options.store,
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
    return options.store.update(options.jobId, {
      bootstrapSessionId: options.bootstrapSessionId,
      completedAt: new Date().toISOString(),
      error: { message: bootstrapSessionReason(options.session) || 'Cancelled' },
      result,
      status,
    });
  }

  if (status === 'failed') {
    return options.store.update(options.jobId, {
      bootstrapSessionId: options.bootstrapSessionId,
      completedAt: new Date().toISOString(),
      error: {
        message: bootstrapSessionReason(options.session) || 'Bootstrap completed with errors',
      },
      result,
      status,
    });
  }

  return options.store.complete(options.jobId, result, {
    bootstrapSessionId: options.bootstrapSessionId,
  });
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

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

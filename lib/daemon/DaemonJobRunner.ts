import type { DaemonJobRecord, DaemonJobStatus, JobStore } from '@alembic/core/daemon';
import type { CoverageLedgerRepository, DeepMiningRoundRecord } from '@alembic/core/repositories';
import { resolveDataRoot } from '@alembic/core/workspace';
import type { ServiceContainer } from '../injection/ServiceContainer.js';
import {
  resolveProjectScopeAnalysisContext,
  resolveProjectScopeSourceIdentitiesFromContainer,
} from '../project-scope/ProjectScopeAnalysis.js';
import { runDeepMiningRounds } from '../recipe-pipeline/generate/DeepMiningRoundGate.js';
import { runModuleMiningWorkflow } from '../recipe-pipeline/generate/ModuleMiningWorkflow.js';
import type { GenerateProcessEventDraft } from '../recipe-pipeline/generate/runtime/generate-event-types.js';
import { runGeneratePlanGate } from '../recipe-pipeline/plan/PlanSelectionGate.js';
import { releaseProjectContextWorkflowSessionByProjectRoot } from '../workflows/project-context/ProjectContextWorkflowFacts.js';
import {
  getJobDisplaySnapshotStore,
  getJobProcessEventRecorder,
  getJobStore,
} from './DaemonJobServices.js';
import {
  asRecord,
  buildDaemonRescanWorkflowArgs,
  finiteNumber,
  generationStageArg,
  getOptionalService,
  isRecord,
  numberValue,
  recordJobProcessEvent,
  stringArrayArg,
  stringValue,
  unwrapEnvelope,
} from './DaemonJobWorkflowHelpers.js';
import type {
  DaemonJobOptions,
  LoggerLike,
  RunDaemonJobOptions,
  RunDaemonJobResult,
} from './DaemonJobWorkflowTypes.js';
import { materializeJobProcessEventTextArtifact } from './JobProcessEventArtifacts.js';
import type { JobProcessEventRecorder } from './JobProcessEventRecorder.js';
import { attachPcvN9ObservabilityCarry } from './PcvObservabilityLinkage.js';

export {
  getJobDisplaySnapshotStore,
  getJobProcessEventRecorder,
  getJobStore,
  resetDaemonJobFallbacks,
} from './DaemonJobServices.js';
export { buildDaemonRescanWorkflowArgs } from './DaemonJobWorkflowHelpers.js';
export type {
  DaemonJobOptions,
  DaemonRescanWorkflowArgs,
  RunDaemonJobOptions,
  RunDaemonJobResult,
} from './DaemonJobWorkflowTypes.js';

type BootstrapProcessEventName =
  | 'bootstrap:all-completed'
  | 'bootstrap:process-events'
  | 'bootstrap:started'
  | 'bootstrap:task-completed'
  | 'bootstrap:task-failed'
  | 'bootstrap:task-started';

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
  refreshJobDisplaySnapshot({
    container: options.container,
    jobId: job.id,
    logger: options.logger,
    recorder,
  });
  options.logger.info('Daemon job enqueued', {
    jobId: job.id,
    kind: options.kind,
    source: options.source || 'system',
    request: options.args || {},
  });
  queueMicrotask(() => {
    void runDaemonJob({ ...options, jobId: job.id }).catch((err: unknown) => {
      const failedJob = recordDaemonJobAsyncFailure({ ...options, error: err, jobId: job.id });
      options.logger.error('Daemon job failed after enqueue', {
        jobId: job.id,
        kind: options.kind,
        error: err instanceof Error ? err.message : String(err),
        status: failedJob?.status ?? 'missing',
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
      ? attachGenerateProcessEventBridge({
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
  refreshJobDisplaySnapshot({
    container: options.container,
    jobId: options.jobId,
    logger: options.logger,
    recorder,
    store,
  });
  options.logger.info('Daemon job started', {
    jobId: options.jobId,
    kind: options.kind,
    source: options.source,
  });

  try {
    const result = await executeApiAiWorkflow(options);
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
      refreshJobDisplaySnapshot({
        container: options.container,
        jobId: options.jobId,
        logger: options.logger,
        recorder,
        store,
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
    refreshJobDisplaySnapshot({
      container: options.container,
      jobId: options.jobId,
      logger: options.logger,
      recorder,
      store,
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
    refreshJobDisplaySnapshot({
      container: options.container,
      jobId: options.jobId,
      logger: options.logger,
      recorder,
      store,
    });
    throw err;
  } finally {
    if (!keepBootstrapBridge) {
      bootstrapBridge?.();
    }
  }
}

export function recordDaemonJobAsyncFailure(
  options: RunDaemonJobOptions & { error: unknown }
): DaemonJobRecord | null {
  const store = getJobStore(options.container);
  const current = store.get(options.jobId);
  if (!current || isTerminalJobStatus(current.status)) {
    return current;
  }

  const recorder = getJobProcessEventRecorder(options.container);
  const errorMessage =
    options.error instanceof Error ? options.error.message : String(options.error);
  const failedJob = store.fail(options.jobId, options.error);
  recordJobProcessEvent(recorder, {
    content: {
      mimeType: 'text/plain',
      role: 'assistant',
      text: errorMessage,
    },
    jobId: options.jobId,
    kind: 'error',
    metadata: {
      kind: options.kind,
      source: options.source || 'system',
      status: failedJob?.status ?? 'failed',
    },
    phase: 'failed',
    severity: 'error',
    summary: errorMessage,
    title: 'Daemon job failed after enqueue',
  });
  refreshJobDisplaySnapshot({
    container: options.container,
    jobId: options.jobId,
    logger: options.logger,
    recorder,
    store,
  });
  return failedJob;
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
  }>(options.container, 'generateTaskManager');
  const status = taskManager?.getSessionStatus();
  if (taskManager && bootstrapSessionId && status?.id === bootstrapSessionId) {
    if (taskManager.isRunning) {
      taskManager.abortSession(reason);
    } else {
      taskManager.markCancelled();
    }
    const finalized = finalizeBootstrapJobFromSession({
      bootstrapSessionId,
      fallbackResult: job.result,
      jobId: options.jobId,
      recorder,
      session: taskManager.getSessionStatus(),
      store,
    });
    refreshJobDisplaySnapshot({
      container: options.container,
      jobId: options.jobId,
      recorder,
      store,
    });
    return finalized;
  }
  const cancelled = store.cancel(options.jobId, reason);
  if (cancelled) {
    cleanupCancelledRescanJob({
      container: options.container,
      job,
      reason,
      recorder,
    });
    recordJobProcessEvent(recorder, {
      jobId: options.jobId,
      kind: 'summary',
      metadata: { reason },
      phase: 'cancelled',
      severity: 'warning',
      summary: reason,
      title: 'Daemon job cancelled',
    });
    refreshJobDisplaySnapshot({
      container: options.container,
      jobId: options.jobId,
      recorder,
      store,
    });
  }
  return cancelled;
}

function cleanupCancelledRescanJob(options: {
  container: ServiceContainer;
  job: DaemonJobRecord;
  reason: string;
  recorder: JobProcessEventRecorder;
}): void {
  if (options.job.kind !== 'rescan') {
    return;
  }

  const logger = getCancellationCleanupLogger(options.container);
  let projectRoot: string;
  try {
    projectRoot = resolveProjectScopeAnalysisContext(options.container).projectRoot;
  } catch (err: unknown) {
    projectRoot = options.job.projectRoot;
    logger.warn('Rescan cancellation cleanup fell back to job projectRoot', {
      error: err instanceof Error ? err.message : String(err),
      jobId: options.job.id,
      projectRoot,
      stage: 'rescan-cancel-cleanup-project-root',
    });
  }

  const sessionRelease = releaseProjectContextWorkflowSessionByProjectRoot({
    container: options.container,
    logger,
    projectRoot,
    reason: 'rescan:bootstrap-session-cancelled',
  });
  if (sessionRelease.released) {
    recordJobProcessEvent(options.recorder, {
      jobId: options.job.id,
      kind: 'summary',
      metadata: {
        projectRoot,
        reason: options.reason,
        workflowSessionId: sessionRelease.workflowSessionId,
      },
      phase: 'cancelled',
      severity: 'warning',
      summary: 'Rescan cancellation released the ProjectContext workflow session lease.',
      title: 'Rescan workflow session released',
    });
  }

  closeCancelledDeepMiningRounds({
    ...options,
    logger,
    projectRoot,
  });
}

function closeCancelledDeepMiningRounds(options: {
  container: ServiceContainer;
  job: DaemonJobRecord;
  logger: LoggerLike;
  projectRoot: string;
  reason: string;
  recorder: JobProcessEventRecorder;
}): void {
  const repository = getOptionalService<CoverageLedgerRepository>(
    options.container,
    'coverageLedgerRepository'
  );
  if (!repository || typeof repository.listRoundsByProjectRoot !== 'function') {
    return;
  }

  const openRounds = repository
    .listRoundsByProjectRoot(options.projectRoot)
    .filter((round) => isOpenRoundForJob(round, options.job.id));
  if (openRounds.length === 0) {
    return;
  }

  for (const round of openRounds) {
    const completedAt = Date.now();
    try {
      repository.upsertRound({
        completedAt,
        newRecipesThisRound: round.newRecipesThisRound ?? 0,
        projectRoot: options.projectRoot,
        rescanId: round.rescanId,
        roundIndex: round.roundIndex,
        startedAt: round.startedAt,
        triggerActor: round.triggerActor ?? 'daemon-job-runner',
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      options.logger.error('Rescan cancellation could not close open deepMining round', {
        error,
        jobId: options.job.id,
        projectRoot: options.projectRoot,
        rescanId: round.rescanId,
        roundIndex: round.roundIndex,
        stage: 'deep-mining-round-cancel-close',
      });
      recordJobProcessEvent(options.recorder, {
        content: {
          mimeType: 'text/plain',
          role: 'assistant',
          text: error,
        },
        jobId: options.job.id,
        kind: 'error',
        metadata: {
          projectRoot: options.projectRoot,
          rescanId: round.rescanId,
          roundIndex: round.roundIndex,
        },
        phase: 'deep-mining',
        severity: 'error',
        summary: `deepMining round ${round.roundIndex} cancellation cleanup failed: ${error}`,
        title: 'DeepMining round cancellation cleanup failed',
      });
      continue;
    }

    options.logger.warn('DeepMining round cancelled; marked round closed', {
      completedAt,
      jobId: options.job.id,
      projectRoot: options.projectRoot,
      reason: options.reason,
      rescanId: round.rescanId,
      roundIndex: round.roundIndex,
      stage: 'deep-mining-round-cancel-closed',
    });
    recordJobProcessEvent(options.recorder, {
      jobId: options.job.id,
      kind: 'summary',
      metadata: {
        completedAt,
        projectRoot: options.projectRoot,
        rescanId: round.rescanId,
        roundIndex: round.roundIndex,
      },
      phase: 'deep-mining',
      severity: 'warning',
      summary: `deepMining round ${round.roundIndex} was cancelled; row was closed with 0 new recipe(s).`,
      title: 'DeepMining round cancelled closed',
    });
  }
}

function isOpenRoundForJob(round: DeepMiningRoundRecord, jobId: string): boolean {
  return (
    round.completedAt === null &&
    typeof round.rescanId === 'string' &&
    round.rescanId.startsWith(`${jobId}:deepMining:`)
  );
}

function getCancellationCleanupLogger(container: ServiceContainer): LoggerLike {
  return (
    getOptionalService<LoggerLike>(container, 'logger') ?? {
      error: () => {},
      info: () => {},
      warn: () => {},
    }
  );
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

function refreshJobDisplaySnapshot(options: {
  container: ServiceContainer;
  jobId: string;
  logger?: LoggerLike;
  recorder?: JobProcessEventRecorder | null;
  store?: JobStore;
}): void {
  try {
    const store = options.store ?? getJobStore(options.container);
    const job = store.get(options.jobId);
    if (!job) {
      return;
    }
    getJobDisplaySnapshotStore(options.container).writeFromJob({
      job,
      recorder: options.recorder,
    });
  } catch (err: unknown) {
    options.logger?.warn('Job display snapshot refresh failed', {
      error: err instanceof Error ? err.message : String(err),
      jobId: options.jobId,
      stage: 'job-display-snapshot-refresh',
    });
  }
}

export function attachGenerateProcessEventBridge(options: {
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

  const refreshSnapshot = () => {
    refreshJobDisplaySnapshot({
      container: options.container,
      jobId: options.jobId,
      logger: options.logger,
      recorder: options.recorder,
    });
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
    refreshSnapshot();
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
    refreshSnapshot();
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
    recordBootstrapProcessEventDrafts({
      defaults: {
        dimensionId: extractDimensionId(event) || taskId,
        sessionId: currentSessionId || null,
        targetName: label,
        taskId,
      },
      jobId: options.jobId,
      payload: result.processEvents,
      container: options.container,
      recorder: options.recorder,
    });
    refreshSnapshot();
  });

  subscribe('bootstrap:process-events', (payload: unknown) => {
    const event = asRecord(payload);
    if (!shouldAccept(event)) {
      return;
    }
    const taskId = stringValue(event.taskId) || extractDimensionId(event) || undefined;
    recordBootstrapProcessEventDrafts({
      defaults: {
        dimensionId: extractDimensionId(event) || taskId || null,
        sessionId: currentSessionId || stringValue(event.sessionId) || null,
        targetName: stringValue(event.targetName) || extractTaskLabel(event) || taskId || null,
        taskId: taskId || null,
      },
      jobId: options.jobId,
      payload: event.events,
      container: options.container,
      recorder: options.recorder,
    });
    refreshSnapshot();
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
    refreshSnapshot();
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
    refreshSnapshot();
    cleanup();
  });

  options.logger.info('Bootstrap process event bridge attached', {
    jobId: options.jobId,
  });
  return cleanup;
}

async function executeApiAiWorkflow(options: RunDaemonJobOptions): Promise<unknown> {
  if (options.kind === 'bootstrap') {
    const planGate = await runGeneratePlanGate(options);
    const { runGenerateWorkflow } = await import('../recipe-pipeline/generate/GenerateWorkflow.js');
    const raw = await runGenerateWorkflow(
      { container: options.container, logger: options.logger },
      {
        maxFiles: planGate.projection.budget.maxFiles,
        skipGuard: Boolean(options.args?.skipGuard || false),
        contentMaxLines: planGate.projection.budget.contentMaxLines,
        dimensions: stringArrayArg(options.args?.dimensions),
        loadSkills: true,
        planSelectionProjection: planGate.projection,
        projectContextFacts: planGate.projectContextFacts,
      },
      { mode: 'full' }
    );
    const result = unwrapEnvelope(raw);
    return { ...asRecord(result), asyncFill: true };
  }

  const generationStage = generationStageArg(options.args?.generationStage);
  if (generationStage === 'deepMining') {
    return runDeepMiningRounds(options);
  }
  if (generationStage === 'moduleMining') {
    return runModuleMiningWorkflow(options);
  }

  const { runGenerateWorkflow } = await import('../recipe-pipeline/generate/GenerateWorkflow.js');
  const raw = await runGenerateWorkflow(
    { container: options.container, logger: options.logger },
    buildDaemonRescanWorkflowArgs({ args: options.args, source: options.source }),
    { mode: 'incremental' }
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
    refreshJobDisplaySnapshot({
      container: options.container,
      jobId: options.jobId,
      logger: options.logger,
      recorder: options.recorder,
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
    'generateTaskManager'
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
    'generateTaskManager'
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

function recordBootstrapProcessEventDrafts({
  container,
  defaults,
  jobId,
  payload,
  recorder,
}: {
  container: ServiceContainer;
  defaults: {
    dimensionId?: string | null;
    sessionId?: string | null;
    targetName?: string | null;
    taskId?: string | null;
  };
  jobId: string;
  payload: unknown;
  recorder: JobProcessEventRecorder;
}): void {
  const drafts = normalizeBootstrapProcessEventDrafts(payload);
  for (const draft of drafts) {
    let metadata: Record<string, unknown> = {
      ...asRecord(draft.metadata),
      dimensionId: draft.dimensionId ?? defaults.dimensionId ?? null,
      sessionId: defaults.sessionId ?? null,
      taskId: defaults.taskId ?? null,
    };
    metadata = attachTraceEnvelopeJobId({
      draft,
      jobId,
      metadata,
      sessionId: defaults.sessionId ?? null,
    });
    const artifactRefs = [...(draft.artifactRefs || [])];
    const artifactCandidate = draft.textArtifactCandidate;
    if (artifactCandidate) {
      try {
        const materialized = materializeJobProcessEventTextArtifact({
          candidate: artifactCandidate,
          dataRoot: resolveDataRoot(container),
          dimensionId: draft.dimensionId ?? defaults.dimensionId ?? null,
          iteration:
            (isRecord(metadata.traceEnvelope) ? metadata.traceEnvelope.iteration : undefined) ??
            metadata.iteration,
          jobId,
        });
        artifactRefs.unshift(materialized.artifactRef);
        metadata = {
          ...metadata,
          ...materialized.metadata,
        };
      } catch (err: unknown) {
        metadata = {
          ...metadata,
          artifactRetained: false,
          artifactRetainError: err instanceof Error ? err.message : String(err),
        };
      }
    }
    metadata = attachPcvN9ObservabilityCarry({
      artifactRefs,
      draft,
      jobId,
      metadata,
      sourceIdentities: resolveProjectScopeSourceIdentitiesFromContainer(container),
    });
    recordJobProcessEvent(recorder, {
      ...draft,
      artifactRefs,
      dimensionId: draft.dimensionId ?? defaults.dimensionId ?? null,
      jobId,
      metadata,
      targetName: draft.targetName ?? defaults.targetName ?? null,
    });
  }
}

function attachTraceEnvelopeJobId({
  draft,
  jobId,
  metadata,
  sessionId,
}: {
  draft: GenerateProcessEventDraft;
  jobId: string;
  metadata: Record<string, unknown>;
  sessionId: string | null;
}): Record<string, unknown> {
  const traceEnvelope = isRecord(metadata.traceEnvelope)
    ? (metadata.traceEnvelope as Record<string, unknown>)
    : {};
  if (Object.keys(traceEnvelope).length === 0 && !isLlmEventDraft(draft)) {
    return metadata;
  }
  return {
    ...metadata,
    traceEnvelope: {
      chainNodeId: traceEnvelope.chainNodeId ?? null,
      correlationId: draft.correlationId ?? traceEnvelope.correlationId ?? null,
      dimensionId: draft.dimensionId ?? metadata.dimensionId ?? traceEnvelope.dimensionId ?? null,
      eventKind: draft.kind,
      iteration: traceEnvelope.iteration ?? finiteNumber(metadata.iteration),
      jobId,
      parentEventId: draft.parentEventId ?? traceEnvelope.parentEventId ?? null,
      phase: draft.phase ?? traceEnvelope.phase ?? null,
      nodeId: traceEnvelope.nodeId ?? null,
      pcvNodeId: traceEnvelope.pcvNodeId ?? traceEnvelope.nodeId ?? null,
      sessionId: sessionId ?? traceEnvelope.sessionId ?? null,
      stageId: traceEnvelope.stageId ?? draft.phase ?? null,
    },
  };
}

function isLlmEventDraft(draft: GenerateProcessEventDraft): boolean {
  return draft.kind === 'llm.input' || draft.kind === 'llm.output';
}

function normalizeBootstrapProcessEventDrafts(payload: unknown): GenerateProcessEventDraft[] {
  let rawDrafts: unknown[] = [];
  if (Array.isArray(payload)) {
    rawDrafts = payload;
  } else if (isRecord(payload) && Array.isArray(payload.events)) {
    rawDrafts = payload.events;
  }
  return rawDrafts.filter(isBootstrapProcessEventDraft);
}

function isBootstrapProcessEventDraft(value: unknown): value is GenerateProcessEventDraft {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.kind === 'string' && typeof value.title === 'string';
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

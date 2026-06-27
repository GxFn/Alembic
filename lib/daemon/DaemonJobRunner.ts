import type { AgentService } from '@alembic/agent/service';
import {
  type DaemonJobKind,
  type DaemonJobRecord,
  type DaemonJobSource,
  type DaemonJobStatus,
  JobStore,
} from '@alembic/core/daemon';
import { adviseCoverageLedger } from '@alembic/core/host-agent-workflows';
import {
  applyPlanSelection,
  type PlanModuleBinding,
  type PlanSelection,
  type PlanSelectionProjection,
  type PlanStageId,
} from '@alembic/core/plans';
import type {
  DeepMiningRoundRecord,
  EvolutionCoverageLedgerRepository,
} from '@alembic/core/repositories';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import type { ServiceContainer } from '../injection/ServiceContainer.js';
import {
  resolveProjectScopeAnalysisContext,
  resolveProjectScopeSourceIdentitiesFromContainer,
} from '../project-scope/ProjectScopeAnalysis.js';
import { resolveAlembicWorkspace } from '../project-scope/ProjectScopeRegistry.js';
import type { BootstrapProcessEventDraft } from '../service/bootstrap/bootstrap-event-types.js';
import {
  buildProjectContextWorkflowFacts,
  type ProjectContextWorkflowFacts,
} from '../workflows/project-context/ProjectContextWorkflowFacts.js';
import { JobDisplaySnapshotStore } from './JobDisplaySnapshotStore.js';
import { materializeJobProcessEventTextArtifact } from './JobProcessEventArtifacts.js';
import {
  JobProcessEventRecorder,
  type JobProcessEventRecordInput,
} from './JobProcessEventRecorder.js';
import { attachPcvN9ObservabilityCarry } from './PcvObservabilityLinkage.js';

interface LoggerLike {
  error(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

type BootstrapProcessEventName =
  | 'bootstrap:all-completed'
  | 'bootstrap:process-events'
  | 'bootstrap:started'
  | 'bootstrap:task-completed'
  | 'bootstrap:task-failed'
  | 'bootstrap:task-started';

/**
 * AD4 managed lifecycle: daemon-job fallbacks (used when a container lacks
 * the registered recorder/snapshot-store singletons) live inside this lazy,
 * disposable registry instead of eager module-scope instances — the recorder
 * is no longer constructed at import time.
 */
class DaemonJobFallbacks {
  #recorder: JobProcessEventRecorder | null = null;
  #snapshotStores = new Map<string, JobDisplaySnapshotStore>();

  get recorder(): JobProcessEventRecorder {
    this.#recorder ??= new JobProcessEventRecorder();
    return this.#recorder;
  }

  snapshotStore(dataRoot: string): JobDisplaySnapshotStore {
    const existing = this.#snapshotStores.get(dataRoot);
    if (existing) {
      return existing;
    }
    const store = new JobDisplaySnapshotStore({ dataRoot });
    this.#snapshotStores.set(dataRoot, store);
    return store;
  }

  clear() {
    this.#recorder = null;
    this.#snapshotStores.clear();
  }
}

let _defaultDaemonJobFallbacks: DaemonJobFallbacks | null = null;

function getDaemonJobFallbacks(): DaemonJobFallbacks {
  _defaultDaemonJobFallbacks ??= new DaemonJobFallbacks();
  return _defaultDaemonJobFallbacks;
}

/** 重置 fallback 状态（测试用） */
export function resetDaemonJobFallbacks() {
  _defaultDaemonJobFallbacks?.clear();
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

export interface DaemonRescanWorkflowArgs {
  [key: string]: unknown;
  contentMaxLines?: unknown;
  dimensions?: string[];
  maxFiles?: unknown;
  miningMode?: 'deepMining' | 'moduleMining' | 'per-module';
  moduleDimensionTargets?: ModuleDimensionTarget[];
  moduleScope?: string[];
  perDimensionTargets?: Record<string, number>;
  reason: string;
  roundIndex?: number;
}

interface ModuleDimensionTarget {
  dimensionId: string;
  moduleId?: string;
  moduleName?: string;
  targetRecipes: number;
}

interface ModuleMiningModule {
  [key: string]: unknown;
  moduleId: string;
  moduleName: string;
  modulePath?: string;
  ownedFiles?: string[];
}

export function buildDaemonRescanWorkflowArgs(options: {
  args?: Record<string, unknown>;
  source?: DaemonJobSource;
}): DaemonRescanWorkflowArgs {
  const args = options.args ?? {};
  const workflowArgs: DaemonRescanWorkflowArgs = {
    reason:
      typeof args.reason === 'string' && args.reason.trim().length > 0
        ? args.reason
        : `${options.source || 'daemon'}-rescan`,
    dimensions: Array.isArray(args.dimensions)
      ? args.dimensions.filter((dimension): dimension is string => typeof dimension === 'string')
      : undefined,
  };

  if (args.maxFiles !== undefined) {
    workflowArgs.maxFiles = args.maxFiles;
  }
  if (args.contentMaxLines !== undefined) {
    workflowArgs.contentMaxLines = args.contentMaxLines;
  }

  if (isMiningRescanArgs(args)) {
    const moduleScope = stringArrayArg(args.moduleScope);
    const perDimensionTargets = normalizeNumberRecord(args.perDimensionTargets);
    const moduleDimensionTargets = normalizeModuleDimensionTargets(args.moduleDimensionTargets);
    const miningMode = miningModeArg(args.miningMode) ?? miningModeArg(args.generationStage);
    const roundIndex = positiveIntegerArg(args.roundIndex);

    if (miningMode) {
      workflowArgs.miningMode = miningMode;
    }
    if (moduleScope) {
      workflowArgs.moduleScope = moduleScope;
    }
    if (perDimensionTargets && Object.keys(perDimensionTargets).length > 0) {
      workflowArgs.perDimensionTargets = perDimensionTargets;
    }
    if (moduleDimensionTargets.length > 0) {
      workflowArgs.moduleDimensionTargets = moduleDimensionTargets;
    }
    if (roundIndex !== undefined) {
      workflowArgs.roundIndex = roundIndex;
    }
  }

  return workflowArgs;
}

interface BootstrapPlanGateResult {
  projectContextFacts: ProjectContextWorkflowFacts;
  projection: PlanSelectionProjection;
  selection: PlanSelection;
}

interface DeepMiningRoundPlanContext {
  moduleCount: number;
  moduleDimensionTargets: ModuleDimensionTarget[];
  perDimensionTargets: Record<string, number>;
  planK?: number;
  planMaxRounds?: number;
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
  }>(options.container, 'bootstrapTaskManager');
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
    const resolver = resolveAlembicWorkspace(resolveProjectRoot(container));
    return new JobStore({ projectRoot: resolver.dataRoot });
  }
}

export function getJobProcessEventRecorder(container: ServiceContainer): JobProcessEventRecorder {
  try {
    return container.get('jobProcessEventRecorder');
  } catch {
    return getDaemonJobFallbacks().recorder;
  }
}

export function getJobDisplaySnapshotStore(container: ServiceContainer): JobDisplaySnapshotStore {
  try {
    return container.get('jobDisplaySnapshotStore');
  } catch {
    const resolver = resolveAlembicWorkspace(resolveProjectRoot(container));
    return getFallbackJobDisplaySnapshotStore(resolver.dataRoot);
  }
}

function getFallbackJobDisplaySnapshotStore(dataRoot: string): JobDisplaySnapshotStore {
  return getDaemonJobFallbacks().snapshotStore(dataRoot);
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

export function attachBootstrapProcessEventBridge(options: {
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
    const planGate = await runBootstrapPlanGate(options);
    const { runColdStartWorkflow: bootstrapKnowledge } = await import(
      '../workflows/cold-start/ColdStartWorkflow.js'
    );
    const raw = await bootstrapKnowledge(
      { container: options.container, logger: options.logger },
      {
        maxFiles: planGate.projection.budget.maxFiles,
        skipGuard: Boolean(options.args?.skipGuard || false),
        contentMaxLines: planGate.projection.budget.contentMaxLines,
        dimensions: stringArrayArg(options.args?.dimensions),
        loadSkills: true,
        planSelectionProjection: planGate.projection,
        projectContextFacts: planGate.projectContextFacts,
      }
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

  const { runKnowledgeRescanWorkflow: rescanKnowledge } = await import(
    '../workflows/knowledge-rescan/KnowledgeRescanWorkflow.js'
  );
  const raw = await rescanKnowledge(
    { container: options.container, logger: options.logger },
    buildDaemonRescanWorkflowArgs({ args: options.args, source: options.source })
  );
  const result = unwrapEnvelope(raw);
  return { ...asRecord(result), asyncFill: true };
}

async function runBootstrapPlanGate(
  options: RunDaemonJobOptions
): Promise<BootstrapPlanGateResult> {
  return runPlanSelectionGate(options, {
    generationStage: 'coldStart',
    label: 'Bootstrap',
    source: 'alembic-main-bootstrap',
  });
}

async function runPlanSelectionGate(
  options: RunDaemonJobOptions,
  gate: {
    generationStage: PlanStageId;
    label: string;
    source: 'alembic-main-bootstrap' | 'alembic-main-rescan';
  }
): Promise<BootstrapPlanGateResult> {
  const recorder = getJobProcessEventRecorder(options.container);
  const maxFiles = numberArg(options.args?.maxFiles, 500);
  const contentMaxLines = numberArg(options.args?.contentMaxLines, 120);
  const eventTitlePrefix = `${gate.label} plan gate`;

  try {
    const analysisScope = resolveProjectScopeAnalysisContext(options.container);
    const projectContextFacts = await buildProjectContextWorkflowFacts({
      analysisScope,
      contentMaxLines,
      ctx: { container: options.container, logger: options.logger },
      maxFiles,
      projectRoot: analysisScope.projectRoot,
      source: gate.source,
    });
    const { runPlanAgent } = await import('@alembic/agent/service');
    const selection = await runPlanAgent({
      agentService: options.container.get('agentService') as Pick<AgentService, 'run'>,
      generationStage: gate.generationStage,
      projectContextFacts,
    });

    // Plan gate is a hard prerequisite: shape-valid but wrong-stage selections cannot drive execution.
    if (selection.generationStage !== gate.generationStage) {
      throw new Error(
        `Plan agent returned generationStage=${selection.generationStage} for ${gate.generationStage}.`
      );
    }

    const projection = applyPlanSelection(selection);

    if (projection.executionDimensions.length === 0) {
      throw new Error(`Plan agent returned no executable dimensions for ${gate.generationStage}.`);
    }

    options.logger.info(`${eventTitlePrefix} completed`, {
      budget: projection.budget,
      executionDimensions: projection.executionDimensions,
      jobId: options.jobId,
      moduleScope: projection.moduleScope,
      stage: `${gate.generationStage}-plan-gate`,
      unknownDimensionIds: projection.unknownDimensionIds ?? [],
    });
    recordJobProcessEvent(recorder, {
      jobId: options.jobId,
      kind: 'checkpoint',
      metadata: {
        budget: projection.budget,
        executionDimensions: projection.executionDimensions,
        generationStage: gate.generationStage,
        moduleScope: projection.moduleScope,
        source: options.source || 'system',
        unknownDimensionIds: projection.unknownDimensionIds ?? [],
      },
      phase: 'plan-gate',
      severity: 'success',
      summary: `Plan agent selected ${projection.executionDimensions.length} ${gate.generationStage} dimension(s).`,
      title: `${eventTitlePrefix} completed`,
    });

    return { projectContextFacts, projection, selection };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    options.logger.error(`${eventTitlePrefix} failed; aborting ${gate.generationStage} job`, {
      error: message,
      generationStage: gate.generationStage,
      jobId: options.jobId,
      stage: `${gate.generationStage}-plan-gate`,
    });
    recordJobProcessEvent(recorder, {
      content: {
        mimeType: 'text/plain',
        role: 'assistant',
        text: `${eventTitlePrefix} failed before ${gate.generationStage}: ${message}`,
      },
      jobId: options.jobId,
      kind: 'error',
      metadata: {
        generationStage: gate.generationStage,
        source: options.source || 'system',
      },
      phase: 'plan-gate',
      severity: 'error',
      summary: `${eventTitlePrefix} failed before ${gate.generationStage}: ${message}`,
      title: `${eventTitlePrefix} failed`,
    });
    throw new Error(`${eventTitlePrefix} failed: ${message}`);
  }
}

async function runDeepMiningRounds(options: RunDaemonJobOptions): Promise<unknown> {
  const coverageLedgerRepository = getOptionalService<EvolutionCoverageLedgerRepository>(
    options.container,
    'coverageLedgerRepository'
  );
  if (!coverageLedgerRepository) {
    throw new Error('Coverage ledger repository is required for deepMining.');
  }

  const { runKnowledgeRescanWorkflow: rescanKnowledge } = await import(
    '../workflows/knowledge-rescan/KnowledgeRescanWorkflow.js'
  );
  const analysisScope = resolveProjectScopeAnalysisContext(options.container);
  const projectRoot = analysisScope.projectRoot;

  const rounds: Array<Record<string, unknown>> = [];
  let latestRound = latestDeepMiningRound(
    coverageLedgerRepository.listRoundsByProjectRoot(projectRoot)
  );
  let advisor: ReturnType<typeof adviseCoverageLedger> | null = null;
  let latestPlanGate: BootstrapPlanGateResult | null = null;
  let latestModuleCount = 1;

  while (true) {
    const planGate = await runPlanSelectionGate(options, {
      generationStage: 'deepMining',
      label: 'DeepMining',
      source: 'alembic-main-rescan',
    });
    latestPlanGate = planGate;
    const planContext = buildDeepMiningRoundPlanContext(planGate);
    latestModuleCount = planContext.moduleCount;

    ensureCoverageLedgerCells({
      projectRoot,
      repository: coverageLedgerRepository,
      targets: planContext.moduleDimensionTargets,
    });

    advisor = adviseCoverageLedger({
      cells: coverageLedgerRepository.listByProjectRoot(projectRoot),
      latestRound,
      moduleCount: planContext.moduleCount,
      planK: planContext.planK,
      planMaxRounds: planContext.planMaxRounds,
    });
    if (advisor.shouldStop) {
      break;
    }

    const roundIndex = (latestRound?.roundIndex ?? 0) + 1;
    const rescanId = `${options.jobId}:deepMining:${roundIndex}`;
    const startedAt = Date.now();
    coverageLedgerRepository.upsertRound({
      projectRoot,
      rescanId,
      roundIndex,
      startedAt,
      triggerActor: 'daemon-job-runner',
    });

    const raw = await rescanKnowledge(
      { container: options.container, logger: options.logger },
      buildDaemonRescanWorkflowArgs({
        args: {
          ...options.args,
          contentMaxLines: planGate.projection.budget.contentMaxLines,
          dimensions: planGate.projection.executionDimensions,
          generationStage: 'deepMining',
          maxFiles: planGate.projection.budget.maxFiles,
          miningMode: 'deepMining',
          moduleDimensionTargets: planContext.moduleDimensionTargets,
          moduleScope: planGate.projection.moduleScope,
          perDimensionTargets: planContext.perDimensionTargets,
          reason: `${options.source || 'daemon'}-deepMining-round-${roundIndex}`,
          roundIndex,
        },
        source: options.source,
      })
    );
    const result = unwrapEnvelope(raw);
    const newRecipesThisRound = extractNewRecipesThisRound(result);
    latestRound = coverageLedgerRepository.upsertRound({
      completedAt: Date.now(),
      newRecipesThisRound,
      projectRoot,
      rescanId,
      roundIndex,
      startedAt,
      triggerActor: 'daemon-job-runner',
    });
    advisor = adviseCoverageLedger({
      cells: coverageLedgerRepository.listByProjectRoot(projectRoot),
      latestRound,
      moduleCount: planContext.moduleCount,
      planK: planContext.planK,
      planMaxRounds: planContext.planMaxRounds,
    });
    rounds.push({
      newRecipesThisRound,
      rescanId,
      roundIndex,
      stopReasonAfterRound: advisor.stopReason,
    });
    recordJobProcessEvent(getJobProcessEventRecorder(options.container), {
      jobId: options.jobId,
      kind: 'checkpoint',
      metadata: {
        advisor,
        newRecipesThisRound,
        rescanId,
        roundIndex,
      },
      phase: 'deep-mining',
      severity: advisor.shouldStop ? 'success' : 'info',
      summary: `deepMining round ${roundIndex} produced ${newRecipesThisRound} new recipe(s).`,
      title: 'DeepMining round completed',
    });
    if (advisor.shouldStop) {
      break;
    }
  }

  if (!advisor || !latestPlanGate) {
    throw new Error('deepMining plan gate did not produce an advisor decision.');
  }

  return {
    asyncFill: false,
    deepMining: {
      advisor,
      moduleCount: latestModuleCount,
      rounds,
      stopReason: advisor.stopReason,
    },
    planSelectionProjection: latestPlanGate.projection,
    status: 'complete',
  };
}

async function runModuleMiningWorkflow(options: RunDaemonJobOptions): Promise<unknown> {
  const planGate = await runPlanSelectionGate(options, {
    generationStage: 'moduleMining',
    label: 'ModuleMining',
    source: 'alembic-main-rescan',
  });
  const modules = selectModuleMiningModules({
    facts: planGate.projectContextFacts,
    projection: planGate.projection,
    selection: planGate.selection,
  });
  if (modules.length === 0) {
    throw new Error('moduleMining requires at least one ProjectMap module.');
  }

  const explicitScaleCap = positiveIntegerArg(options.args?.scaleCap);
  const scaleCap =
    explicitScaleCap ?? Math.min(modules.length, planGate.projection.budget.totalRecipeBudget);
  const selectedModules = modules.slice(0, scaleCap);
  if (selectedModules.length === 0) {
    throw new Error('moduleMining scaleCap selected zero ProjectMap modules.');
  }

  const { runModuleMining } = await import('@alembic/agent/service');
  const result = await runModuleMining({
    agentService: options.container.get('agentService') as Pick<AgentService, 'run'>,
    budget: { ...planGate.projection.budget },
    modules: selectedModules,
    projectFacts: planGate.projectContextFacts,
    scaleCap,
  });
  const newRecipes = extractNewRecipesThisRound(result);
  if (newRecipes <= 0) {
    throw new Error('moduleMining produced zero recipes.');
  }

  return {
    ...asRecord(result),
    asyncFill: false,
    moduleMining: {
      moduleCount: selectedModules.length,
      newRecipes,
      scaleCap,
    },
    planSelectionProjection: planGate.projection,
  };
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
  draft: BootstrapProcessEventDraft;
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

function isLlmEventDraft(draft: BootstrapProcessEventDraft): boolean {
  return draft.kind === 'llm.input' || draft.kind === 'llm.output';
}

function normalizeBootstrapProcessEventDrafts(payload: unknown): BootstrapProcessEventDraft[] {
  let rawDrafts: unknown[] = [];
  if (Array.isArray(payload)) {
    rawDrafts = payload;
  } else if (isRecord(payload) && Array.isArray(payload.events)) {
    rawDrafts = payload.events;
  }
  return rawDrafts.filter(isBootstrapProcessEventDraft);
}

function isBootstrapProcessEventDraft(value: unknown): value is BootstrapProcessEventDraft {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveIntegerArg(value: unknown): number | undefined {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : null;
  if (numericValue === null || !Number.isFinite(numericValue) || numericValue < 1) {
    return undefined;
  }
  return Math.floor(numericValue);
}

function firstPositiveIntegerArg(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = positiveIntegerArg(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function stringArrayArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
  return values.length > 0 ? values : undefined;
}

function generationStageArg(value: unknown): PlanStageId | undefined {
  return value === 'coldStart' || value === 'deepMining' || value === 'moduleMining'
    ? value
    : undefined;
}

function miningModeArg(value: unknown): DaemonRescanWorkflowArgs['miningMode'] | undefined {
  return value === 'deepMining' || value === 'moduleMining' || value === 'per-module'
    ? value
    : undefined;
}

function isMiningRescanArgs(args: Record<string, unknown>): boolean {
  return (
    generationStageArg(args.generationStage) === 'deepMining' ||
    generationStageArg(args.generationStage) === 'moduleMining' ||
    miningModeArg(args.miningMode) !== undefined
  );
}

function normalizeNumberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([key, raw]) => [key.trim(), nonNegativeNumber(raw)] as const)
    .filter(
      (entry): entry is readonly [string, number] => entry[0].length > 0 && entry[1] !== null
    );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeModuleDimensionTargets(value: unknown): ModuleDimensionTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const dimensionId = stringValue(item.dimensionId);
    const targetRecipes = nonNegativeNumber(item.targetRecipes);
    if (!dimensionId || targetRecipes === null) {
      return [];
    }
    const target: ModuleDimensionTarget = {
      dimensionId,
      targetRecipes,
    };
    const moduleId = stringValue(item.moduleId);
    const moduleName = stringValue(item.moduleName);
    if (moduleId) {
      target.moduleId = moduleId;
    }
    if (moduleName) {
      target.moduleName = moduleName;
    }
    return [target];
  });
}

function nonNegativeNumber(value: unknown): number | null {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : null;
  if (numericValue === null || !Number.isFinite(numericValue) || numericValue < 0) {
    return null;
  }
  return Math.floor(numericValue);
}

function buildPlanPerDimensionTargets(selection: PlanSelection): Record<string, number> {
  const targets: Record<string, number> = {};
  for (const binding of selection.moduleBindings) {
    const targetRecipes = nonNegativeNumber(binding.targetRecipes);
    if (targetRecipes === null) {
      continue;
    }
    for (const dimensionId of binding.dimensions) {
      targets[dimensionId] = Math.max(targets[dimensionId] ?? 0, targetRecipes);
    }
  }
  return targets;
}

function buildPlanModuleDimensionTargets(selection: PlanSelection): ModuleDimensionTarget[] {
  return selection.moduleBindings.flatMap((binding) => {
    const targetRecipes = nonNegativeNumber(binding.targetRecipes);
    if (targetRecipes === null) {
      return [];
    }
    return binding.dimensions.map((dimensionId) => ({
      dimensionId,
      moduleId: binding.moduleId || binding.modulePath,
      moduleName: moduleNameFromBinding(binding),
      targetRecipes,
    }));
  });
}

function buildDeepMiningRoundPlanContext(
  planGate: BootstrapPlanGateResult
): DeepMiningRoundPlanContext {
  const moduleDimensionTargets = buildPlanModuleDimensionTargets(planGate.selection);
  if (moduleDimensionTargets.length === 0) {
    throw new Error('deepMining requires plan moduleBindings with module×dimension targets.');
  }

  const scale = asRecord(planGate.selection.scale);
  return {
    moduleCount: Math.max(
      1,
      planGate.projectContextFacts.projectMapModules.length ||
        planGate.projectContextFacts.moduleCount ||
        planGate.projection.moduleScope.length ||
        1
    ),
    moduleDimensionTargets,
    perDimensionTargets: buildPlanPerDimensionTargets(planGate.selection),
    // Core 目前没有把 K/maxRounds 放进 typed PlanSelection.scale；若运行时 plan 显式给出就消费，
    // 否则保持 undefined，让 CoverageLedgerAdvisor 使用 D2 默认表。
    planK: firstPositiveIntegerArg(scale.k, scale.minNewRecipes),
    planMaxRounds: positiveIntegerArg(scale.maxRounds),
  };
}

function moduleNameFromBinding(binding: PlanModuleBinding): string {
  return (
    binding.modulePath.split('/').filter(Boolean).at(-1) || binding.moduleId || binding.modulePath
  );
}

function ensureCoverageLedgerCells(input: {
  projectRoot: string;
  repository: EvolutionCoverageLedgerRepository;
  targets: readonly ModuleDimensionTarget[];
}): void {
  for (const target of input.targets) {
    const moduleId = target.moduleId || target.moduleName;
    if (!moduleId) {
      continue;
    }
    const existing = input.repository.getCell({
      dimensionId: target.dimensionId,
      moduleId,
      projectRoot: input.projectRoot,
    });
    if (existing) {
      continue;
    }
    input.repository.upsertCell({
      coveredCount: 0,
      dimensionId: target.dimensionId,
      grade: 'empty',
      moduleId,
      projectRoot: input.projectRoot,
      totalCandidateCount: target.targetRecipes,
    });
  }
}

function latestDeepMiningRound(
  rounds: readonly DeepMiningRoundRecord[]
): DeepMiningRoundRecord | null {
  return [...rounds].sort((left, right) => right.roundIndex - left.roundIndex)[0] ?? null;
}

function selectModuleMiningModules(input: {
  facts: ProjectContextWorkflowFacts;
  projection: PlanSelectionProjection;
  selection: PlanSelection;
}): ModuleMiningModule[] {
  const bindings = input.selection.moduleBindings;
  const bindingDimensions = new Map<string, Set<string>>();
  const moduleBindingKeys = new Set<string>();
  const executionDimensions = new Set(input.projection.executionDimensions);

  for (const binding of bindings) {
    const keys = moduleBindingCandidateKeys(binding);
    for (const key of keys) {
      moduleBindingKeys.add(key);
      const dimensions = bindingDimensions.get(key) ?? new Set<string>();
      for (const dimension of binding.dimensions) {
        if (executionDimensions.has(dimension)) {
          dimensions.add(dimension);
        }
      }
      bindingDimensions.set(key, dimensions);
    }
  }

  const scopedModules = new Set(input.projection.moduleScope);
  return input.facts.projectMapModules
    .filter((module) => {
      const moduleKeys = projectMapModuleCandidateKeys(module);
      const matchesModuleBinding =
        moduleBindingKeys.size === 0 || moduleKeys.some((key) => moduleBindingKeys.has(key));
      const matchesModuleScope =
        scopedModules.size === 0 || moduleKeys.some((key) => scopedModules.has(key));
      return matchesModuleBinding && matchesModuleScope;
    })
    .map((module): ModuleMiningModule => {
      const moduleKeys = projectMapModuleCandidateKeys(module);
      const plannedDimensions = uniqueStrings(
        moduleKeys.flatMap((key) => [...(bindingDimensions.get(key) ?? [])])
      );
      return {
        dimensions:
          plannedDimensions.length > 0 ? plannedDimensions : input.projection.executionDimensions,
        moduleId: module.moduleId,
        moduleName: module.moduleName,
        modulePath: module.modulePath,
        ownedFiles: module.ownedFiles,
        role: module.role,
      };
    })
    .filter((module) => module.moduleName.trim().length > 0);
}

function moduleBindingCandidateKeys(binding: PlanModuleBinding): string[] {
  return uniqueStrings([
    binding.moduleId ?? '',
    binding.modulePath,
    moduleNameFromBinding(binding),
  ]);
}

function projectMapModuleCandidateKeys(module: {
  moduleId: string;
  moduleName: string;
  modulePath?: string;
}): string[] {
  return uniqueStrings([module.moduleId, module.moduleName, module.modulePath ?? '']);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function extractNewRecipesThisRound(result: unknown): number {
  const record = asRecord(result);
  const numericCandidates = [
    record.newRecipesThisRound,
    record.newRecipes,
    record.created,
    record.createdCount,
    asRecord(record.summary).newRecipes,
    asRecord(record.summary).created,
    asRecord(record.bootstrapCandidates).created,
    asRecord(record.moduleMining).newRecipes,
  ];
  for (const candidate of numericCandidates) {
    const value = nonNegativeNumber(candidate);
    if (value !== null) {
      return value;
    }
  }
  return countRecipeArrayFields(result);
}

function countRecipeArrayFields(value: unknown, depth = 0): number {
  if (depth > 6 || !isRecord(value)) {
    return 0;
  }
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if (
      Array.isArray(child) &&
      (key === 'recipes' || key === 'newRecipes' || key === 'createdRecipes')
    ) {
      count += child.length;
      continue;
    }
    if (isRecord(child)) {
      count += countRecipeArrayFields(child, depth + 1);
    }
  }
  return count;
}

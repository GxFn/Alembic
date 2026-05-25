import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '@alembic/core/daemon';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  attachBootstrapProcessEventBridge,
  cancelDaemonJob,
  markInterruptedDaemonJobs,
} from '../../lib/daemon/DaemonJobRunner.js';
import { readJobProcessEventArtifact } from '../../lib/daemon/JobProcessEventArtifacts.js';
import { JobProcessEventRecorder } from '../../lib/daemon/JobProcessEventRecorder.js';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-runner-home-'));
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-runner-project-'));
}

function makeContainer(
  store: JobStore,
  services: Record<string, unknown> = {},
  singletons: Record<string, unknown> = {}
): ServiceContainer {
  return {
    singletons,
    get(name: string) {
      if (name === 'jobStore') {
        return store;
      }
      if (name in services) {
        return services[name];
      }
      throw new Error(`missing service: ${name}`);
    },
  } as unknown as ServiceContainer;
}

function makeLogger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  vi.restoreAllMocks();
});

describe('markInterruptedDaemonJobs', () => {
  test('fails active daemon jobs and logs the recovery action', () => {
    useTempAlembicHome();
    const store = new JobStore({ projectRoot: makeProjectRoot() });
    const job = store.create({ kind: 'bootstrap', source: 'http' });
    store.markRunning(job.id);
    const logger = makeLogger();

    const interrupted = markInterruptedDaemonJobs({
      code: 'DAEMON_RESTARTED',
      container: makeContainer(store),
      logger,
      reason: 'daemon restarted before completion',
    });

    expect(interrupted.map((item) => item.id)).toEqual([job.id]);
    expect(store.get(job.id)).toMatchObject({
      status: 'failed',
      error: { code: 'DAEMON_RESTARTED', message: 'daemon restarted before completion' },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Marked interrupted daemon jobs as failed',
      expect.objectContaining({
        count: 1,
        jobIds: [job.id],
      })
    );
  });

  test('stays quiet when there are no active jobs to recover', () => {
    useTempAlembicHome();
    const store = new JobStore({ projectRoot: makeProjectRoot() });
    const job = store.create({ kind: 'rescan' });
    store.markRunning(job.id);
    store.complete(job.id, { ok: true });
    const logger = makeLogger();

    const interrupted = markInterruptedDaemonJobs({
      container: makeContainer(store),
      logger,
      reason: 'daemon restarted before completion',
    });

    expect(interrupted).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('cancelDaemonJob', () => {
  test('persists a running bootstrap abort as a cancelled job with final session evidence', () => {
    useTempAlembicHome();
    const store = new JobStore({ projectRoot: makeProjectRoot() });
    const created = store.create({ kind: 'bootstrap', source: 'dashboard' });
    store.markRunning(created.id);
    store.update(created.id, {
      bootstrapSessionId: 'bs_cancel',
      result: { bootstrapSession: { id: 'bs_cancel', status: 'running' } },
      status: 'running',
    });

    const session = {
      id: 'bs_cancel',
      status: 'running',
      summary: null,
    } as Record<string, unknown>;
    const taskManager = {
      abortSession: vi.fn((reason: string) => {
        session.status = 'aborted';
        session.summary = {
          aborted: true,
          cancelled: 9,
          completed: 5,
          failed: 0,
          reason,
          totalTasks: 14,
        };
      }),
      getSessionStatus: vi.fn(() => session),
      isRunning: true,
      markCancelled: vi.fn(),
    };

    const cancelled = cancelDaemonJob({
      container: makeContainer(store, { bootstrapTaskManager: taskManager }),
      jobId: created.id,
      reason: 'Cancelled by Dashboard Jobs view',
    });

    expect(taskManager.abortSession).toHaveBeenCalledWith('Cancelled by Dashboard Jobs view');
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      error: { message: 'Cancelled by Dashboard Jobs view' },
      result: {
        finalSession: {
          status: 'aborted',
          summary: {
            aborted: true,
            cancelled: 9,
            completed: 5,
            failed: 0,
            totalTasks: 14,
          },
        },
      },
    });
  });
});

describe('attachBootstrapProcessEventBridge', () => {
  test('records explicit bootstrap process event payloads for the active daemon job', () => {
    const eventBus = new EventEmitter();
    const recorder = new JobProcessEventRecorder();
    const cleanup = attachBootstrapProcessEventBridge({
      container: makeContainer(new JobStore({ projectRoot: makeProjectRoot() }), { eventBus }),
      jobId: 'job_process_bridge',
      logger: makeLogger(),
      recorder,
    });

    eventBus.emit('bootstrap:started', { sessionId: 'bs_1', total: 1 });
    eventBus.emit('bootstrap:process-events', {
      sessionId: 'bs_1',
      taskId: 'architecture',
      targetName: 'Architecture',
      events: [
        {
          kind: 'llm.input',
          title: 'Input prepared',
          content: { mimeType: 'text/plain', role: 'developer', text: 'safe input summary' },
          metadata: { source: 'test' },
        },
      ],
    });

    cleanup?.();

    const list = recorder.list('job_process_bridge', { limit: 10 });
    expect(list.developerViews.map((event) => event.kind)).toEqual(['workflow', 'llm.input']);
    expect(list.developerViews[1]).toMatchObject({
      dimensionId: 'architecture',
      metadata: {
        sessionId: 'bs_1',
        taskId: 'architecture',
      },
      targetName: 'Architecture',
      title: 'Input prepared',
    });
  });

  test('materializes full redacted LLM text artifacts before Timeline projection is recorded', () => {
    const eventBus = new EventEmitter();
    const recorder = new JobProcessEventRecorder();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-runner-data-'));
    const cleanup = attachBootstrapProcessEventBridge({
      container: makeContainer(
        new JobStore({ projectRoot: dataRoot }),
        { eventBus },
        { _workspaceResolver: { dataRoot } }
      ),
      jobId: 'job_artifact_bridge',
      logger: makeLogger(),
      recorder,
    });

    const fullPrompt = `${'full redacted prompt\n'.repeat(400)}final line`;
    eventBus.emit('bootstrap:process-events', {
      sessionId: 'bs_1',
      taskId: 'architecture',
      targetName: 'Architecture',
      events: [
        {
          kind: 'llm.input',
          title: 'LLM input prepared',
          content: {
            mimeType: 'text/markdown',
            role: 'developer',
            text: 'Timeline summary only',
          },
          metadata: {
            inputStageProfile: 'analyze',
            iteration: 3,
            traceEnvelope: {
              correlationId: 'llm:bs_1:architecture:analyze:iteration-3:llm.input',
              iteration: 3,
              phase: 'analyze',
              sessionId: 'bs_1',
              stageId: 'analyze',
            },
          },
          phase: 'analyze',
          textArtifactCandidate: {
            kind: 'llm-input-full-redacted',
            label: 'Full redacted LLM input',
            mimeType: 'text/markdown; charset=utf-8',
            originalChars: fullPrompt.length,
            redactionState: 'developer-visible-redacted',
            text: fullPrompt,
          },
        },
      ],
    });

    cleanup?.();

    const list = recorder.list('job_artifact_bridge', { limit: 10 });
    const event = list.developerViews.find((candidate) => candidate.kind === 'llm.input');
    expect(event).toBeDefined();
    expect(event?.content?.text).toBe('Timeline summary only');
    expect(event?.artifactRefs[0]).toMatchObject({
      kind: 'llm-input-full-redacted',
      mimeType: 'text/markdown; charset=utf-8',
    });
    expect(event?.artifactRefs[0]?.ref).toMatch(
      /^\/api\/v1\/jobs\/job_artifact_bridge\/artifacts\/llm-input-full-redacted-architecture-i3-[a-f0-9]+\.md$/
    );
    expect(event?.metadata).toMatchObject({
      artifactDataRootScoped: true,
      artifactOriginalChars: fullPrompt.length,
      artifactRedactionState: 'developer-visible-redacted',
      artifactRetained: true,
      artifactRetainedChars: fullPrompt.length,
      traceEnvelope: {
        jobId: 'job_artifact_bridge',
        sessionId: 'bs_1',
        stageId: 'analyze',
      },
    });

    const artifactId = String(event?.metadata.artifactId);
    const artifact = readJobProcessEventArtifact({
      artifactId,
      dataRoot,
      jobId: 'job_artifact_bridge',
    });
    expect(artifact?.absolutePath.startsWith(path.join(dataRoot, '.asd'))).toBe(true);
    expect(artifact?.content).toBe(fullPrompt);
  });

  test('carries PCV N9 artifact, trace, metrics, and source refs through job process events', () => {
    const eventBus = new EventEmitter();
    const recorder = new JobProcessEventRecorder();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-runner-data-'));
    const cleanup = attachBootstrapProcessEventBridge({
      container: makeContainer(
        new JobStore({ projectRoot: dataRoot }),
        { eventBus },
        { _workspaceResolver: { dataRoot } }
      ),
      jobId: 'job_pcv_n9_linked',
      logger: makeLogger(),
      recorder,
    });

    const fullPrompt = 'Analyze src/index.ts and record source-backed findings.';
    eventBus.emit('bootstrap:process-events', {
      sessionId: 'bs_n9',
      taskId: 'architecture',
      targetName: 'Architecture',
      events: [
        {
          kind: 'llm.input',
          title: 'N9 LLM input prepared',
          content: {
            mimeType: 'text/markdown',
            role: 'developer',
            text: 'Timeline input summary',
          },
          metadata: {
            inputStageProfile: 'analyze',
            llmMetrics: { estimatedTokens: 13, messageCount: 2 },
            sourceRefs: ['src/index.ts:42'],
            traceEnvelope: {
              chainNodeId: 'N9-agent-analyze-quality',
              correlationId: 'trace-n9-1',
              sessionId: 'bs_n9',
              stageId: 'analyze',
            },
          },
          phase: 'analyze',
          textArtifactCandidate: {
            kind: 'llm-input-full-redacted',
            label: 'Full redacted N9 LLM input',
            mimeType: 'text/markdown; charset=utf-8',
            originalChars: fullPrompt.length,
            redactionState: 'developer-visible-redacted',
            text: fullPrompt,
          },
        },
      ],
    });

    cleanup?.();

    const list = recorder.list('job_pcv_n9_linked', { limit: 10 });
    const event = list.developerViews.find(
      (candidate) => candidate.title === 'N9 LLM input prepared'
    );
    expect(event).toBeDefined();
    expect(event?.artifactRefs[0]?.ref).toMatch(
      /^\/api\/v1\/jobs\/job_pcv_n9_linked\/artifacts\/llm-input-full-redacted-architecture-[a-f0-9]+\.md$/
    );
    expect(event?.metadata).toMatchObject({
      pcvN9Observability: {
        evidenceLinks: {
          artifactRefs: [event?.artifactRefs[0]?.ref],
          metricsPath: 'metadata.llmMetrics',
          sourceRefs: ['src/index.ts:42'],
          traceId: 'trace-n9-1',
        },
        jobId: 'job_pcv_n9_linked',
        linkageStatus: 'linked',
        missingLinkReasons: [],
        nodeId: 'N9-agent-analyze-quality',
        nodeIdentitySource: 'agent-explicit',
        sessionId: 'bs_n9',
      },
      traceEnvelope: {
        artifactRefs: [event?.artifactRefs[0]?.ref],
        chainNodeId: 'N9-agent-analyze-quality',
        jobId: 'job_pcv_n9_linked',
        metricsPath: 'metadata.llmMetrics',
        nodeId: 'N9-agent-analyze-quality',
        pcvNodeId: 'N9-agent-analyze-quality',
        sourceRefs: ['src/index.ts:42'],
        traceId: 'trace-n9-1',
      },
    });

    const artifactId = String(event?.metadata.artifactId);
    const artifact = readJobProcessEventArtifact({
      artifactId,
      dataRoot,
      jobId: 'job_pcv_n9_linked',
    });
    expect(artifact?.content).toBe(fullPrompt);
  });

  test('reports precise PCV N9 missing-link reasons when Agent evidence is incomplete', () => {
    const eventBus = new EventEmitter();
    const recorder = new JobProcessEventRecorder();
    const cleanup = attachBootstrapProcessEventBridge({
      container: makeContainer(new JobStore({ projectRoot: makeProjectRoot() }), { eventBus }),
      jobId: 'job_pcv_n9_gap',
      logger: makeLogger(),
      recorder,
    });

    eventBus.emit('bootstrap:process-events', {
      sessionId: 'bs_n9_gap',
      taskId: 'architecture',
      targetName: 'Architecture',
      events: [
        {
          kind: 'llm.input',
          title: 'Analyze input without full linkage',
          content: {
            mimeType: 'text/markdown',
            role: 'developer',
            text: 'Analyze only.',
          },
          metadata: {
            inputStageProfile: 'analyze',
          },
          phase: 'analyze',
        },
      ],
    });

    cleanup?.();

    const event = recorder
      .list('job_pcv_n9_gap', { limit: 10 })
      .developerViews.find((candidate) => candidate.title === 'Analyze input without full linkage');
    expect(event?.metadata).toMatchObject({
      pcvN9Observability: {
        evidenceLinks: {
          artifactRefs: [],
          metricsPath: null,
          sourceRefs: [],
          traceId: null,
        },
        firstFix: [
          'Attach a redacted analysis artifactRef or report field to the N9 process event.',
          'Carry correlationId/traceId through the N9 process event trace envelope.',
          'Attach llmMetrics to the N9 LLM input/output or quality-gate process event.',
          'Carry file-level sourceRefs or referencedFiles used by N9 note_finding evidence.',
        ],
        jobId: 'job_pcv_n9_gap',
        linkageStatus: 'blocked-by-observability-gap',
        missingLinkReasons: [
          'artifact_missing',
          'trace_id_missing',
          'metrics_missing',
          'source_ref_missing',
        ],
        nodeId: 'N9-agent-analyze-quality',
        nodeIdentitySource: 'host-stage-profile',
        sessionId: 'bs_n9_gap',
      },
      traceEnvelope: {
        artifactRefs: [],
        chainNodeId: 'N9-agent-analyze-quality',
        jobId: 'job_pcv_n9_gap',
        metricsPath: null,
        nodeId: 'N9-agent-analyze-quality',
        pcvNodeId: 'N9-agent-analyze-quality',
        sourceRefs: [],
        traceId: null,
      },
    });
  });

  test('records process event drafts carried by completed task results', () => {
    const eventBus = new EventEmitter();
    const recorder = new JobProcessEventRecorder();
    const cleanup = attachBootstrapProcessEventBridge({
      container: makeContainer(new JobStore({ projectRoot: makeProjectRoot() }), { eventBus }),
      jobId: 'job_task_result_bridge',
      logger: makeLogger(),
      recorder,
    });

    eventBus.emit('bootstrap:started', { sessionId: 'bs_1', total: 1 });
    eventBus.emit('bootstrap:task-completed', {
      sessionId: 'bs_1',
      taskId: 'code-patterns',
      meta: { dimId: 'code-patterns', label: 'Code Patterns' },
      result: {
        status: 'v3-pipeline-complete',
        processEvents: [
          {
            kind: 'tool',
            title: 'Tool calls',
            content: { language: 'json', mimeType: 'application/json', role: 'tool', text: '[]' },
          },
        ],
      },
      progress: 100,
      completed: 1,
      total: 1,
    });

    cleanup?.();

    const list = recorder.list('job_task_result_bridge', { limit: 10 });
    expect(list.developerViews.map((event) => event.kind)).toEqual(['workflow', 'summary', 'tool']);
    expect(list.developerViews[2]).toMatchObject({
      dimensionId: 'code-patterns',
      metadata: {
        sessionId: 'bs_1',
        taskId: 'code-patterns',
      },
      targetName: 'Code Patterns',
      title: 'Tool calls',
    });
  });
});

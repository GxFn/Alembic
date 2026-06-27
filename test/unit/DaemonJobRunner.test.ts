import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore, validateJobDisplaySnapshot } from '@alembic/core/daemon';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  attachBootstrapProcessEventBridge,
  buildDaemonRescanWorkflowArgs,
  cancelDaemonJob,
  markInterruptedDaemonJobs,
  recordDaemonJobAsyncFailure,
} from '../../lib/daemon/DaemonJobRunner.js';
import { JobDisplaySnapshotStore } from '../../lib/daemon/JobDisplaySnapshotStore.js';
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
  test('persists an async failure for a queued job and refreshes display evidence', () => {
    useTempAlembicHome();
    const store = new JobStore({ projectRoot: makeProjectRoot() });
    const job = store.create({ kind: 'rescan', source: 'http' });
    const recorder = new JobProcessEventRecorder();
    const displayStore = { writeFromJob: vi.fn() };
    const logger = makeLogger();

    const failed = recordDaemonJobAsyncFailure({
      container: makeContainer(store, {
        jobDisplaySnapshotStore: displayStore,
        jobProcessEventRecorder: recorder,
      }),
      error: new Error('async worker crashed'),
      jobId: job.id,
      kind: 'rescan',
      logger,
      source: 'http',
    });

    expect(failed).toMatchObject({
      id: job.id,
      status: 'failed',
      error: { message: 'async worker crashed' },
    });
    expect(store.get(job.id)).toMatchObject({ status: 'failed' });
    expect(recorder.list(job.id, { limit: 10 }).developerViews).toEqual([
      expect.objectContaining({
        summary: 'async worker crashed',
        title: 'Daemon job failed after enqueue',
      }),
    ]);
    expect(displayStore.writeFromJob).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: job.id, status: 'failed' }),
        recorder,
      })
    );
  });

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
    const projectRoot = makeProjectRoot();
    const store = new JobStore({ projectRoot });
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
    expect(
      fs.existsSync(
        path.join(projectRoot, '.asd', 'job-display-snapshots', created.id, 'snapshot.json')
      )
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(process.cwd(), '.asd', 'job-display-snapshots', created.id, 'snapshot.json')
      )
    ).toBe(false);
  });
});

describe('buildDaemonRescanWorkflowArgs', () => {
  test('keeps legacy rescan daemon payloads on Core default analysis limits', () => {
    const args = buildDaemonRescanWorkflowArgs({
      args: {
        reason: 'legacy-rescan',
        dimensions: ['architecture', 123, 'security'],
      },
      source: 'http',
    });

    expect(args).toEqual({
      reason: 'legacy-rescan',
      dimensions: ['architecture', 'security'],
    });
    expect(args.maxFiles).toBeUndefined();
    expect(args.contentMaxLines).toBeUndefined();
  });

  test('passes non-truncated rescan analysis options through to the workflow', () => {
    const args = buildDaemonRescanWorkflowArgs({
      args: {
        reason: 'wide-rescan',
        dimensions: ['architecture'],
        maxFiles: 15_000,
        contentMaxLines: 1_500,
      },
      source: 'http',
    });

    expect(args).toEqual({
      reason: 'wide-rescan',
      dimensions: ['architecture'],
      maxFiles: 15_000,
      contentMaxLines: 1_500,
    });
  });

  test('passes mining-only targets while leaving ordinary rescan payloads unchanged', () => {
    const args = buildDaemonRescanWorkflowArgs({
      args: {
        generationStage: 'deepMining',
        miningMode: 'deepMining',
        moduleDimensionTargets: [
          {
            dimensionId: 'architecture',
            moduleId: 'core',
            moduleName: 'Core',
            targetRecipes: 8,
          },
          { dimensionId: 'ignored', targetRecipes: -1 },
        ],
        moduleScope: ['src/core', 42, 'src/shared'],
        perDimensionTargets: { architecture: 8, covered: 0, ignored: -1 },
        reason: 'deep-mining',
        roundIndex: 2,
      },
      source: 'dashboard',
    });

    expect(args).toMatchObject({
      miningMode: 'deepMining',
      moduleDimensionTargets: [
        {
          dimensionId: 'architecture',
          moduleId: 'core',
          moduleName: 'Core',
          targetRecipes: 8,
        },
      ],
      moduleScope: ['src/core', 'src/shared'],
      perDimensionTargets: { architecture: 8, covered: 0 },
      reason: 'deep-mining',
      roundIndex: 2,
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

  test('writes durable display snapshots as bootstrap process evidence is recorded', () => {
    const eventBus = new EventEmitter();
    const recorder = new JobProcessEventRecorder();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-runner-snapshot-'));
    const store = new JobStore({ projectRoot: dataRoot });
    const job = store.create({ kind: 'bootstrap', source: 'dashboard' });
    store.markRunning(job.id);
    const snapshotStore = new JobDisplaySnapshotStore({ dataRoot });
    const cleanup = attachBootstrapProcessEventBridge({
      container: makeContainer(
        store,
        { eventBus, jobDisplaySnapshotStore: snapshotStore },
        { _workspaceResolver: { dataRoot } }
      ),
      jobId: job.id,
      logger: makeLogger(),
      recorder,
    });

    const fullPrompt = 'Analyze src/index.ts and preserve LLM IO evidence.';
    eventBus.emit('bootstrap:process-events', {
      sessionId: 'bs_snapshot',
      taskId: 'architecture',
      targetName: 'Architecture',
      events: [
        {
          kind: 'llm.input',
          title: 'Snapshot LLM input prepared',
          content: {
            mimeType: 'text/markdown',
            role: 'developer',
            text: 'Timeline input summary',
          },
          metadata: {
            findings: [{ sourceRef: 'src/index.ts:42', title: 'Source-backed snapshot' }],
            inputStageProfile: 'analyze',
            sourceRefs: ['src/index.ts:42'],
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

    const read = snapshotStore.read(job.id);
    expect(read?.absolutePath).toBe(
      path.join(dataRoot, '.asd', 'job-display-snapshots', job.id, 'snapshot.json')
    );
    expect(read?.validation.valid).toBe(true);
    expect(read ? validateJobDisplaySnapshot(read.snapshot).valid : false).toBe(true);
    expect(read?.snapshot.snapshot.ref).toBe(`/api/v1/jobs/${job.id}/display-snapshot`);
    expect(read?.snapshot.manifest.llmIoEntryCount).toBe(1);
    expect(read?.snapshot.llmIo.entries[0]).toMatchObject({
      kind: 'llm.input',
      title: 'Snapshot LLM input prepared',
    });
    expect(read?.snapshot.artifacts).toEqual([
      expect.objectContaining({
        originalChars: fullPrompt.length,
        redactionState: 'redacted',
        retained: true,
        storageKind: 'job-artifact',
      }),
    ]);
    expect(read?.snapshot.sourceRefs.map((item) => item.sourceRef)).toContain('src/index.ts:42');
    expect(read?.snapshot.findings).toEqual([
      expect.objectContaining({
        sourceRef: 'src/index.ts:42',
        title: 'Source-backed snapshot',
      }),
    ]);
    expect(read?.snapshot.evidenceIncomplete.map((item) => item.reason)).toContain(
      'snapshot_redacted'
    );
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
              chainNodeId: 'pcvm:cold-start:n9',
              correlationId: 'trace-n9-1',
              pcvNodeId: 'pcvm:n9:analyze',
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
        chainNodeId: 'pcvm:cold-start:n9',
        nodeId: 'pcvm:n9:analyze',
        nodeIdentitySource: 'agent-explicit',
        sessionId: 'bs_n9',
      },
      traceEnvelope: {
        artifactRefs: [event?.artifactRefs[0]?.ref],
        chainNodeId: 'pcvm:cold-start:n9',
        jobId: 'job_pcv_n9_linked',
        metricsPath: 'metadata.llmMetrics',
        nodeId: 'pcvm:n9:analyze',
        pcvNodeId: 'pcvm:n9:analyze',
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

  test('consumes nested PCV N9 evidence without top-level source refs', () => {
    const eventBus = new EventEmitter();
    const recorder = new JobProcessEventRecorder();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-runner-data-'));
    const cleanup = attachBootstrapProcessEventBridge({
      container: makeContainer(
        new JobStore({ projectRoot: dataRoot }),
        { eventBus },
        { _workspaceResolver: { dataRoot } }
      ),
      jobId: 'job_pcv_n9_nested',
      logger: makeLogger(),
      recorder,
    });

    eventBus.emit('bootstrap:process-events', {
      sessionId: 'bs_n9_nested',
      taskId: 'architecture',
      targetName: 'Architecture',
      events: [
        {
          kind: 'llm.input',
          title: 'Nested N9 evidence prepared',
          content: {
            mimeType: 'text/markdown',
            role: 'developer',
            text: 'Nested evidence input summary',
          },
          metadata: {
            inputStageProfile: 'analyze',
            llmMetrics: { estimatedTokens: 17, messageCount: 2 },
            pcvNodeEvidence: {
              chainNodeId: 'pcvm:cold-start:n9:quality',
              nodeId: 'pcvm:n9:quality_gate',
              sourceRefs: ['src/index.ts:42'],
            },
            traceEnvelope: {
              correlationId: 'trace-n9-nested',
              sessionId: 'bs_n9_nested',
              stageId: 'analyze',
            },
          },
          phase: 'analyze',
          textArtifactCandidate: {
            kind: 'llm-input-full-redacted',
            label: 'Full redacted nested N9 LLM input',
            mimeType: 'text/markdown; charset=utf-8',
            originalChars: 23,
            redactionState: 'developer-visible-redacted',
            text: 'Nested source-backed prompt.',
          },
        },
      ],
    });

    cleanup?.();

    const event = recorder
      .list('job_pcv_n9_nested', { limit: 10 })
      .developerViews.find((candidate) => candidate.title === 'Nested N9 evidence prepared');
    expect(event?.metadata).toMatchObject({
      pcvN9Observability: {
        evidenceLinks: {
          artifactRefs: [event?.artifactRefs[0]?.ref],
          metricsPath: 'metadata.llmMetrics',
          sourceRefs: ['src/index.ts:42'],
          traceId: 'trace-n9-nested',
        },
        firstFix: [],
        jobId: 'job_pcv_n9_nested',
        linkageStatus: 'linked',
        missingLinkReasons: [],
        chainNodeId: 'pcvm:cold-start:n9:quality',
        nodeId: 'pcvm:n9:quality_gate',
        nodeIdentitySource: 'agent-explicit',
        sessionId: 'bs_n9_nested',
      },
      traceEnvelope: {
        artifactRefs: [event?.artifactRefs[0]?.ref],
        chainNodeId: 'pcvm:cold-start:n9:quality',
        jobId: 'job_pcv_n9_nested',
        metricsPath: 'metadata.llmMetrics',
        nodeId: 'pcvm:n9:quality_gate',
        pcvNodeId: 'pcvm:n9:quality_gate',
        sourceRefs: ['src/index.ts:42'],
        traceId: 'trace-n9-nested',
      },
    });
  });

  test('normalizes ProjectScope source refs before carrying PCV N9 process metadata', () => {
    const eventBus = new EventEmitter();
    const recorder = new JobProcessEventRecorder();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-runner-data-'));
    const cleanup = attachBootstrapProcessEventBridge({
      container: makeContainer(
        new JobStore({ projectRoot: dataRoot }),
        { eventBus },
        {
          _projectScopeSourceIdentities: [
            {
              absolutePath: '/workspace/Alembic/src/index.ts',
              folderDisplayName: 'Alembic',
              folderId: 'folder-alembic',
              folderPath: '/workspace/Alembic',
              folderRelativeRoot: 'Alembic',
              projectScopeId: 'scope-a',
              qualifiedPath: 'Alembic/src/index.ts',
              relativePath: 'src/index.ts',
            },
          ],
          _workspaceResolver: { dataRoot },
        }
      ),
      jobId: 'job_pcv_project_scope_refs',
      logger: makeLogger(),
      recorder,
    });

    eventBus.emit('bootstrap:process-events', {
      sessionId: 'bs_project_scope_refs',
      taskId: 'architecture',
      targetName: 'Architecture',
      events: [
        {
          kind: 'llm.input',
          title: 'ProjectScope N9 source refs prepared',
          content: {
            mimeType: 'text/markdown',
            role: 'developer',
            text: 'ProjectScope source-backed input summary',
          },
          metadata: {
            inputStageProfile: 'analyze',
            llmMetrics: { estimatedTokens: 17, messageCount: 2 },
            pcvNodeEvidence: {
              chainNodeId: 'pcvm:cold-start:n9',
              nodeId: 'pcvm:n9:analyze',
              sourceRefs: ['Alembic/src/index.ts:42'],
            },
            sourceRefs: ['Alembic/src/index.ts:42', 'AlembicCore/src/core/database.ts'],
            traceEnvelope: {
              correlationId: 'trace-project-scope-ref',
              sessionId: 'bs_project_scope_refs',
              sourceRefs: ['Alembic/src/index.ts:42'],
              stageId: 'analyze',
            },
          },
          phase: 'analyze',
        },
      ],
    });

    cleanup?.();

    const event = recorder
      .list('job_pcv_project_scope_refs', { limit: 10 })
      .developerViews.find(
        (candidate) => candidate.title === 'ProjectScope N9 source refs prepared'
      );
    expect(event?.metadata).toMatchObject({
      pcvN9Observability: {
        evidenceLinks: {
          sourceRefs: ['Alembic/src/index.ts:42'],
          traceId: 'trace-project-scope-ref',
        },
      },
      pcvNodeEvidence: {
        sourceRefs: ['Alembic/src/index.ts:42'],
      },
      sourceRefs: ['Alembic/src/index.ts:42'],
      traceEnvelope: {
        sourceRefs: ['Alembic/src/index.ts:42'],
      },
    });
    expect(event?.metadata.projectScopeSourceRefRejections).toEqual([
      {
        field: 'sourceRefs',
        input: 'AlembicCore/src/core/database.ts',
        reason: 'not-found',
        status: 'missing',
      },
    ]);
    expect(JSON.stringify(event?.metadata)).not.toContain('"src/index.ts:42"');
  });

  test('preserves canonical PCV N9 record repair evidence in job process events', () => {
    const eventBus = new EventEmitter();
    const recorder = new JobProcessEventRecorder();
    const cleanup = attachBootstrapProcessEventBridge({
      container: makeContainer(new JobStore({ projectRoot: makeProjectRoot() }), { eventBus }),
      jobId: 'job_pcv_n9_record_repair',
      logger: makeLogger(),
      recorder,
    });

    eventBus.emit('bootstrap:process-events', {
      sessionId: 'bs_n9_record_repair',
      taskId: 'architecture',
      targetName: 'Architecture',
      events: [
        {
          kind: 'llm.reflection',
          title: 'Record repair evidence prepared',
          content: {
            mimeType: 'text/markdown',
            role: 'developer',
            text: 'Repair evidence summary',
          },
          metadata: {
            llmMetrics: { estimatedTokens: 5 },
            pcvNodeEvidence: {
              chainNodeId: 'pcvm:cold-start:n9:repair',
              nodeId: 'pcvm:n9:record_repair',
              sourceRefs: ['src/repair.ts:7'],
            },
            traceEnvelope: {
              correlationId: 'trace-n9-record-repair',
              sessionId: 'bs_n9_record_repair',
              stageId: 'record_repair',
            },
          },
          phase: 'record_repair',
        },
      ],
    });

    cleanup?.();

    const event = recorder
      .list('job_pcv_n9_record_repair', { limit: 10 })
      .developerViews.find((candidate) => candidate.title === 'Record repair evidence prepared');
    expect(event?.metadata).toMatchObject({
      pcvN9Observability: {
        chainNodeId: 'pcvm:cold-start:n9:repair',
        evidenceLinks: {
          metricsPath: 'metadata.llmMetrics',
          sourceRefs: ['src/repair.ts:7'],
          traceId: 'trace-n9-record-repair',
        },
        nodeId: 'pcvm:n9:record_repair',
        nodeIdentitySource: 'agent-explicit',
      },
      traceEnvelope: {
        chainNodeId: 'pcvm:cold-start:n9:repair',
        nodeId: 'pcvm:n9:record_repair',
        pcvNodeId: 'pcvm:n9:record_repair',
      },
    });
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

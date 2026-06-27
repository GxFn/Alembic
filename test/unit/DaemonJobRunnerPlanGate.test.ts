import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPlanAgent } from '@alembic/agent/service';
import { JobStore } from '@alembic/core/daemon';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runDaemonJob } from '../../lib/daemon/DaemonJobRunner.js';
import { JobProcessEventRecorder } from '../../lib/daemon/JobProcessEventRecorder.js';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { runColdStartWorkflow } from '../../lib/workflows/cold-start/ColdStartWorkflow.js';
import {
  buildProjectContextWorkflowFacts,
  type ProjectContextWorkflowFacts,
} from '../../lib/workflows/project-context/ProjectContextWorkflowFacts.js';

vi.mock('@alembic/agent/service', () => ({
  runPlanAgent: vi.fn(),
}));

vi.mock('../../lib/workflows/project-context/ProjectContextWorkflowFacts.js', () => ({
  buildProjectContextWorkflowFacts: vi.fn(),
}));

vi.mock('../../lib/workflows/cold-start/ColdStartWorkflow.js', () => ({
  runColdStartWorkflow: vi.fn(),
}));

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

function makeLogger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makeFacts(): ProjectContextWorkflowFacts {
  return {
    allFiles: [{ relativePath: 'src/index.ts' }],
    allTargets: [],
    dimensions: [
      { id: 'architecture', label: 'Architecture' },
      { id: 'coding-standards', label: 'Coding Standards' },
      { id: 'project-profile', label: 'Project Profile' },
      { id: 'agent-guidelines', label: 'Agent Guidelines' },
    ],
    envelopes: [],
    fileCount: 1,
    filesByTarget: {},
    incrementalPlan: null,
    isEmpty: false,
    isMultiLang: false,
    languageStats: { typescript: 1 },
    moduleCount: 1,
    moduleSeeds: [],
    presenterInput: {
      files: [],
      map: null,
      modules: [],
      refs: [],
      unavailable: [],
      warnings: [],
    },
    primaryLang: 'typescript',
    projectContextSummary: { source: 'project-context' },
    projectRoot: '/tmp/project',
    projectType: 'library',
    report: {},
    requestKinds: ['space', 'repo'],
    secondaryLanguages: [],
    targetCount: 0,
    warnings: [],
  } as unknown as ProjectContextWorkflowFacts;
}

function makeContainer(
  store: JobStore,
  options: {
    agentService?: unknown;
    dataRoot?: string;
    recorder?: JobProcessEventRecorder;
  } = {}
): ServiceContainer {
  const dataRoot = options.dataRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-plan-gate-'));
  const recorder = options.recorder ?? new JobProcessEventRecorder();
  const displayStore = { writeFromJob: vi.fn() };

  return {
    singletons: {
      _workspaceResolver: {
        currentFolderId: null,
        dataRoot,
        projectRoot: dataRoot,
        projectScope: null,
      },
    },
    get(name: string) {
      if (name === 'agentService') {
        return options.agentService ?? { run: vi.fn() };
      }
      if (name === 'jobDisplaySnapshotStore') {
        return displayStore;
      }
      if (name === 'jobProcessEventRecorder') {
        return recorder;
      }
      if (name === 'jobStore') {
        return store;
      }
      throw new Error(`missing service: ${name}`);
    },
  } as unknown as ServiceContainer;
}

beforeEach(() => {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-plan-gate-home-'));
  vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(makeFacts());
  vi.mocked(runColdStartWorkflow).mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  vi.resetAllMocks();
});

describe('DaemonJobRunner bootstrap plan gate', () => {
  test('fails the daemon job before coldStart when the plan agent fails', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { recorder });
    const logger = makeLogger();
    const job = store.create({ kind: 'bootstrap', source: 'dashboard' });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockRejectedValue(new Error('provider unavailable'));

    await expect(
      runDaemonJob({
        container,
        jobId: job.id,
        kind: 'bootstrap',
        logger,
        source: 'dashboard',
      })
    ).rejects.toThrow('Bootstrap plan gate failed: provider unavailable');

    expect(runColdStartWorkflow).not.toHaveBeenCalled();
    expect(store.get(job.id)).toMatchObject({
      status: 'failed',
      error: { message: 'Bootstrap plan gate failed: provider unavailable' },
    });
    expect(recorder.list(job.id, { limit: 20 }).developerViews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'plan-gate',
          summary: 'Bootstrap plan gate failed before coldStart: provider unavailable',
          title: 'Bootstrap plan gate failed',
        }),
      ])
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/fallback[- ]?to[- ]?full/iu);
    expect(JSON.stringify(recorder.list(job.id, { limit: 20 }).developerViews)).not.toMatch(
      /fallback[- ]?to[- ]?full|回退全量/iu
    );
  });

  test('aborts empty plan dimensions without running coldStart', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const container = makeContainer(store);
    const logger = makeLogger();
    const job = store.create({ kind: 'bootstrap', source: 'dashboard' });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValue({
      dimensions: [],
      generationStage: 'coldStart',
      moduleBindings: [],
      scale: { totalRecipeBudget: 1 },
    });

    await expect(
      runDaemonJob({
        container,
        jobId: job.id,
        kind: 'bootstrap',
        logger,
        source: 'dashboard',
      })
    ).rejects.toThrow('Invalid PlanSelection: dimensions must be non-empty');

    expect(runColdStartWorkflow).not.toHaveBeenCalled();
    expect(store.get(job.id)?.status).toBe('failed');
  });

  test('rejects a wrong-stage plan selection before coldStart', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { recorder });
    const logger = makeLogger();
    const job = store.create({ kind: 'bootstrap', source: 'dashboard' });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValue({
      dimensions: ['architecture'],
      generationStage: 'deepMining',
      moduleBindings: [],
      scale: { totalRecipeBudget: 3 },
    });

    await expect(
      runDaemonJob({
        container,
        jobId: job.id,
        kind: 'bootstrap',
        logger,
        source: 'dashboard',
      })
    ).rejects.toThrow(
      'Bootstrap plan gate failed: Plan agent returned generationStage=deepMining for coldStart.'
    );

    expect(runColdStartWorkflow).not.toHaveBeenCalled();
    expect(store.get(job.id)).toMatchObject({
      status: 'failed',
      error: {
        message:
          'Bootstrap plan gate failed: Plan agent returned generationStage=deepMining for coldStart.',
      },
    });
    expect(recorder.list(job.id, { limit: 20 }).developerViews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'plan-gate',
          summary:
            'Bootstrap plan gate failed before coldStart: Plan agent returned generationStage=deepMining for coldStart.',
          title: 'Bootstrap plan gate failed',
        }),
      ])
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/fallback[- ]?to[- ]?full/iu);
    expect(JSON.stringify(recorder.list(job.id, { limit: 20 }).developerViews)).not.toMatch(
      /fallback[- ]?to[- ]?full|回退全量/iu
    );
  });

  test('passes legal narrow plan projection and scale budget into coldStart', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const projectContextFacts = makeFacts();
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(projectContextFacts);
    const container = makeContainer(store);
    const logger = makeLogger();
    const job = store.create({
      kind: 'bootstrap',
      request: { contentMaxLines: 500, dimensions: ['project-profile'], maxFiles: 900 },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValue({
      dimensions: ['architecture', 'coding-standards'],
      generationStage: 'coldStart',
      moduleBindings: [{ dimensions: ['architecture'], modulePath: 'lib/api', targetRecipes: 2 }],
      scale: { contentMaxLines: 60, maxFiles: 200, totalRecipeBudget: 7 },
    });

    await expect(
      runDaemonJob({
        args: { contentMaxLines: 500, dimensions: ['project-profile'], maxFiles: 900 },
        container,
        jobId: job.id,
        kind: 'bootstrap',
        logger,
        source: 'dashboard',
      })
    ).resolves.toMatchObject({ job: { status: 'completed' } });

    expect(runPlanAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        generationStage: 'coldStart',
        projectContextFacts,
      })
    );
    expect(runColdStartWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ container }),
      expect.objectContaining({
        contentMaxLines: 60,
        dimensions: ['project-profile'],
        maxFiles: 200,
        planSelectionProjection: {
          budget: { contentMaxLines: 60, maxFiles: 200, totalRecipeBudget: 7 },
          executionDimensions: ['architecture', 'coding-standards'],
          moduleScope: ['lib/api'],
        },
        projectContextFacts,
      })
    );
  });
});

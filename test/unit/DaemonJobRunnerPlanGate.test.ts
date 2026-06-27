import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runModuleMining, runPlanAgent } from '@alembic/agent/service';
import { JobStore } from '@alembic/core/daemon';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runDaemonJob } from '../../lib/daemon/DaemonJobRunner.js';
import { JobProcessEventRecorder } from '../../lib/daemon/JobProcessEventRecorder.js';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { runColdStartWorkflow } from '../../lib/workflows/cold-start/ColdStartWorkflow.js';
import { runKnowledgeRescanWorkflow } from '../../lib/workflows/knowledge-rescan/KnowledgeRescanWorkflow.js';
import {
  buildProjectContextWorkflowFacts,
  type ProjectContextWorkflowFacts,
} from '../../lib/workflows/project-context/ProjectContextWorkflowFacts.js';

vi.mock('@alembic/agent/service', () => ({
  runModuleMining: vi.fn(),
  runPlanAgent: vi.fn(),
}));

vi.mock('../../lib/workflows/project-context/ProjectContextWorkflowFacts.js', () => ({
  buildProjectContextWorkflowFacts: vi.fn(),
}));

vi.mock('../../lib/workflows/cold-start/ColdStartWorkflow.js', () => ({
  runColdStartWorkflow: vi.fn(),
}));

vi.mock('../../lib/workflows/knowledge-rescan/KnowledgeRescanWorkflow.js', () => ({
  runKnowledgeRescanWorkflow: vi.fn(),
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
    projectMapModules: [
      {
        moduleId: 'lib-api',
        moduleName: 'api',
        modulePath: 'lib/api',
        ownedFiles: ['lib/api/index.ts'],
      },
    ],
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

function makeProjectMapFacts(count: number): ProjectContextWorkflowFacts {
  return {
    ...makeFacts(),
    moduleCount: count,
    moduleSeeds: [
      {
        moduleName: 'seed-only',
        modulePath: 'seed/only',
      },
    ],
    projectMapModules: Array.from({ length: count }, (_, index) => ({
      moduleId: `mod-${index + 1}`,
      moduleName: `module-${index + 1}`,
      modulePath: `src/module-${index + 1}`,
      ownedFiles: [`src/module-${index + 1}/index.ts`],
    })),
  };
}

function makeCoverageLedgerRepository() {
  const cells = new Map<string, Record<string, unknown>>();
  const rounds = new Map<number, Record<string, unknown>>();
  return {
    getCell: vi.fn((scope: { dimensionId: string; moduleId: string; projectRoot: string }) => {
      return cells.get(`${scope.projectRoot}:${scope.moduleId}:${scope.dimensionId}`) ?? null;
    }),
    listByProjectRoot: vi.fn((projectRoot: string) =>
      [...cells.values()].filter((cell) => cell.projectRoot === projectRoot)
    ),
    listRoundsByProjectRoot: vi.fn((projectRoot: string) =>
      [...rounds.values()]
        .filter((round) => round.projectRoot === projectRoot)
        .sort((left, right) => Number(left.roundIndex) - Number(right.roundIndex))
    ),
    upsertCell: vi.fn((input: Record<string, unknown>) => {
      const key = `${input.projectRoot}:${input.moduleId}:${input.dimensionId}`;
      const saved = {
        coveredCount: 0,
        createdAt: Date.now(),
        deferred: false,
        exhausted: false,
        exhaustedReason: null,
        exhaustedSource: null,
        grade: 'empty',
        totalCandidateCount: 0,
        uncoveredHints: [],
        updatedAt: Date.now(),
        valueScore: 1,
        ...input,
      };
      cells.set(key, saved);
      return saved;
    }),
    upsertRound: vi.fn((input: Record<string, unknown>) => {
      const saved = {
        createdAt: Date.now(),
        newRecipesThisRound: 0,
        updatedAt: Date.now(),
        ...rounds.get(Number(input.roundIndex)),
        ...input,
      };
      rounds.set(Number(saved.roundIndex), saved);
      return saved;
    }),
  };
}

function makeContainer(
  store: JobStore,
  options: {
    agentService?: unknown;
    coverageLedgerRepository?: unknown;
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
      if (name === 'coverageLedgerRepository') {
        return options.coverageLedgerRepository;
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
  vi.mocked(runKnowledgeRescanWorkflow).mockResolvedValue({ data: { ok: true } });
  vi.mocked(runModuleMining).mockResolvedValue({
    phases: { moduleResults: { core: { recipes: [{ id: 'r1' }] } } },
    status: 'success',
  });
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

describe('DaemonJobRunner deepMining plan gate', () => {
  test('aborts before rescan when the deepMining plan gate fails', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const container = makeContainer(store, {
      coverageLedgerRepository: makeCoverageLedgerRepository(),
    });
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: { generationStage: 'deepMining' },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockRejectedValue(new Error('provider unavailable'));

    await expect(
      runDaemonJob({
        args: { generationStage: 'deepMining' },
        container,
        jobId: job.id,
        kind: 'rescan',
        logger,
        source: 'dashboard',
      })
    ).rejects.toThrow('DeepMining plan gate failed: provider unavailable');

    expect(runKnowledgeRescanWorkflow).not.toHaveBeenCalled();
    expect(store.get(job.id)).toMatchObject({
      status: 'failed',
      error: { message: 'DeepMining plan gate failed: provider unavailable' },
    });
  });

  test('runs deepMining as one daemon job across rounds and passes plan targets to rescan', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const container = makeContainer(store, { coverageLedgerRepository });
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: { generationStage: 'deepMining', maxRounds: 3 },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValue({
      dimensions: ['architecture'],
      generationStage: 'deepMining',
      moduleBindings: [
        {
          dimensions: ['architecture'],
          moduleId: 'lib-api',
          modulePath: 'lib/api',
          priority: 1,
          targetRecipes: 8,
        },
      ],
      scale: { contentMaxLines: 80, maxFiles: 240, totalRecipeBudget: 8 },
    });
    vi.mocked(runKnowledgeRescanWorkflow)
      .mockResolvedValueOnce({ data: { newRecipesThisRound: 2 } })
      .mockResolvedValueOnce({ data: { newRecipesThisRound: 0 } });

    await expect(
      runDaemonJob({
        args: { generationStage: 'deepMining', maxRounds: 3 },
        container,
        jobId: job.id,
        kind: 'rescan',
        logger,
        source: 'dashboard',
      })
    ).resolves.toMatchObject({
      job: { status: 'completed' },
      result: {
        deepMining: {
          rounds: [
            expect.objectContaining({ newRecipesThisRound: 2, roundIndex: 1 }),
            expect.objectContaining({ newRecipesThisRound: 0, roundIndex: 2 }),
          ],
          stopReason: 'diminishing-returns',
        },
      },
    });

    expect(runKnowledgeRescanWorkflow).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runKnowledgeRescanWorkflow).mock.calls[0]?.[1]).toMatchObject({
      contentMaxLines: 80,
      dimensions: ['architecture'],
      maxFiles: 240,
      miningMode: 'deepMining',
      moduleDimensionTargets: [
        {
          dimensionId: 'architecture',
          moduleId: 'lib-api',
          moduleName: 'api',
          targetRecipes: 8,
        },
      ],
      moduleScope: ['lib/api'],
      perDimensionTargets: { architecture: 8 },
      roundIndex: 1,
    });
    expect(vi.mocked(runKnowledgeRescanWorkflow).mock.calls[1]?.[1]).toMatchObject({
      roundIndex: 2,
    });
    expect(coverageLedgerRepository.upsertRound).toHaveBeenCalledWith(
      expect.objectContaining({ roundIndex: 1 })
    );
    expect(coverageLedgerRepository.upsertRound).toHaveBeenCalledWith(
      expect.objectContaining({ newRecipesThisRound: 0, roundIndex: 2 })
    );
  });
});

describe('DaemonJobRunner moduleMining plan gate', () => {
  test('fans out from ProjectMap modules instead of moduleSeeds and applies scaleCap as module cap', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const facts = makeProjectMapFacts(8);
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(facts);
    const container = makeContainer(store);
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: { generationStage: 'moduleMining' },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValue({
      dimensions: ['architecture'],
      generationStage: 'moduleMining',
      moduleBindings: facts.projectMapModules.map((module) => ({
        dimensions: ['architecture'],
        moduleId: module.moduleId,
        modulePath: module.modulePath ?? module.moduleId,
        priority: 1,
        targetRecipes: 2,
      })),
      scale: { contentMaxLines: 120, maxFiles: 500, totalRecipeBudget: 3 },
    });
    vi.mocked(runModuleMining).mockResolvedValue({
      phases: {
        moduleResults: {
          'mod-1': { recipes: [{ id: 'r1' }] },
          'mod-2': { recipes: [{ id: 'r2' }] },
          'mod-3': { recipes: [{ id: 'r3' }] },
        },
      },
      status: 'success',
    });

    await expect(
      runDaemonJob({
        args: { generationStage: 'moduleMining' },
        container,
        jobId: job.id,
        kind: 'rescan',
        logger,
        source: 'dashboard',
      })
    ).resolves.toMatchObject({
      job: { status: 'completed' },
      result: {
        moduleMining: {
          moduleCount: 3,
          newRecipes: 3,
          scaleCap: 3,
        },
      },
    });

    expect(runModuleMining).toHaveBeenCalledWith(
      expect.objectContaining({
        budget: { contentMaxLines: 120, maxFiles: 500, totalRecipeBudget: 3 },
        modules: [
          expect.objectContaining({ moduleName: 'module-1' }),
          expect.objectContaining({ moduleName: 'module-2' }),
          expect.objectContaining({ moduleName: 'module-3' }),
        ],
        scaleCap: 3,
      })
    );
    expect(JSON.stringify(vi.mocked(runModuleMining).mock.calls[0]?.[0].modules)).not.toContain(
      'seed-only'
    );
  });

  test('fails moduleMining when ProjectMap modules are empty', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(makeProjectMapFacts(0));
    const container = makeContainer(store);
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: { generationStage: 'moduleMining' },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValue({
      dimensions: ['architecture'],
      generationStage: 'moduleMining',
      moduleBindings: [],
      scale: { totalRecipeBudget: 3 },
    });

    await expect(
      runDaemonJob({
        args: { generationStage: 'moduleMining' },
        container,
        jobId: job.id,
        kind: 'rescan',
        logger,
        source: 'dashboard',
      })
    ).rejects.toThrow('moduleMining requires at least one ProjectMap module.');
    expect(runModuleMining).not.toHaveBeenCalled();
  });
});

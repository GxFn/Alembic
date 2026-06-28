import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runModuleMining, runPlanAgent } from '@alembic/agent/service';
import { JobStore } from '@alembic/core/daemon';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runDaemonJob } from '../../lib/daemon/DaemonJobRunner.js';
import { JobProcessEventRecorder } from '../../lib/daemon/JobProcessEventRecorder.js';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import {
  buildProjectContextWorkflowFacts,
  type ProjectContextWorkflowFacts,
} from '../../lib/workflows/project-context/ProjectContextWorkflowFacts.js';
import { runProjectIndexWorkflow } from '../../lib/workflows/project-index/ProjectIndexWorkflow.js';

vi.mock('@alembic/agent/service', () => ({
  runModuleMining: vi.fn(),
  runPlanAgent: vi.fn(),
}));

vi.mock('../../lib/workflows/project-context/ProjectContextWorkflowFacts.js', () => ({
  buildProjectContextWorkflowFacts: vi.fn(),
}));

vi.mock('../../lib/workflows/project-index/ProjectIndexWorkflow.js', () => ({
  runProjectIndexWorkflow: vi.fn(),
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

function makeModuleMiningPersistenceRepositories() {
  const entries: Array<Record<string, unknown>> = [];
  const sourceRefs: Array<Record<string, unknown>> = [];
  const knowledgeRepository = {
    findWithPagination: vi.fn(() => ({
      data: [...entries],
      pagination: { page: 1, pageSize: 50_000, pages: 1, total: entries.length },
    })),
  };
  const recipeSourceRefRepository = {
    findAll: vi.fn(() => [...sourceRefs]),
  };
  return {
    addEntry(entry: Record<string, unknown>) {
      entries.push(entry);
    },
    addSourceRef(sourceRef: Record<string, unknown>) {
      sourceRefs.push(sourceRef);
    },
    knowledgeRepository,
    recipeSourceRefRepository,
  };
}

function makeContainer(
  store: JobStore,
  options: {
    agentService?: unknown;
    coverageLedgerRepository?: unknown;
    dataRoot?: string;
    knowledgeRepository?: unknown;
    recorder?: JobProcessEventRecorder;
    recipeSourceRefRepository?: unknown;
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
      if (name === 'knowledgeRepository' && options.knowledgeRepository) {
        return options.knowledgeRepository;
      }
      if (name === 'recipeSourceRefRepository' && options.recipeSourceRefRepository) {
        return options.recipeSourceRefRepository;
      }
      throw new Error(`missing service: ${name}`);
    },
  } as unknown as ServiceContainer;
}

function makeNamedDataRoot(name: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-plan-gate-root-'));
  const dataRoot = path.join(parent, name);
  fs.mkdirSync(dataRoot);
  return dataRoot;
}

beforeEach(() => {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-plan-gate-home-'));
  vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(makeFacts());
  vi.mocked(runProjectIndexWorkflow).mockResolvedValue({ data: { ok: true } });
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

    expect(runProjectIndexWorkflow).not.toHaveBeenCalled();
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

    expect(runProjectIndexWorkflow).not.toHaveBeenCalled();
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
      'Bootstrap plan gate failed: Invalid PlanSelection stage requirements: generationStage must be coldStart'
    );

    expect(runProjectIndexWorkflow).not.toHaveBeenCalled();
    expect(store.get(job.id)).toMatchObject({
      status: 'failed',
      error: {
        message:
          'Bootstrap plan gate failed: Invalid PlanSelection stage requirements: generationStage must be coldStart',
      },
    });
    expect(recorder.list(job.id, { limit: 20 }).developerViews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'plan-gate',
          summary:
            'Bootstrap plan gate failed before coldStart: Invalid PlanSelection stage requirements: generationStage must be coldStart',
          title: 'Bootstrap plan gate failed',
        }),
      ])
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/fallback[- ]?to[- ]?full/iu);
    expect(JSON.stringify(recorder.list(job.id, { limit: 20 }).developerViews)).not.toMatch(
      /fallback[- ]?to[- ]?full|回退全量/iu
    );
  });

  test('allows coldStart plans without module bindings', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const projectContextFacts = makeFacts();
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(projectContextFacts);
    const container = makeContainer(store);
    const logger = makeLogger();
    const job = store.create({
      kind: 'bootstrap',
      request: { dimensions: ['architecture'] },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValue({
      dimensions: ['architecture'],
      generationStage: 'coldStart',
      moduleBindings: [],
      scale: { contentMaxLines: 70, maxFiles: 180, totalRecipeBudget: 2 },
    });

    await expect(
      runDaemonJob({
        args: { dimensions: ['architecture'] },
        container,
        jobId: job.id,
        kind: 'bootstrap',
        logger,
        source: 'dashboard',
      })
    ).resolves.toMatchObject({ job: { status: 'completed' } });

    expect(runProjectIndexWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ container }),
      expect.objectContaining({
        dimensions: ['architecture'],
        planSelectionProjection: {
          budget: { contentMaxLines: 70, maxFiles: 180, totalRecipeBudget: 2 },
          executionDimensions: ['architecture'],
          moduleScope: [],
        },
        projectContextFacts,
      }),
      { mode: 'full' }
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
    expect(runProjectIndexWorkflow).toHaveBeenCalledWith(
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
      }),
      { mode: 'full' }
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

    expect(runProjectIndexWorkflow).not.toHaveBeenCalled();
    expect(store.get(job.id)).toMatchObject({
      status: 'failed',
      error: { message: 'DeepMining plan gate failed: provider unavailable' },
    });
  });

  test('rejects deepMining plans without module bindings before rescan starts', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { coverageLedgerRepository, recorder });
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: { generationStage: 'deepMining' },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValue({
      dimensions: ['architecture'],
      generationStage: 'deepMining',
      moduleBindings: [],
      scale: { totalRecipeBudget: 3 },
    });

    await expect(
      runDaemonJob({
        args: { generationStage: 'deepMining' },
        container,
        jobId: job.id,
        kind: 'rescan',
        logger,
        source: 'dashboard',
      })
    ).rejects.toThrow(
      'DeepMining plan gate failed: Invalid PlanSelection stage requirements: deepMining requires moduleBindings with module×dimension targets'
    );

    expect(runProjectIndexWorkflow).not.toHaveBeenCalled();
    expect(coverageLedgerRepository.upsertRound).not.toHaveBeenCalled();
    expect(store.get(job.id)).toMatchObject({
      status: 'failed',
      error: {
        message: expect.stringContaining(
          'DeepMining plan gate failed: Invalid PlanSelection stage requirements'
        ),
      },
    });
    expect(recorder.list(job.id, { limit: 20 }).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'plan-gate',
          severity: 'error',
          summary: expect.stringContaining('deepMining requires moduleBindings'),
          title: 'DeepMining plan gate failed',
        }),
      ])
    );
  });

  test('runs deepMining as one daemon job across rounds and passes plan targets to rescan', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const container = makeContainer(store, { coverageLedgerRepository });
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: { generationStage: 'deepMining', maxRounds: 1 },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent)
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        dimensions: ['coding-standards'],
        generationStage: 'deepMining',
        moduleBindings: [
          {
            dimensions: ['coding-standards'],
            moduleId: 'lib-core',
            modulePath: 'lib/core',
            priority: 1,
            targetRecipes: 3,
          },
        ],
        scale: { contentMaxLines: 90, maxFiles: 300, totalRecipeBudget: 3 },
      });
    vi.mocked(runProjectIndexWorkflow)
      .mockResolvedValueOnce({ data: { newRecipesThisRound: 2 } })
      .mockResolvedValueOnce({ data: { newRecipesThisRound: 0 } });

    await expect(
      runDaemonJob({
        args: { generationStage: 'deepMining', maxRounds: 1 },
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

    expect(runPlanAgent).toHaveBeenCalledTimes(2);
    expect(runProjectIndexWorkflow).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runProjectIndexWorkflow).mock.calls[0]?.[2]).toEqual({
      mode: 'incremental',
    });
    expect(vi.mocked(runProjectIndexWorkflow).mock.calls[0]?.[1]).toMatchObject({
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
    expect(vi.mocked(runProjectIndexWorkflow).mock.calls[1]?.[2]).toEqual({
      mode: 'incremental',
    });
    expect(vi.mocked(runProjectIndexWorkflow).mock.calls[1]?.[1]).toMatchObject({
      contentMaxLines: 90,
      dimensions: ['coding-standards'],
      maxFiles: 300,
      moduleDimensionTargets: [
        {
          dimensionId: 'coding-standards',
          moduleId: 'lib-core',
          moduleName: 'core',
          targetRecipes: 3,
        },
      ],
      moduleScope: ['lib/core'],
      perDimensionTargets: { 'coding-standards': 3 },
      roundIndex: 2,
    });
    expect(coverageLedgerRepository.upsertRound).toHaveBeenCalledWith(
      expect.objectContaining({ roundIndex: 1 })
    );
    expect(coverageLedgerRepository.upsertRound).toHaveBeenCalledWith(
      expect.objectContaining({ newRecipesThisRound: 0, roundIndex: 2 })
    );
  });

  test('counts only inline source-ref-backed deepMining production before advisor review', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const container = makeContainer(store, { coverageLedgerRepository });
    const projectRoot = (
      container as unknown as {
        singletons: { _workspaceResolver: { projectRoot: string } };
      }
    ).singletons._workspaceResolver.projectRoot;
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: { generationStage: 'deepMining', maxRounds: 1 },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(makeProjectMapFacts(1));
    vi.mocked(runPlanAgent).mockResolvedValueOnce({
      dimensions: ['architecture'],
      generationStage: 'deepMining',
      moduleBindings: [
        {
          dimensions: ['architecture'],
          moduleId: 'mod-1',
          modulePath: 'src/module-1',
          priority: 1,
          targetRecipes: 1,
        },
      ],
      scale: { k: 1, maxRounds: 1, totalRecipeBudget: 1 },
    });
    vi.mocked(runProjectIndexWorkflow).mockImplementationOnce(async (_ctx, args, options) => {
      expect(options).toEqual({ mode: 'incremental' });
      expect(args).toMatchObject({
        internalExecution: { runAsyncFillInline: true },
        miningMode: 'deepMining',
        roundIndex: 1,
      });
      coverageLedgerRepository.upsertCell({
        coveredCount: 1,
        coveredSourceRefs: ['src/module-1/index.ts'],
        dimensionId: 'architecture',
        grade: 'partial',
        lastRound: args.roundIndex,
        moduleId: 'mod-1',
        projectRoot,
        totalCandidateCount: 1,
        valueScore: 50,
      });
      return {
        data: {
          coverageLedger: { writtenCells: 1 },
          newRecipesThisRound: 1,
        },
      };
    });

    await expect(
      runDaemonJob({
        args: { generationStage: 'deepMining', maxRounds: 1 },
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
          rounds: [expect.objectContaining({ newRecipesThisRound: 1, roundIndex: 1 })],
          stopReason: 'converged',
        },
      },
    });

    expect(coverageLedgerRepository.listByProjectRoot(projectRoot)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          coveredCount: 1,
          coveredSourceRefs: ['src/module-1/index.ts'],
          dimensionId: 'architecture',
          grade: 'partial',
          lastRound: 1,
          moduleId: 'mod-1',
        }),
      ])
    );
    expect(coverageLedgerRepository.upsertRound).toHaveBeenCalledWith(
      expect.objectContaining({ newRecipesThisRound: 1, roundIndex: 1 })
    );
    const inlineCoverageWriteOrder =
      coverageLedgerRepository.upsertCell.mock.invocationCallOrder.at(-1);
    const roundCloseCallIndex = coverageLedgerRepository.upsertRound.mock.calls.findIndex(
      ([input]) => input.newRecipesThisRound === 1 && input.roundIndex === 1
    );
    const roundCloseOrder =
      coverageLedgerRepository.upsertRound.mock.invocationCallOrder[roundCloseCallIndex];
    if (inlineCoverageWriteOrder === undefined || roundCloseOrder === undefined) {
      throw new Error('Expected inline coverage write and round close calls to be observed.');
    }
    expect(inlineCoverageWriteOrder).toBeLessThan(roundCloseOrder);
  });

  test('exposes a coverageLedgerSeed from completed target-scoped ledger state', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { coverageLedgerRepository, recorder });
    const projectRoot = (
      container as unknown as {
        singletons: { _workspaceResolver: { projectRoot: string } };
      }
    ).singletons._workspaceResolver.projectRoot;
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: { generationStage: 'deepMining', maxRounds: 1 },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(makeProjectMapFacts(1));
    vi.mocked(runPlanAgent).mockResolvedValueOnce({
      dimensions: ['architecture'],
      generationStage: 'deepMining',
      moduleBindings: [
        {
          dimensions: ['architecture'],
          moduleId: 'target:Account:Sources/Infrastructure/Account',
          modulePath: 'Sources/Infrastructure/Account',
          priority: 1,
          targetRecipes: 2,
        },
      ],
      scale: { k: 1, maxRounds: 1, totalRecipeBudget: 2 },
    });
    vi.mocked(runProjectIndexWorkflow).mockImplementationOnce(async (_ctx, args) => {
      coverageLedgerRepository.upsertCell({
        coveredCount: 2,
        coveredSourceRefs: [
          'Sources/Infrastructure/Account/LoginService.swift',
          'Sources/Infrastructure/Account/UserSession.swift',
        ],
        dimensionId: 'architecture',
        grade: 'covered',
        lastRound: args.roundIndex,
        moduleId: 'target:Account:Sources/Infrastructure/Account',
        projectRoot,
        totalCandidateCount: 2,
      });
      return {
        data: {
          coverageLedger: { writtenCells: 1 },
          newRecipesThisRound: 2,
        },
      };
    });

    const result = await runDaemonJob({
      args: { generationStage: 'deepMining', maxRounds: 1 },
      container,
      jobId: job.id,
      kind: 'rescan',
      logger,
      source: 'dashboard',
    });

    const expectedSeed = {
      aggregateOrRootModuleIds: [],
      coveredPathCount: 2,
      dimensionIds: ['architecture'],
      measuredCells: 1,
      moduleCount: 1,
      status: 'written',
      targetScopedCells: 1,
      usableCells: 1,
      writtenCells: 1,
    };
    expect(result).toMatchObject({
      job: {
        result: {
          coverageLedgerSeed: expectedSeed,
          deepMining: { coverageLedgerSeed: expectedSeed },
        },
        status: 'completed',
      },
      result: {
        coverageLedgerSeed: expectedSeed,
        deepMining: { coverageLedgerSeed: expectedSeed },
      },
    });
    expect(recorder.list(job.id).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.objectContaining({
            mimeType: 'application/json',
            text: expect.stringContaining('coverageLedgerSeed'),
          }),
          metadata: expect.objectContaining({
            coverageLedgerSeed: expectedSeed,
          }),
          phase: 'deep-mining',
          severity: 'success',
          title: 'DeepMining coverage ledger seed retained',
        }),
      ])
    );
  });

  test('keeps package-root targets in the coverageLedgerSeed when they are not the project root', async () => {
    const dataRoot = makeNamedDataRoot('BiliDili');
    const store = new JobStore({ projectRoot: dataRoot });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { coverageLedgerRepository, dataRoot, recorder });
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: { generationStage: 'deepMining', maxRounds: 1 },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue({
      ...makeFacts(),
      moduleCount: 1,
      projectMapModules: [
        {
          moduleId: 'target:Account:.',
          moduleName: 'Account',
          modulePath: '.',
          ownedFiles: [
            'Sources/Infrastructure/Account/LoginService.swift',
            'Sources/Infrastructure/Account/UserSession.swift',
          ],
        },
      ],
      projectRoot: dataRoot,
    } as ProjectContextWorkflowFacts);
    vi.mocked(runPlanAgent).mockResolvedValueOnce({
      dimensions: ['architecture'],
      generationStage: 'deepMining',
      moduleBindings: [
        {
          dimensions: ['architecture'],
          moduleId: 'target:Account:.',
          modulePath: '.',
          priority: 1,
          targetRecipes: 2,
        },
      ],
      scale: { k: 1, maxRounds: 1, totalRecipeBudget: 2 },
    });
    vi.mocked(runProjectIndexWorkflow).mockImplementationOnce(async (_ctx, args) => {
      coverageLedgerRepository.upsertCell({
        coveredCount: 2,
        coveredSourceRefs: [
          'Sources/Infrastructure/Account/LoginService.swift',
          'Sources/Infrastructure/Account/UserSession.swift',
        ],
        dimensionId: 'architecture',
        grade: 'covered',
        lastRound: args.roundIndex,
        moduleId: 'target:Account:.',
        projectRoot: dataRoot,
        totalCandidateCount: 2,
      });
      return {
        data: {
          coverageLedger: { writtenCells: 1 },
          newRecipesThisRound: 2,
        },
      };
    });

    const result = await runDaemonJob({
      args: { generationStage: 'deepMining', maxRounds: 1 },
      container,
      jobId: job.id,
      kind: 'rescan',
      logger,
      source: 'dashboard',
    });

    const expectedSeed = {
      aggregateOrRootModuleIds: [],
      coveredPathCount: 2,
      dimensionIds: ['architecture'],
      measuredCells: 1,
      moduleCount: 1,
      status: 'written',
      targetScopedCells: 1,
      usableCells: 1,
      writtenCells: 1,
    };
    expect(result).toMatchObject({
      job: {
        result: {
          coverageLedgerSeed: expectedSeed,
          deepMining: { coverageLedgerSeed: expectedSeed },
        },
        status: 'completed',
      },
      result: {
        coverageLedgerSeed: expectedSeed,
        deepMining: { coverageLedgerSeed: expectedSeed },
      },
    });
    expect(recorder.list(job.id).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            coverageLedgerSeed: expectedSeed,
          }),
          phase: 'deep-mining',
          severity: 'success',
          title: 'DeepMining coverage ledger seed retained',
        }),
      ])
    );
  });

  test('does not mark aggregate root coverage rows as a written coverageLedgerSeed', async () => {
    const dataRoot = makeNamedDataRoot('BiliDili');
    const store = new JobStore({ projectRoot: dataRoot });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { coverageLedgerRepository, dataRoot, recorder });
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: { generationStage: 'deepMining', maxRounds: 1 },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue({
      ...makeFacts(),
      moduleCount: 1,
      projectMapModules: [
        {
          moduleId: 'target:BiliDili:.',
          moduleName: 'BiliDili',
          modulePath: '.',
          ownedFiles: ['Package.swift'],
        },
      ],
      projectRoot: dataRoot,
    } as ProjectContextWorkflowFacts);
    vi.mocked(runPlanAgent).mockResolvedValueOnce({
      dimensions: ['architecture'],
      generationStage: 'deepMining',
      moduleBindings: [
        {
          dimensions: ['architecture'],
          moduleId: 'target:BiliDili:.',
          modulePath: '.',
          priority: 1,
          targetRecipes: 1,
        },
      ],
      scale: { k: 1, maxRounds: 1, totalRecipeBudget: 1 },
    });
    vi.mocked(runProjectIndexWorkflow).mockImplementationOnce(async (_ctx, args) => {
      coverageLedgerRepository.upsertCell({
        coveredCount: 1,
        coveredSourceRefs: ['Package.swift'],
        dimensionId: 'architecture',
        grade: 'covered',
        lastRound: args.roundIndex,
        moduleId: 'target:BiliDili:.',
        projectRoot: dataRoot,
        totalCandidateCount: 1,
      });
      return {
        data: {
          coverageLedger: { writtenCells: 1 },
          newRecipesThisRound: 1,
        },
      };
    });

    const result = await runDaemonJob({
      args: { generationStage: 'deepMining', maxRounds: 1 },
      container,
      jobId: job.id,
      kind: 'rescan',
      logger,
      source: 'dashboard',
    });

    expect(result).toMatchObject({
      job: { status: 'completed' },
      result: {
        coverageLedgerSeed: {
          aggregateOrRootModuleIds: ['target:BiliDili:.'],
          dimensionIds: [],
          measuredCells: 0,
          moduleCount: 0,
          reason: 'aggregate-or-root-only',
          status: 'skipped',
          targetScopedCells: 0,
          usableCells: 0,
          writtenCells: 1,
        },
      },
    });
    expect(recorder.list(job.id).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            coverageLedgerSeed: expect.objectContaining({
              reason: 'aggregate-or-root-only',
              status: 'skipped',
            }),
          }),
          phase: 'deep-mining',
          severity: 'warning',
          title: 'DeepMining coverage ledger seed retained',
        }),
      ])
    );
  });

  test('fail-closes an opened deepMining round when incremental workflow throws', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { coverageLedgerRepository, recorder });
    const projectRoot = (
      container as unknown as {
        singletons: { _workspaceResolver: { projectRoot: string } };
      }
    ).singletons._workspaceResolver.projectRoot;
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: {
        contentMaxLines: 40,
        dimensions: ['architecture'],
        generationStage: 'deepMining',
        maxFiles: 4,
        scaleCap: 1,
      },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValueOnce({
      dimensions: ['architecture', 'coding-standards'],
      generationStage: 'deepMining',
      moduleBindings: [
        {
          dimensions: ['architecture', 'coding-standards'],
          moduleId: 'lib-api',
          modulePath: 'lib/api',
          priority: 1,
          targetRecipes: 1,
        },
      ],
      scale: { totalRecipeBudget: 2 },
    });
    vi.mocked(runProjectIndexWorkflow).mockRejectedValueOnce(
      new Error('bootstrap lease already active')
    );

    await expect(
      runDaemonJob({
        args: {
          contentMaxLines: 40,
          dimensions: ['architecture'],
          generationStage: 'deepMining',
          maxFiles: 4,
          scaleCap: 1,
        },
        container,
        jobId: job.id,
        kind: 'rescan',
        logger,
        source: 'dashboard',
      })
    ).rejects.toThrow('bootstrap lease already active');

    expect(coverageLedgerRepository.upsertRound).toHaveBeenCalledWith(
      expect.objectContaining({
        completedAt: expect.any(Number),
        newRecipesThisRound: 0,
        rescanId: `${job.id}:deepMining:1`,
        roundIndex: 1,
      })
    );
    expect(coverageLedgerRepository.listRoundsByProjectRoot(projectRoot)).toEqual([
      expect.objectContaining({
        completedAt: expect.any(Number),
        newRecipesThisRound: 0,
        rescanId: `${job.id}:deepMining:1`,
        roundIndex: 1,
      }),
    ]);
    expect(recorder.list(job.id).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'deep-mining',
          severity: 'error',
          summary: expect.stringContaining('row was closed with 0 new recipe'),
          title: 'DeepMining round failed closed',
        }),
      ])
    );
    expect(store.get(job.id)).toMatchObject({
      error: { message: 'bootstrap lease already active' },
      status: 'failed',
    });
  });

  test('applies explicit deepMining parity seed to plan projection and rescan args', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { coverageLedgerRepository, recorder });
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: {
        contentMaxLines: 40,
        dimensions: ['architecture'],
        generationStage: 'deepMining',
        maxFiles: 4,
        maxRounds: 1,
        minNewRecipes: 1,
        scaleCap: 1,
      },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValueOnce({
      dimensions: ['architecture', 'coding-standards', 'error-resilience'],
      generationStage: 'deepMining',
      moduleBindings: [
        {
          dimensions: ['architecture', 'coding-standards'],
          moduleId: 'lib-api',
          modulePath: 'lib/api',
          priority: 1,
          targetRecipes: 8,
        },
        {
          dimensions: ['architecture', 'error-resilience'],
          moduleId: 'lib-core',
          modulePath: 'lib/core',
          priority: 2,
          targetRecipes: 3,
        },
      ],
      scale: { contentMaxLines: 120, maxFiles: 500, totalRecipeBudget: 9 },
    });
    vi.mocked(runProjectIndexWorkflow).mockResolvedValueOnce({
      data: { newRecipesThisRound: 0 },
    });

    await expect(
      runDaemonJob({
        args: {
          contentMaxLines: 40,
          dimensions: ['architecture'],
          generationStage: 'deepMining',
          maxFiles: 4,
          maxRounds: 1,
          minNewRecipes: 1,
          scaleCap: 1,
        },
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
          advisor: {
            k: 1,
            maxRounds: 1,
          },
          rounds: [expect.objectContaining({ newRecipesThisRound: 0, roundIndex: 1 })],
          stopReason: 'diminishing-returns',
        },
        planSelectionProjection: {
          budget: { contentMaxLines: 40, maxFiles: 4, totalRecipeBudget: 1 },
          executionDimensions: ['architecture'],
          moduleScope: ['lib/api'],
        },
      },
    });

    expect(runProjectIndexWorkflow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runProjectIndexWorkflow).mock.calls[0]?.[1]).toMatchObject({
      contentMaxLines: 40,
      dimensions: ['architecture'],
      maxFiles: 4,
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
    expect(recorder.list(job.id).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            requestConstraints: expect.objectContaining({
              contentMaxLines: 40,
              dimensions: ['architecture'],
              maxFiles: 4,
              maxRounds: 1,
              minNewRecipes: 1,
              scaleCap: 1,
            }),
          }),
          phase: 'plan-gate',
          severity: 'success',
        }),
      ])
    );
  });

  test('matches deepMining moduleScope against root project aliases', async () => {
    const dataRoot = makeNamedDataRoot('BiliDili');
    const store = new JobStore({ projectRoot: dataRoot });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { coverageLedgerRepository, dataRoot, recorder });
    const projectContextFacts = {
      ...makeFacts(),
      moduleCount: 1,
      projectMapModules: [
        {
          moduleId: 'target:BiliDili:.',
          moduleName: 'BiliDili',
          modulePath: '.',
          ownedFiles: ['Package.swift'],
        },
      ],
      projectRoot: dataRoot,
    } as ProjectContextWorkflowFacts;
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(projectContextFacts);
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: {
        contentMaxLines: 40,
        dimensions: ['architecture'],
        generationStage: 'deepMining',
        maxFiles: 4,
        maxRounds: 1,
        minNewRecipes: 1,
        moduleScope: ['BiliDili'],
        scaleCap: 1,
      },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValueOnce({
      dimensions: ['architecture', 'coding-standards'],
      generationStage: 'deepMining',
      moduleBindings: [
        {
          dimensions: ['architecture', 'coding-standards'],
          moduleId: 'target:BiliDili:.',
          modulePath: '.',
          priority: 1,
          targetRecipes: 8,
        },
        {
          dimensions: ['architecture'],
          moduleId: 'lib-other',
          modulePath: 'lib/other',
          priority: 2,
          targetRecipes: 3,
        },
      ],
      scale: { contentMaxLines: 120, maxFiles: 500, totalRecipeBudget: 9 },
    });
    vi.mocked(runProjectIndexWorkflow).mockResolvedValueOnce({
      data: { newRecipesThisRound: 0 },
    });

    await expect(
      runDaemonJob({
        args: {
          contentMaxLines: 40,
          dimensions: ['architecture'],
          generationStage: 'deepMining',
          maxFiles: 4,
          maxRounds: 1,
          minNewRecipes: 1,
          moduleScope: ['BiliDili'],
          scaleCap: 1,
        },
        container,
        jobId: job.id,
        kind: 'rescan',
        logger,
        source: 'dashboard',
      })
    ).resolves.toMatchObject({
      job: { status: 'completed' },
      result: {
        planSelectionProjection: {
          budget: { contentMaxLines: 40, maxFiles: 4, totalRecipeBudget: 1 },
          executionDimensions: ['architecture'],
          moduleScope: ['.'],
        },
      },
    });

    expect(runProjectIndexWorkflow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runProjectIndexWorkflow).mock.calls[0]?.[1]).toMatchObject({
      contentMaxLines: 40,
      dimensions: ['architecture'],
      maxFiles: 4,
      miningMode: 'deepMining',
      moduleDimensionTargets: [
        {
          dimensionId: 'architecture',
          moduleId: 'target:BiliDili:.',
          moduleName: '.',
          targetRecipes: 8,
        },
      ],
      moduleScope: ['.'],
      perDimensionTargets: { architecture: 8 },
      roundIndex: 1,
    });
    expect(recorder.list(job.id).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            requestConstraints: expect.objectContaining({
              moduleScope: ['BiliDili'],
            }),
          }),
          phase: 'plan-gate',
          severity: 'success',
        }),
      ])
    );
  });

  test('keeps real nested deepMining module targets when moduleScope names the project root', async () => {
    const dataRoot = makeNamedDataRoot('BiliDili');
    const store = new JobStore({ projectRoot: dataRoot });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { coverageLedgerRepository, dataRoot, recorder });
    const projectContextFacts = {
      ...makeFacts(),
      moduleCount: 2,
      projectMapModules: [
        {
          moduleId: 'target:Account:Sources/Infrastructure/Account',
          moduleName: 'Account',
          modulePath: 'Sources/Infrastructure/Account',
          ownedFiles: ['Sources/Infrastructure/Account/Account.swift'],
        },
        {
          moduleId: 'target:Home:Sources/Features/Home',
          moduleName: 'Home',
          modulePath: 'Sources/Features/Home',
          ownedFiles: ['Sources/Features/Home/Home.swift'],
        },
      ],
      projectRoot: dataRoot,
    } as ProjectContextWorkflowFacts;
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(projectContextFacts);
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: {
        contentMaxLines: 40,
        dimensions: ['architecture'],
        generationStage: 'deepMining',
        maxFiles: 4,
        maxRounds: 1,
        minNewRecipes: 1,
        moduleScope: ['BiliDili'],
        scaleCap: 1,
      },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValueOnce({
      dimensions: ['architecture', 'coding-standards'],
      generationStage: 'deepMining',
      moduleBindings: [
        {
          dimensions: ['architecture', 'coding-standards'],
          moduleId: 'target:Account:Sources/Infrastructure/Account',
          modulePath: 'Sources/Infrastructure/Account',
          priority: 1,
          targetRecipes: 8,
        },
        {
          dimensions: ['architecture'],
          moduleId: 'target:Home:Sources/Features/Home',
          modulePath: 'Sources/Features/Home',
          priority: 2,
          targetRecipes: 3,
        },
      ],
      scale: { contentMaxLines: 120, maxFiles: 500, totalRecipeBudget: 9 },
    });
    vi.mocked(runProjectIndexWorkflow).mockResolvedValueOnce({
      data: { newRecipesThisRound: 0 },
    });

    await expect(
      runDaemonJob({
        args: {
          contentMaxLines: 40,
          dimensions: ['architecture'],
          generationStage: 'deepMining',
          maxFiles: 4,
          maxRounds: 1,
          minNewRecipes: 1,
          moduleScope: ['BiliDili'],
          scaleCap: 1,
        },
        container,
        jobId: job.id,
        kind: 'rescan',
        logger,
        source: 'dashboard',
      })
    ).resolves.toMatchObject({
      job: { status: 'completed' },
      result: {
        planSelectionProjection: {
          budget: { contentMaxLines: 40, maxFiles: 4, totalRecipeBudget: 1 },
          executionDimensions: ['architecture'],
          moduleScope: ['Sources/Infrastructure/Account'],
        },
      },
    });

    expect(runProjectIndexWorkflow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runProjectIndexWorkflow).mock.calls[0]?.[1]).toMatchObject({
      contentMaxLines: 40,
      dimensions: ['architecture'],
      maxFiles: 4,
      miningMode: 'deepMining',
      moduleDimensionTargets: [
        {
          dimensionId: 'architecture',
          moduleId: 'target:Account:Sources/Infrastructure/Account',
          moduleName: 'Account',
          targetRecipes: 8,
        },
      ],
      moduleScope: ['Sources/Infrastructure/Account'],
      perDimensionTargets: { architecture: 8 },
      roundIndex: 1,
    });
    expect(recorder.list(job.id).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            requestConstraints: expect.objectContaining({
              moduleScope: ['BiliDili'],
            }),
          }),
          phase: 'plan-gate',
          severity: 'success',
        }),
      ])
    );
  });

  test('fails true deepMining moduleScope misses before opening a round', async () => {
    const dataRoot = makeNamedDataRoot('BiliDili');
    const store = new JobStore({ projectRoot: dataRoot });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { coverageLedgerRepository, dataRoot, recorder });
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: {
        dimensions: ['architecture'],
        generationStage: 'deepMining',
        moduleScope: ['MissingScope'],
      },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValueOnce({
      dimensions: ['architecture'],
      generationStage: 'deepMining',
      moduleBindings: [
        {
          dimensions: ['architecture'],
          moduleId: 'target:BiliDili:.',
          modulePath: '.',
          priority: 1,
          targetRecipes: 8,
        },
      ],
      scale: { contentMaxLines: 120, maxFiles: 500, totalRecipeBudget: 9 },
    });

    await expect(
      runDaemonJob({
        args: {
          dimensions: ['architecture'],
          generationStage: 'deepMining',
          moduleScope: ['MissingScope'],
        },
        container,
        jobId: job.id,
        kind: 'rescan',
        logger,
        source: 'dashboard',
      })
    ).rejects.toThrow(
      'DeepMining request constraints removed all module×dimension targets; moduleScope=MissingScope'
    );

    expect(runProjectIndexWorkflow).not.toHaveBeenCalled();
    expect(coverageLedgerRepository.upsertRound).not.toHaveBeenCalled();
    const recordedEvents = recorder.list(job.id).events;
    expect(recordedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'plan-gate',
          severity: 'error',
          summary: expect.stringContaining('availableModuleAliases='),
          title: 'DeepMining plan gate failed',
        }),
      ])
    );
    expect(JSON.stringify(recordedEvents)).toContain('BiliDili');
  });

  test('aborts before the next rescan when a later deepMining round plan gate fails', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { coverageLedgerRepository, recorder });
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: { generationStage: 'deepMining' },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent)
      .mockResolvedValueOnce({
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
        scale: { totalRecipeBudget: 8 },
      })
      .mockRejectedValueOnce(new Error('provider unavailable in round 2'));
    vi.mocked(runProjectIndexWorkflow).mockResolvedValueOnce({
      data: { newRecipesThisRound: 2 },
    });

    await expect(
      runDaemonJob({
        args: { generationStage: 'deepMining' },
        container,
        jobId: job.id,
        kind: 'rescan',
        logger,
        source: 'dashboard',
      })
    ).rejects.toThrow('DeepMining plan gate failed: provider unavailable in round 2');

    expect(runPlanAgent).toHaveBeenCalledTimes(2);
    expect(runProjectIndexWorkflow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runProjectIndexWorkflow).mock.calls[0]?.[2]).toEqual({
      mode: 'incremental',
    });
    expect(recorder.list(job.id).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'plan-gate',
          severity: 'error',
          summary: 'DeepMining plan gate failed before deepMining: provider unavailable in round 2',
        }),
      ])
    );
  });

  test('uses deepMining K and maxRounds from plan scale before job args', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const container = makeContainer(store, { coverageLedgerRepository });
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: { generationStage: 'deepMining', maxRounds: 99, minNewRecipes: 99 },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    const scaleWithAdvisorOverrides = {
      contentMaxLines: 80,
      k: 4,
      maxFiles: 240,
      maxRounds: 1,
      totalRecipeBudget: 8,
    } as unknown as { contentMaxLines: number; maxFiles: number; totalRecipeBudget: number };
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
      scale: scaleWithAdvisorOverrides,
    });
    vi.mocked(runProjectIndexWorkflow).mockResolvedValueOnce({
      data: { newRecipesThisRound: 5 },
    });

    await expect(
      runDaemonJob({
        args: { generationStage: 'deepMining', maxRounds: 99, minNewRecipes: 99 },
        container,
        jobId: job.id,
        kind: 'rescan',
        logger,
        source: 'dashboard',
      })
    ).resolves.toMatchObject({
      result: {
        deepMining: {
          advisor: {
            k: 4,
            maxRounds: 1,
          },
          rounds: [expect.objectContaining({ roundIndex: 1 })],
          stopReason: 'round-cap',
        },
      },
    });

    expect(runProjectIndexWorkflow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runProjectIndexWorkflow).mock.calls[0]?.[2]).toEqual({
      mode: 'incremental',
    });
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
          selectedModules: [
            expect.objectContaining({
              dimensions: ['architecture'],
              dimensionIds: ['architecture'],
              moduleName: 'module-1',
              plannedDimensions: ['architecture'],
            }),
            expect.objectContaining({
              dimensions: ['architecture'],
              dimensionIds: ['architecture'],
              moduleName: 'module-2',
              plannedDimensions: ['architecture'],
            }),
            expect.objectContaining({
              dimensions: ['architecture'],
              dimensionIds: ['architecture'],
              moduleName: 'module-3',
              plannedDimensions: ['architecture'],
            }),
          ],
        },
        planSelectionProjection: {
          moduleScope: [
            'src/module-1',
            'src/module-2',
            'src/module-3',
            'src/module-4',
            'src/module-5',
            'src/module-6',
            'src/module-7',
            'src/module-8',
          ],
        },
      },
    });

    expect(runModuleMining).toHaveBeenCalledWith(
      expect.objectContaining({
        budget: { contentMaxLines: 120, maxFiles: 500, totalRecipeBudget: 3 },
        modules: [
          expect.objectContaining({
            dimensions: ['architecture'],
            dimensionIds: ['architecture'],
            moduleName: 'module-1',
            plannedDimensions: ['architecture'],
          }),
          expect.objectContaining({
            dimensions: ['architecture'],
            dimensionIds: ['architecture'],
            moduleName: 'module-2',
            plannedDimensions: ['architecture'],
          }),
          expect.objectContaining({
            dimensions: ['architecture'],
            dimensionIds: ['architecture'],
            moduleName: 'module-3',
            plannedDimensions: ['architecture'],
          }),
        ],
        scaleCap: 3,
      })
    );
    expect(JSON.stringify(vi.mocked(runModuleMining).mock.calls[0]?.[0].modules)).not.toContain(
      'seed-only'
    );
  });

  test('applies Entry A moduleMining request constraints to plan gate and selected payload', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const facts = makeProjectMapFacts(2);
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(facts);
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { recorder });
    const logger = makeLogger();
    const job = store.create({
      kind: 'rescan',
      request: {
        dimensions: ['architecture'],
        generationStage: 'moduleMining',
        moduleScope: ['src/module-2'],
        scaleCap: 1,
      },
      source: 'dashboard',
    });
    store.markRunning(job.id);
    vi.mocked(runPlanAgent).mockResolvedValue({
      dimensions: ['architecture', 'api-design'],
      generationStage: 'moduleMining',
      moduleBindings: [
        {
          dimensions: ['api-design'],
          moduleId: 'mod-1',
          modulePath: 'src/module-1',
          priority: 1,
          targetRecipes: 2,
        },
        {
          dimensions: ['architecture', 'api-design'],
          moduleId: 'mod-2',
          modulePath: 'src/module-2',
          priority: 2,
          targetRecipes: 4,
        },
      ],
      scale: { contentMaxLines: 120, maxFiles: 500, totalRecipeBudget: 8 },
    });
    vi.mocked(runModuleMining).mockResolvedValueOnce({
      phases: { moduleResults: { 'mod-2': { recipes: [{ id: 'r1' }] } } },
      status: 'success',
    });

    await expect(
      runDaemonJob({
        args: {
          dimensions: ['architecture'],
          generationStage: 'moduleMining',
          moduleScope: ['src/module-2'],
          scaleCap: 1,
        },
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
          moduleCount: 1,
          scaleCap: 1,
          selectedModules: [
            expect.objectContaining({
              dimensions: ['architecture'],
              dimensionIds: ['architecture'],
              moduleId: 'target:module-2:src/module-2',
              moduleName: 'module-2',
              plannedDimensionTargets: { architecture: 4 },
              plannedDimensions: ['architecture'],
              targetRecipes: 4,
            }),
          ],
        },
        planSelectionProjection: {
          executionDimensions: ['architecture'],
          moduleScope: ['src/module-2'],
        },
      },
    });

    expect(runModuleMining).toHaveBeenCalledWith(
      expect.objectContaining({
        modules: [
          expect.objectContaining({
            dimensions: ['architecture'],
            moduleId: 'target:module-2:src/module-2',
            plannedDimensions: ['architecture'],
          }),
        ],
        scaleCap: 1,
      })
    );
    expect(recorder.list(job.id).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            requestConstraints: expect.objectContaining({
              dimensions: ['architecture'],
              moduleScope: ['src/module-2'],
              scaleCap: 1,
            }),
          }),
          phase: 'plan-gate',
          severity: 'success',
        }),
        expect.objectContaining({
          content: expect.objectContaining({
            mimeType: 'application/json',
            text: expect.stringContaining('selectedModules'),
          }),
          metadata: expect.objectContaining({
            selectedModules: [
              expect.objectContaining({
                dimensionIds: ['architecture'],
                moduleName: 'module-2',
                plannedDimensions: ['architecture'],
              }),
            ],
          }),
          phase: 'module-mining',
        }),
      ])
    );
  });

  test('rejects moduleMining plans without module bindings before module mining starts', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(makeProjectMapFacts(2));
    const recorder = new JobProcessEventRecorder();
    const container = makeContainer(store, { recorder });
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
    ).rejects.toThrow(
      'ModuleMining plan gate failed: Invalid PlanSelection stage requirements: moduleMining requires moduleBindings with module×dimension targets'
    );

    expect(runModuleMining).not.toHaveBeenCalled();
    expect(store.get(job.id)).toMatchObject({
      status: 'failed',
      error: {
        message: expect.stringContaining(
          'ModuleMining plan gate failed: Invalid PlanSelection stage requirements'
        ),
      },
    });
    expect(recorder.list(job.id, { limit: 20 }).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'plan-gate',
          severity: 'error',
          summary: expect.stringContaining('moduleMining requires moduleBindings'),
          title: 'ModuleMining plan gate failed',
        }),
      ])
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
      moduleBindings: [
        {
          dimensions: ['architecture'],
          moduleId: 'mod-1',
          modulePath: 'src/module-1',
          priority: 1,
          targetRecipes: 2,
        },
      ],
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

  test('counts source-ref-backed persisted moduleMining recipes when the agent result projection reports zero', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const facts = makeProjectMapFacts(2);
    const coverageLedgerRepository = makeCoverageLedgerRepository();
    const persistence = makeModuleMiningPersistenceRepositories();
    persistence.addEntry({ id: 'existing-recipe', lifecycle: 'staging' });
    persistence.addSourceRef({
      recipeId: 'existing-recipe',
      sourcePath: 'src/module-1/existing.ts',
      status: 'active',
    });
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(facts);
    const container = makeContainer(store, {
      coverageLedgerRepository,
      knowledgeRepository: persistence.knowledgeRepository,
      recipeSourceRefRepository: persistence.recipeSourceRefRepository,
    });
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
      scale: { contentMaxLines: 120, maxFiles: 500, totalRecipeBudget: 2 },
    });
    vi.mocked(runModuleMining).mockImplementationOnce(async () => {
      persistence.addEntry({ id: 'accepted-1', lifecycle: 'staging' });
      persistence.addEntry({ id: 'accepted-2', lifecycle: 'staging' });
      persistence.addSourceRef({
        recipeId: 'accepted-1',
        sourcePath: 'src/module-1/index.ts:12',
        status: 'active',
      });
      persistence.addSourceRef({
        recipeId: 'accepted-2',
        sourcePath: 'src/module-2/index.ts#L4-L8',
        status: 'active',
      });
      return { phases: { moduleResults: {} }, status: 'success' };
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
          coverageLedger: expect.objectContaining({
            measuredCells: 2,
            status: 'written',
            writtenCells: 2,
          }),
          newRecipes: 2,
          persistedNewRecipes: 2,
          persistedSourceRefCount: 2,
          reportedNewRecipes: 0,
          selectedModules: [
            expect.objectContaining({
              dimensions: ['architecture'],
              moduleId: 'target:module-1:src/module-1',
              plannedDimensions: ['architecture'],
            }),
            expect.objectContaining({
              dimensions: ['architecture'],
              moduleId: 'target:module-2:src/module-2',
              plannedDimensions: ['architecture'],
            }),
          ],
          sourceRefPaths: ['src/module-1/index.ts', 'src/module-2/index.ts'],
        },
      },
    });
    expect(store.get(job.id)).toMatchObject({ status: 'completed' });
    expect(coverageLedgerRepository.listByProjectRoot(facts.projectRoot)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          coveredCount: 1,
          coveredSourceRefs: ['src/module-1/index.ts'],
          dimensionId: 'architecture',
          grade: 'partial',
          moduleId: 'target:module-1:src/module-1',
        }),
        expect.objectContaining({
          coveredCount: 1,
          coveredSourceRefs: ['src/module-2/index.ts'],
          dimensionId: 'architecture',
          grade: 'partial',
          moduleId: 'target:module-2:src/module-2',
        }),
      ])
    );
  });

  test('still fails true zero-output moduleMining when no new source-ref-backed recipes are persisted', async () => {
    const store = new JobStore({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'job-')) });
    const facts = makeProjectMapFacts(1);
    const persistence = makeModuleMiningPersistenceRepositories();
    persistence.addEntry({ id: 'existing-recipe', lifecycle: 'staging' });
    persistence.addSourceRef({
      recipeId: 'existing-recipe',
      sourcePath: 'src/module-1/existing.ts',
      status: 'active',
    });
    vi.mocked(buildProjectContextWorkflowFacts).mockResolvedValue(facts);
    const container = makeContainer(store, {
      knowledgeRepository: persistence.knowledgeRepository,
      recipeSourceRefRepository: persistence.recipeSourceRefRepository,
    });
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
      moduleBindings: [
        {
          dimensions: ['architecture'],
          moduleId: 'mod-1',
          modulePath: 'src/module-1',
          priority: 1,
          targetRecipes: 2,
        },
      ],
      scale: { contentMaxLines: 120, maxFiles: 500, totalRecipeBudget: 1 },
    });
    vi.mocked(runModuleMining).mockResolvedValueOnce({ phases: { moduleResults: {} } });

    await expect(
      runDaemonJob({
        args: { generationStage: 'moduleMining' },
        container,
        jobId: job.id,
        kind: 'rescan',
        logger,
        source: 'dashboard',
      })
    ).rejects.toThrow('moduleMining produced zero recipes.');
    expect(store.get(job.id)).toMatchObject({
      error: { message: 'moduleMining produced zero recipes.' },
      status: 'failed',
    });
  });
});

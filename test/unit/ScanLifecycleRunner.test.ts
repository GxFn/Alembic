import { describe, expect, test, vi } from 'vitest';
import type { ScanRunRecord } from '../../lib/repository/scan/ScanRunRepository.js';
import type { ProjectSnapshot } from '../../lib/types/project-snapshot.js';
import type { PipelineFillView } from '../../lib/types/snapshot-views.js';
import type { RunBootstrapProjectAnalysisOptions } from '../../lib/workflows/deprecated-cold-start/pipeline/BootstrapProjectAnalysisPipeline.js';
import {
  ScanLifecycleBaselineRequiredError,
  ScanLifecycleRunner,
} from '../../lib/workflows/scan/lifecycle/ScanLifecycleRunner.js';
import type { KnowledgeEvidencePack, ScanPlan } from '../../lib/workflows/scan/ScanTypes.js';

function makeRun(overrides: Partial<ScanRunRecord> = {}): ScanRunRecord {
  return {
    id: 'scan-1',
    projectRoot: '/repo',
    mode: 'incremental-correction',
    depth: 'standard',
    status: 'running',
    reason: 'scan',
    activeDimensions: [],
    scope: {},
    changeSet: null,
    budgets: {},
    summary: {},
    errorMessage: null,
    parentSnapshotId: null,
    baselineSnapshotId: null,
    startedAt: 100,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

function makePack(): KnowledgeEvidencePack {
  return {
    project: { root: '/repo', primaryLang: 'typescript', fileCount: 1, modules: [] },
    changes: {
      files: ['src/api.ts'],
      impactedDimensions: [],
      impactedRecipeIds: ['recipe-1'],
      impactDetails: [],
    },
    files: [],
    knowledge: [],
    graph: { entities: [], edges: [] },
    gaps: [],
    diagnostics: { truncated: false, warnings: [], retrievalMs: 1 },
  };
}

function makeSnapshot(): ProjectSnapshot {
  return {
    projectRoot: '/repo',
    sourceTag: 'rescan-internal',
    isEmpty: false,
    activeDimensions: [{ id: 'architecture', label: 'Architecture', description: '' }],
    allFiles: [
      {
        path: '/repo/src/api.ts',
        relativePath: 'src/api.ts',
        name: 'api.ts',
        language: 'typescript',
        content: 'export const api = 1;',
      },
    ],
    language: { primaryLang: 'typescript', stats: {}, filesByLang: {} },
    incrementalPlan: null,
  } as ProjectSnapshot;
}

function makeContainer(services: Record<string, unknown>) {
  return {
    singletons: { _projectRoot: '/repo' },
    get: (name: string) => services[name],
  };
}

describe('ScanLifecycleRunner', () => {
  test('prepares cold-start baseline through the baseline pipeline contract', async () => {
    const snapshot = makeSnapshot();
    const phaseResults = { report: { ok: true } };
    const coldStartBaselinePipeline = {
      analyzeProject: vi.fn(async () => ({ phaseResults, snapshot })),
    };
    const scanRunRepository = {
      create: vi.fn(() => makeRun({ mode: 'cold-start' })),
    };
    const runner = ScanLifecycleRunner.fromContainer(
      makeContainer({ coldStartBaselinePipeline, scanRunRepository })
    );
    const analysisOptions: RunBootstrapProjectAnalysisOptions = {
      projectRoot: '/repo',
      ctx: {
        container: makeContainer({}),
        logger: { info: vi.fn(), warn: vi.fn() },
      } as RunBootstrapProjectAnalysisOptions['ctx'],
      sourceTag: 'bootstrap',
      phaseOptions: { maxFiles: 10 },
    };

    const prepared = await runner.prepareColdStartBaseline(analysisOptions, {
      enabled: true,
      retrieveEvidence: false,
    });

    expect(prepared.phaseResults).toBe(phaseResults);
    expect(prepared.snapshot).toBe(snapshot);
    expect(prepared.scanContext?.run?.id).toBe('scan-1');
    expect(prepared.scanSummary).toMatchObject({ run: { id: 'scan-1', status: 'running' } });
    expect(coldStartBaselinePipeline.analyzeProject).toHaveBeenCalledWith(analysisOptions);
    expect(scanRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'cold-start', reason: expect.stringContaining('冷启动') })
    );
  });

  test('prepares deep-mining gap-fill context against the baseline', async () => {
    const running = makeRun({ id: 'scan-deep-1', mode: 'deep-mining', depth: 'deep' });
    const completed = makeRun({
      id: 'scan-deep-1',
      mode: 'deep-mining',
      depth: 'deep',
      status: 'completed',
    });
    const knowledgeRetrievalPipeline = { retrieve: vi.fn(async () => makePack()) };
    const scanRunRepository = {
      find: vi.fn(() => [{ id: 'baseline-run-1', baselineSnapshotId: 'snap_1' }]),
      create: vi.fn(() => running),
      complete: vi.fn(() => completed),
    };
    const scanEvidencePackRepository = { create: vi.fn(() => ({ id: 'pack-1' })) };
    const runner = ScanLifecycleRunner.fromContainer(
      makeContainer({ knowledgeRetrievalPipeline, scanRunRepository, scanEvidencePackRepository })
    );

    const prepared = await runner.prepareDeepMiningGapFillContext(makeSnapshot(), {
      dimensions: ['architecture'],
      reason: 'Rescan gap-fill deep mining',
    });
    const boundView = runner.bindScanDimensionFillView(
      { projectRoot: '/repo' } as PipelineFillView,
      prepared.scanContext
    );

    expect(prepared.summary).toMatchObject({
      plan: {
        mode: 'deep-mining',
        baseline: { runId: 'baseline-run-1', snapshotId: 'snap_1' },
      },
      run: { id: 'scan-deep-1', status: 'running' },
    });
    expect(boundView).toMatchObject({
      scanRunId: 'scan-deep-1',
      scanPlan: expect.objectContaining({ mode: 'deep-mining' }),
      scanEvidencePack: expect.objectContaining({
        project: expect.objectContaining({ root: '/repo' }),
      }),
    });
    expect(knowledgeRetrievalPipeline.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'deep-mining',
        intent: 'fill-coverage-gap',
        baseline: { runId: 'baseline-run-1', snapshotId: 'snap_1', source: 'latest-cold-start' },
      })
    );
    expect(scanRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'deep-mining',
        reason: 'Rescan gap-fill deep mining',
        baselineSnapshotId: 'snap_1',
        parentSnapshotId: 'snap_1',
      })
    );
    expect(scanEvidencePackRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'scan-deep-1', packKind: 'deep-mining' })
    );

    const completion = runner.completeDeepMiningBriefingRun(prepared.scanContext, {
      missionBriefing: true,
      totalGap: 2,
    });

    expect(completion.summary).toMatchObject({
      run: { id: 'scan-deep-1', status: 'completed' },
      completion: {
        mode: 'deep-mining',
        executionStatus: 'mission-briefing',
        missionBriefing: true,
        totalGap: 2,
      },
    });
    expect(scanRunRepository.complete).toHaveBeenCalledWith(
      'scan-deep-1',
      expect.objectContaining({
        mode: 'deep-mining',
        executionStatus: 'mission-briefing',
        missionBriefing: true,
        evidence: expect.objectContaining({ fileCount: 0 }),
      })
    );
  });

  test('binds cold-start scan context and projects handler completion', () => {
    const completed = makeRun({ mode: 'cold-start', status: 'completed' });
    const scanRunRepository = { create: vi.fn(), complete: vi.fn(() => completed) };
    const runner = ScanLifecycleRunner.fromContainer(makeContainer({ scanRunRepository }));
    const plan = {
      mode: 'cold-start',
      depth: 'standard',
      reason: 'build baseline',
      activeDimensions: ['architecture'],
      skippedDimensions: [],
      scope: { dimensions: ['architecture'] },
      fallback: null,
      budgets: {
        maxFiles: 10,
        maxKnowledgeItems: 20,
        maxTotalChars: 30_000,
        maxAgentIterations: 30,
      },
    } satisfies ScanPlan;
    const scanContext = {
      plan,
      evidencePack: makePack(),
      evidenceSummary: { fileCount: 1 },
      run: makeRun({ mode: 'cold-start' }),
      evidencePackRecord: null,
    };
    const view = { projectRoot: '/repo' } as PipelineFillView;

    const boundView = runner.bindColdStartFillView(view, scanContext);
    const completion = runner.completeAndProjectColdStartRun(scanContext, {
      missionBriefing: true,
    });

    expect(boundView).toMatchObject({
      scanPlan: plan,
      scanRunId: 'scan-1',
      scanEvidencePack: scanContext.evidencePack,
    });
    expect(scanRunRepository.complete).toHaveBeenCalledWith(
      'scan-1',
      expect.objectContaining({
        mode: 'cold-start',
        baselineRunId: 'scan-1',
        evidence: { fileCount: 1 },
      })
    );
    expect(completion.summary).toMatchObject({ run: { id: 'scan-1', status: 'completed' } });
  });

  test('runs incremental correction through shared tracking and evidence persistence', async () => {
    const running = makeRun();
    const completed = makeRun({ status: 'completed', summary: { needsReview: 1 } });
    const incrementalCorrectionWorkflow = {
      run: vi.fn(async () => ({
        mode: 'incremental-correction' as const,
        reactiveReport: {
          fixed: 0,
          deprecated: 0,
          skipped: 0,
          needsReview: 1,
          suggestReview: true,
          details: [],
        },
        evidencePack: makePack(),
        auditResult: null,
      })),
    };
    const scanRunRepository = {
      create: vi.fn(() => running),
      complete: vi.fn(() => completed),
    };
    const scanEvidencePackRepository = { create: vi.fn(() => ({ id: 'pack-1' })) };
    const runner = ScanLifecycleRunner.fromContainer(
      makeContainer({
        incrementalCorrectionWorkflow,
        scanRunRepository,
        scanEvidencePackRepository,
      })
    );

    const result = await runner.runIncrementalCorrection(
      {
        projectRoot: '/repo',
        events: [{ type: 'modified', path: 'src/api.ts', eventSource: 'ide-edit' }],
        runAgent: false,
      },
      { reason: 'HTTP file changes incremental scan' }
    );

    expect(result.run).toBe(completed);
    expect(result.recommendations).toEqual([]);
    expect(scanRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'incremental-correction',
        reason: 'HTTP file changes incremental scan',
        scope: { files: ['src/api.ts'] },
      })
    );
    expect(incrementalCorrectionWorkflow.run).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: '/repo', runAgent: false })
    );
    expect(scanRunRepository.complete).toHaveBeenCalledWith(
      'scan-1',
      expect.objectContaining({ needsReview: 1, impactedRecipeCount: 1 })
    );
    expect(scanEvidencePackRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'scan-1', packKind: 'incremental-correction' })
    );
  });

  test('runs incremental correction through the unified lifecycle request', async () => {
    const running = makeRun();
    const completed = makeRun({ status: 'completed', summary: { needsReview: 0 } });
    const incrementalCorrectionWorkflow = {
      run: vi.fn(async () => ({
        mode: 'incremental-correction' as const,
        reactiveReport: {
          fixed: 0,
          deprecated: 0,
          skipped: 0,
          needsReview: 0,
          suggestReview: false,
          details: [],
        },
        evidencePack: makePack(),
        auditResult: null,
      })),
    };
    const runner = ScanLifecycleRunner.fromContainer(
      makeContainer({
        incrementalCorrectionWorkflow,
        scanRunRepository: {
          create: vi.fn(() => running),
          complete: vi.fn(() => completed),
        },
        scanEvidencePackRepository: { create: vi.fn(() => ({ id: 'pack-1' })) },
      })
    );

    const lifecycle = await runner.run({
      projectRoot: '/repo',
      source: 'test',
      requestedMode: 'incremental-correction',
      events: [{ type: 'modified', path: 'src/api.ts' }],
      execution: { runAgent: false, runDeterministic: true },
    });

    expect(lifecycle.plan.mode).toBe('incremental-correction');
    expect(lifecycle.run).toBe(completed);
    expect(lifecycle.evidencePack).toEqual(makePack());
    expect(incrementalCorrectionWorkflow.run).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/repo',
        runAgent: false,
        runDeterministic: true,
      })
    );
  });

  test('requires a cold-start baseline before deep mining', async () => {
    const runner = ScanLifecycleRunner.fromContainer(
      makeContainer({
        deepMiningWorkflow: { run: vi.fn() },
        scanRunRepository: { find: vi.fn(() => []) },
      })
    );

    await expect(
      runner.runDeepMining({ projectRoot: '/repo', query: 'routing' })
    ).rejects.toBeInstanceOf(ScanLifecycleBaselineRequiredError);
  });

  test('runs deep mining against the latest cold-start baseline', async () => {
    const running = makeRun({ mode: 'deep-mining', depth: 'deep' });
    const completed = makeRun({ mode: 'deep-mining', depth: 'deep', status: 'completed' });
    const deepMiningWorkflow = {
      run: vi.fn(async (request: Record<string, unknown>) => ({
        mode: 'deep-mining' as const,
        baseline: request.baseline,
        evidencePack: makePack(),
        scanResult: null,
      })),
    };
    const scanRunRepository = {
      find: vi.fn(() => [{ id: 'baseline-run-1', baselineSnapshotId: 'snap_1' }]),
      create: vi.fn(() => running),
      complete: vi.fn(() => completed),
    };
    const runner = ScanLifecycleRunner.fromContainer(
      makeContainer({
        deepMiningWorkflow,
        scanRunRepository,
        scanEvidencePackRepository: { create: vi.fn(() => ({ id: 'pack-1' })) },
      })
    );

    await runner.runDeepMining({ projectRoot: '/repo', query: 'routing' });

    expect(deepMiningWorkflow.run).toHaveBeenCalledWith(
      expect.objectContaining({
        baselineRunId: 'baseline-run-1',
        baselineSnapshotId: 'snap_1',
        baseline: {
          runId: 'baseline-run-1',
          snapshotId: 'snap_1',
          source: 'latest-cold-start',
        },
      })
    );
    expect(scanRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'deep-mining',
        parentSnapshotId: 'snap_1',
        baselineSnapshotId: 'snap_1',
      })
    );
  });

  test('persists maintenance recommendations after run completion', async () => {
    const running = makeRun({ mode: 'maintenance', depth: 'light' });
    const completed = makeRun({ mode: 'maintenance', depth: 'light', status: 'completed' });
    const maintenanceWorkflow = {
      run: vi.fn(async () => ({
        mode: 'maintenance' as const,
        sourceRefs: { inserted: 0, active: 1, stale: 1, skipped: 0, recipesProcessed: 1 },
        repairedRenames: { renamed: 0, stillStale: 1 },
        proposals: { executed: [], rejected: [], expired: [], skipped: [] },
        decaySignals: 0,
        enhancementSuggestions: 0,
        redundancyFindings: 0,
        indexRefreshed: true,
        recommendedRuns: [
          {
            mode: 'incremental-correction' as const,
            reason: '1 source refs are stale',
            scope: {},
            priority: 'medium' as const,
          },
        ],
        warnings: [],
      })),
    };
    const scanRecommendationRepository = {
      createMany: vi.fn(() => [{ id: 'scanrec-1', status: 'pending' }]),
    };
    const runner = ScanLifecycleRunner.fromContainer(
      makeContainer({
        maintenanceWorkflow,
        scanRunRepository: {
          create: vi.fn(() => running),
          complete: vi.fn(() => completed),
        },
        scanRecommendationRepository,
      })
    );

    const result = await runner.runMaintenance({ projectRoot: '/repo' });

    expect(result.recommendations).toEqual([{ id: 'scanrec-1', status: 'pending' }]);
    expect(scanRecommendationRepository.createMany).toHaveBeenCalledWith([
      expect.objectContaining({
        projectRoot: '/repo',
        sourceRunId: 'scan-1',
        mode: 'incremental-correction',
      }),
    ]);
  });
});

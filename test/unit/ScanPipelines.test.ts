import { describe, expect, test, vi } from 'vitest';
import { DeepMiningWorkflow } from '../../lib/workflows/deep-mining/DeepMiningPipeline.js';
import { IncrementalCorrectionWorkflow } from '../../lib/workflows/incremental-correction/IncrementalCorrectionPipeline.js';
import { MaintenanceWorkflow } from '../../lib/workflows/maintenance/MaintenancePipeline.js';
import { ChangeLens } from '../../lib/workflows/scan/retrieval/ChangeLens.js';
import { CodeEntityLens } from '../../lib/workflows/scan/retrieval/CodeEntityLens.js';
import { KnowledgeRetrievalPipeline } from '../../lib/workflows/scan/retrieval/KnowledgeRetrievalPipeline.js';
import { ProjectSnapshotLens } from '../../lib/workflows/scan/retrieval/ProjectSnapshotLens.js';
import { ScanPlanService } from '../../lib/workflows/scan/ScanPlanService.js';
import type { KnowledgeEvidencePack } from '../../lib/workflows/scan/ScanTypes.js';

function emptyEvidencePack(): KnowledgeEvidencePack {
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

describe('ScanPlanService', () => {
  test('wraps incremental bootstrap as a cold-start plan with skipped dimensions', () => {
    const incrementalPlanner = {
      evaluate: vi.fn(() => ({
        canIncremental: true,
        mode: 'incremental' as const,
        affectedDimensions: ['networking'],
        skippedDimensions: ['ui'],
        reason: '1 dimension affected',
        previousSnapshot: { id: 'snap_1' },
        diff: { changeRatio: 0.1 },
      })),
    };
    const service = new ScanPlanService({ incrementalPlanner });

    const plan = service.plan({
      projectRoot: '/repo',
      intent: 'bootstrap',
      currentFiles: [{ relativePath: 'src/api.ts' }],
      allDimensionIds: ['networking', 'ui'],
    });

    expect(plan.mode).toBe('cold-start');
    expect(plan.activeDimensions).toEqual(['networking']);
    expect(plan.skippedDimensions).toEqual(['ui']);
    expect(plan.reason).toContain('增量冷启动');
    expect(plan.rawIncrementalPlan).toBeTruthy();
  });

  test('reuses precomputed bootstrap incremental plans without evaluating again', () => {
    const incrementalPlanner = {
      evaluate: vi.fn(() => {
        throw new Error('should not evaluate twice');
      }),
    };
    const service = new ScanPlanService({ incrementalPlanner });

    const plan = service.plan({
      projectRoot: '/repo',
      intent: 'bootstrap',
      allDimensionIds: ['networking', 'ui', 'architecture'],
      dimensions: ['networking', 'ui'],
      precomputedIncrementalPlan: {
        canIncremental: true,
        mode: 'incremental',
        affectedDimensions: ['networking', 'architecture'],
        skippedDimensions: ['ui'],
        reason: 'Phase 1-4 already evaluated changes',
      },
    });

    expect(incrementalPlanner.evaluate).not.toHaveBeenCalled();
    expect(plan.mode).toBe('cold-start');
    expect(plan.activeDimensions).toEqual(['networking']);
    expect(plan.skippedDimensions).toEqual(['ui']);
    expect(plan.reason).toContain('增量冷启动');
  });

  test('selects incremental correction for small source-ref impacts', () => {
    const service = new ScanPlanService();
    const plan = service.plan({
      projectRoot: '/repo',
      hasBaseline: true,
      totalFileCount: 100,
      changeSet: {
        added: [],
        modified: ['src/api.ts'],
        deleted: [],
      },
      impactedRecipeIds: ['recipe-1'],
      dimensions: ['networking'],
    });

    expect(plan.mode).toBe('incremental-correction');
    expect(plan.scope.recipeIds).toEqual(['recipe-1']);
    expect(plan.activeDimensions).toEqual(['networking']);
  });

  test('upgrades large changes to deep mining with cold-start fallback', () => {
    const service = new ScanPlanService({ fullRebuildThreshold: 0.5 });
    const plan = service.plan({
      projectRoot: '/repo',
      hasBaseline: true,
      totalFileCount: 10,
      changeSet: {
        added: ['a.ts', 'b.ts'],
        modified: ['c.ts', 'd.ts', 'e.ts', 'f.ts'],
        deleted: [],
      },
      dimensions: ['architecture'],
    });

    expect(plan.mode).toBe('deep-mining');
    expect(plan.fallback).toBe('cold-start');
    expect(plan.reason).toContain('超过阈值');
  });

  test('falls back to cold-start when deep mining has no baseline', () => {
    const service = new ScanPlanService();

    const plan = service.plan({
      projectRoot: '/repo',
      intent: 'deep-mining',
      hasBaseline: false,
      dimensions: ['architecture'],
    });

    expect(plan.mode).toBe('cold-start');
    expect(plan.reason).toContain('无 baseline');
  });

  test('keeps requested deep mining attached to a baseline anchor', () => {
    const service = new ScanPlanService();

    const plan = service.plan({
      projectRoot: '/repo',
      intent: 'deep-mining',
      hasBaseline: true,
      baselineRunId: 'baseline-run-1',
      baselineSnapshotId: 'snap_baseline_1',
      dimensions: ['architecture'],
    });

    expect(plan.mode).toBe('deep-mining');
    expect(plan.baseline).toEqual({
      runId: 'baseline-run-1',
      snapshotId: 'snap_baseline_1',
      source: 'request',
    });
  });
});

describe('DeepMiningWorkflow', () => {
  test('passes the baseline anchor into retrieval and result projection', async () => {
    const retrievalPipeline = {
      retrieve: vi.fn(async () => emptyEvidencePack()),
    };
    const workflow = new DeepMiningWorkflow({
      retrievalPipeline: retrievalPipeline as unknown as ConstructorParameters<
        typeof DeepMiningWorkflow
      >[0]['retrievalPipeline'],
    });

    const result = await workflow.run({
      projectRoot: '/repo',
      baselineRunId: 'baseline-run-1',
      baselineSnapshotId: 'snap_baseline_1',
      query: 'routing',
      runAgent: false,
    });

    expect(retrievalPipeline.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'deep-mining',
        baseline: {
          runId: 'baseline-run-1',
          snapshotId: 'snap_baseline_1',
          source: 'request',
        },
      })
    );
    expect(result.baseline).toEqual({
      runId: 'baseline-run-1',
      snapshotId: 'snap_baseline_1',
      source: 'request',
    });
  });
});

describe('KnowledgeRetrievalPipeline', () => {
  test('builds an evidence pack from source refs, search results and graph edges', async () => {
    const sourceRefRepository = {
      findBySourcePath: vi.fn((sourcePath: string) =>
        sourcePath === 'src/api.ts'
          ? [{ recipeId: 'recipe-1', sourcePath: 'src/api.ts', status: 'active' }]
          : []
      ),
      findByRecipeId: vi.fn((recipeId: string) => [
        { recipeId, sourcePath: recipeId === 'recipe-1' ? 'src/api.ts' : 'src/search.ts' },
      ]),
      findStale: vi.fn(() => []),
    };
    const knowledgeRepository = {
      findById: vi.fn(async (recipeId: string) => ({
        toJSON: () => ({
          id: recipeId,
          title: `Recipe ${recipeId}`,
          trigger: `@${recipeId}`,
          lifecycle: 'active',
          content: { markdown: `markdown for ${recipeId}`, coreCode: 'const value = 1;' },
        }),
      })),
    };
    const searchEngine = {
      ensureIndex: vi.fn(),
      search: vi.fn(async () => ({
        items: [
          {
            id: 'recipe-search',
            title: 'Search Recipe',
            status: 'active',
            score: 0.9,
            sourceRefs: ['src/search.ts'],
          },
        ],
        total: 1,
        query: 'api',
      })),
    };
    const knowledgeGraphService = {
      getEdges: vi.fn(async () => ({
        outgoing: [{ fromId: 'recipe-1', toId: 'recipe-search', relation: 'depends_on' }],
        incoming: [],
      })),
      getImpactAnalysis: vi.fn(async () => []),
    };
    const codeEntityGraph = {
      searchEntities: vi.fn(async (query: string) =>
        query === 'api'
          ? [
              {
                entityId: 'ApiClient',
                entityType: 'class',
                name: 'ApiClient',
                filePath: 'src/api.ts',
              },
            ]
          : []
      ),
      getEntityEdges: vi.fn(async () => ({
        outgoing: [
          {
            fromId: 'ApiClient',
            fromType: 'class',
            toId: 'NetworkClient',
            toType: 'class',
            relation: 'depends_on',
          },
        ],
        incoming: [],
      })),
    };
    const pipeline = new KnowledgeRetrievalPipeline({
      projectRoot: '/repo',
      sourceRefRepository,
      knowledgeRepository,
      searchEngine,
      knowledgeGraphService,
      codeEntityGraph,
      now: () => 100,
    });

    const pack = await pipeline.retrieve({
      projectRoot: '/repo',
      mode: 'incremental-correction',
      intent: 'audit-impacted-recipes',
      scope: { dimensions: ['networking'], query: 'api' },
      changeSet: {
        added: [],
        modified: ['src/api.ts'],
        deleted: [],
      },
      reports: {
        reactive: {
          fixed: 0,
          deprecated: 0,
          skipped: 0,
          needsReview: 1,
          suggestReview: true,
          details: [
            {
              recipeId: 'recipe-1',
              recipeTitle: 'Recipe recipe-1',
              action: 'needs-review',
              reason: 'pattern changed',
              impactLevel: 'pattern',
              modifiedPath: 'src/api.ts',
            },
          ],
        },
      },
    });

    expect(pack.changes?.impactedRecipeIds).toContain('recipe-1');
    expect(pack.knowledge.map((item) => item.id)).toEqual(['recipe-search', 'recipe-1']);
    expect(pack.graph.edges).toContainEqual({
      from: 'recipe-1',
      to: 'recipe-search',
      relation: 'depends_on',
    });
    expect(pack.graph.entities).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'ApiClient', kind: 'class' })])
    );
    expect(pack.graph.edges).toContainEqual({
      from: 'ApiClient',
      to: 'NetworkClient',
      relation: 'depends_on',
    });
    expect(pack.files).toContainEqual({
      relativePath: 'src/api.ts',
      language: 'typescript',
      role: 'changed',
    });
  });
});

describe('retrieval lenses', () => {
  test('ChangeLens combines reactive details, source refs and stale refs', () => {
    const sourceRefRepository = {
      findBySourcePath: vi.fn((sourcePath: string) =>
        sourcePath === 'src/api.ts' ? [{ recipeId: 'recipe-source', sourcePath: 'src/api.ts' }] : []
      ),
      findStale: vi.fn(() => [{ recipeId: 'recipe-stale', sourcePath: 'src/old.ts' }]),
    };
    const lens = new ChangeLens({ sourceRefRepository });

    const result = lens.collect(
      {
        projectRoot: '/repo',
        mode: 'maintenance',
        intent: 'maintain-health',
        scope: { recipeIds: ['recipe-scope'] },
        changeSet: { added: [], modified: ['src/api.ts'], deleted: [] },
        reports: {
          reactive: {
            fixed: 0,
            deprecated: 0,
            skipped: 0,
            needsReview: 1,
            suggestReview: true,
            details: [
              {
                recipeId: 'recipe-reactive',
                recipeTitle: 'Reactive Recipe',
                action: 'needs-review',
                reason: 'changed',
                impactLevel: 'pattern',
                modifiedPath: 'src/api.ts',
              },
            ],
          },
        },
      },
      { added: [], modified: ['src/api.ts'], deleted: [] }
    );

    expect(result.changedFiles).toEqual(['src/api.ts']);
    expect(result.impactedRecipeIds).toEqual([
      'recipe-scope',
      'recipe-reactive',
      'recipe-source',
      'recipe-stale',
    ]);
    expect(result.impactDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipeId: 'recipe-reactive', level: 'pattern' }),
        expect.objectContaining({ recipeId: 'recipe-source', level: 'reference' }),
      ])
    );
  });

  test('CodeEntityLens projects entity, dependency and call graph evidence', async () => {
    const codeEntityGraph = {
      searchEntities: vi.fn(async (query: string) =>
        query === 'UserService'
          ? [
              {
                entityId: 'UserService.loadUser',
                entityType: 'method',
                name: 'loadUser',
                filePath: 'src/UserService.ts',
              },
            ]
          : []
      ),
      getEntityEdges: vi.fn(async () => ({
        outgoing: [
          {
            fromId: 'UserService.loadUser',
            fromType: 'method',
            toId: 'ApiClient.request',
            toType: 'method',
            relation: 'calls',
          },
        ],
        incoming: [
          {
            fromId: 'UserViewModel.refresh',
            fromType: 'method',
            toId: 'UserService.loadUser',
            toType: 'method',
            relation: 'calls',
          },
        ],
      })),
      getCallers: vi.fn(async () => [
        { caller: 'UserViewModel.refresh', depth: 1, callType: 'direct' },
      ]),
      getCallees: vi.fn(async () => [
        { callee: 'ApiClient.request', depth: 1, callType: 'direct' },
      ]),
    };
    const warnings: string[] = [];
    const lens = new CodeEntityLens({ codeEntityGraph });

    const graph = await lens.collect(
      {
        projectRoot: '/repo',
        mode: 'incremental-correction',
        intent: 'audit-impacted-recipes',
        scope: { symbols: ['UserService'] },
      },
      { changedFiles: [], warnings }
    );

    expect(warnings).toEqual([]);
    expect(codeEntityGraph.searchEntities).toHaveBeenCalledWith('UserService', { limit: 6 });
    expect(graph.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'UserService.loadUser', kind: 'method' }),
        expect.objectContaining({ id: 'ApiClient.request', kind: 'method' }),
        expect.objectContaining({ id: 'UserViewModel.refresh', kind: 'method' }),
      ])
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: 'UserService.loadUser', to: 'ApiClient.request', relation: 'calls' },
        { from: 'UserViewModel.refresh', to: 'UserService.loadUser', relation: 'calls' },
      ])
    );
  });

  test('ProjectSnapshotLens projects changed files and coverage gaps', () => {
    const lens = new ProjectSnapshotLens({ projectRoot: '/repo' });
    const files = lens.files(
      {
        projectRoot: '/repo',
        mode: 'deep-mining',
        intent: 'fill-coverage-gap',
        scope: { dimensions: ['architecture'] },
        files: [{ relativePath: 'src/api.ts', content: 'export const value = 1;' }],
      },
      ['src/api.ts', 'src/new.ts']
    );

    expect(files).toEqual([
      expect.objectContaining({ relativePath: 'src/api.ts', role: 'changed' }),
      expect.objectContaining({ relativePath: 'src/new.ts', role: 'changed' }),
    ]);
    expect(
      lens.project(
        { projectRoot: '/repo', mode: 'deep-mining', intent: 'fill-coverage-gap' },
        files
      )
    ).toEqual(expect.objectContaining({ primaryLang: 'typescript', fileCount: 2 }));
    expect(
      lens.gaps(
        {
          projectRoot: '/repo',
          mode: 'deep-mining',
          intent: 'fill-coverage-gap',
          scope: { dimensions: ['architecture'] },
        },
        { added: ['src/new.ts'], modified: [], deleted: [] },
        [],
        []
      )
    ).toEqual([
      { dimension: 'architecture', reason: 'low-coverage', priority: 'medium' },
      { dimension: 'architecture', reason: 'new-module', priority: 'high' },
    ]);
  });
});

describe('IncrementalCorrectionWorkflow', () => {
  test('uses a precomputed reactive report without dispatching events again', async () => {
    const fileChangeDispatcher = {
      dispatch: vi.fn(async () => ({
        fixed: 0,
        deprecated: 0,
        skipped: 0,
        needsReview: 0,
        suggestReview: false,
        details: [],
      })),
    };
    const retrievalPipeline = {
      retrieve: vi.fn(async () => emptyEvidencePack()),
    };
    const workflow = new IncrementalCorrectionWorkflow({
      fileChangeDispatcher: fileChangeDispatcher as unknown as ConstructorParameters<
        typeof IncrementalCorrectionWorkflow
      >[0]['fileChangeDispatcher'],
      retrievalPipeline: retrievalPipeline as unknown as ConstructorParameters<
        typeof IncrementalCorrectionWorkflow
      >[0]['retrievalPipeline'],
    });
    const reactiveReport = {
      fixed: 0,
      deprecated: 0,
      skipped: 0,
      needsReview: 1,
      suggestReview: true,
      details: [
        {
          recipeId: 'recipe-1',
          recipeTitle: 'Recipe 1',
          action: 'needs-review' as const,
          reason: 'pattern changed',
          impactLevel: 'pattern' as const,
          modifiedPath: 'src/api.ts',
        },
      ],
    };

    const result = await workflow.run({
      projectRoot: '/repo',
      events: [{ type: 'modified', path: 'src/api.ts', eventSource: 'ide-edit' }],
      reactiveReport,
      runDeterministic: false,
      runAgent: false,
    });

    expect(fileChangeDispatcher.dispatch).not.toHaveBeenCalled();
    expect(result.reactiveReport).toMatchObject({ needsReview: 1, eventSource: 'ide-edit' });
    expect(retrievalPipeline.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ reports: { reactive: result.reactiveReport } })
    );
  });
});

describe('MaintenanceWorkflow', () => {
  test('runs lightweight maintenance and leaves redundancy disabled by default', async () => {
    const sourceRefReconciler = {
      reconcile: vi.fn(async () => ({
        inserted: 0,
        active: 2,
        stale: 1,
        skipped: 0,
        recipesProcessed: 2,
      })),
      repairRenames: vi.fn(async () => ({ renamed: 0, stillStale: 1 })),
    };
    const proposalExecutor = {
      checkAndExecute: vi.fn(async () => ({
        executed: [],
        rejected: [],
        expired: [],
        skipped: [],
      })),
    };
    const searchEngine = { refreshIndex: vi.fn() };
    const decayDetector = { scanAll: vi.fn(async () => [{ recipeId: 'recipe-1' }]) };
    const enhancementSuggester = { analyzeAll: vi.fn(async () => [{ recipeId: 'recipe-2' }]) };
    const redundancyAnalyzer = { analyzeAll: vi.fn(async () => [{ recipeA: 'a', recipeB: 'b' }]) };
    const workflow = new MaintenanceWorkflow({
      sourceRefReconciler,
      proposalExecutor,
      searchEngine,
      decayDetector,
      enhancementSuggester,
      redundancyAnalyzer,
    });

    const result = await workflow.run({ projectRoot: '/repo' });

    expect(result.sourceRefs.stale).toBe(1);
    expect(result.decaySignals).toBe(1);
    expect(result.enhancementSuggestions).toBe(1);
    expect(result.redundancyFindings).toBe(0);
    expect(result.recommendedRuns.map((run) => run.mode)).toEqual([
      'incremental-correction',
      'deep-mining',
    ]);
    expect(searchEngine.refreshIndex).toHaveBeenCalledTimes(1);
    expect(redundancyAnalyzer.analyzeAll).not.toHaveBeenCalled();
  });
});

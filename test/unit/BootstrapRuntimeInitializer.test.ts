import { describe, expect, test, vi } from 'vitest';
import type { IncrementalPlan } from '../../lib/service/handler-runtime/types.js';
import {
  type BootstrapRuntimeContainer,
  initializeBootstrapRuntime,
} from '../../lib/workflows/ai-execution/RuntimeInitializer.js';

function makeContainer(
  overrides: Partial<BootstrapRuntimeContainer> = {}
): BootstrapRuntimeContainer {
  return {
    get: vi.fn(() => null),
    singletons: {},
    ...overrides,
  };
}

function makeIncrementalPlan(
  restoredEpisodic: NonNullable<IncrementalPlan['restoredEpisodic']>
): IncrementalPlan {
  return {
    canIncremental: true,
    mode: 'incremental',
    affectedDimensions: [],
    skippedDimensions: ['api'],
    previousSnapshot: null,
    diff: null,
    reason: 'test',
    restoredEpisodic,
  };
}

describe('initializeBootstrapRuntime', () => {
  test('initializes project info, runtime stores and memory coordinator without legacy graph', async () => {
    const legacyGraphBuilder = vi.fn(async () => ({
      getOverview: vi.fn(() => ({ totalClasses: 2, totalProtocols: 1, buildTimeMs: 10 })),
    }));
    const container = makeContainer();
    (container as BootstrapRuntimeContainer & { buildProjectGraph?: unknown }).buildProjectGraph =
      legacyGraphBuilder;

    const runtime = await initializeBootstrapRuntime({
      container,
      projectRoot: '/repo/Alembic',
      dataRoot: '/data',
      primaryLang: 'ts',
      allFiles: [{ relativePath: 'a.ts' }],
      targetFileMap: { api: {} },
      depGraphData: { nodes: [] },
      astProjectSummary: { projectMetrics: { classes: 2 } },
      guardAudit: { summary: { violations: 0 } },
      isIncremental: false,
      incrementalPlan: null,
    });

    expect(container.singletons._fileCache).toEqual([{ relativePath: 'a.ts' }]);
    expect(legacyGraphBuilder).not.toHaveBeenCalled();
    expect(runtime.projectGraph).toBeNull();
    expect(runtime.projectInfo).toEqual({ name: 'Alembic', lang: 'ts', fileCount: 1 });
    expect(runtime.dimContext.projectContext).toMatchObject({
      projectName: 'Alembic',
      primaryLang: 'ts',
      fileCount: 1,
      targetCount: 1,
      modules: ['api'],
    });
    expect(runtime.sessionStore.getStats()).toMatchObject({ completedDimensions: 0 });
    expect(runtime.semanticMemory).toBeNull();
    expect(runtime.codeEntityGraphInst).toBeNull();
    expect(runtime.memoryCoordinator).toBeTruthy();
  });

  test('rehydrates restored incremental memory and syncs digests into DimensionContext', async () => {
    const restoredEpisodic = {
      getCompletedDimensions: () => ['api'],
      getDimensionReport: () => ({ referencedFiles: ['src/api.ts'] }),
      toJSON: () => ({
        dimensionReports: {
          api: {
            dimId: 'api',
            completedAt: Date.now(),
            analysisText: 'restored',
            findings: [],
            referencedFiles: ['src/api.ts'],
            candidatesSummary: [],
            workingMemoryDistilled: null,
            digest: { summary: 'restored api' },
          },
        },
        crossReferences: [],
        tierReflections: [],
        submittedCandidates: {},
        projectContext: {},
      }),
    };

    const runtime = await initializeBootstrapRuntime({
      container: makeContainer(),
      projectRoot: '/repo/Alembic',
      dataRoot: '/data',
      primaryLang: 'ts',
      allFiles: [],
      targetFileMap: {},
      isIncremental: true,
      incrementalPlan: makeIncrementalPlan(restoredEpisodic),
    });

    expect(runtime.sessionStore.getCompletedDimensions()).toEqual(['api']);
    expect(runtime.dimContext.completedDimensions.get('api')).toMatchObject({
      summary: 'restored api',
      dimId: 'api',
    });
  });

  test('keeps legacy graph failures out of runtime initialization', async () => {
    const legacyGraphBuilder = vi.fn(async () => {
      throw new Error('graph failed');
    });
    const container = makeContainer();
    (container as BootstrapRuntimeContainer & { buildProjectGraph?: unknown }).buildProjectGraph =
      legacyGraphBuilder;
    const runtime = await initializeBootstrapRuntime({
      container,
      projectRoot: '/repo/Alembic',
      dataRoot: '/data',
      primaryLang: null,
      allFiles: null,
      targetFileMap: null,
    });

    expect(legacyGraphBuilder).not.toHaveBeenCalled();
    expect(runtime.projectGraph).toBeNull();
    expect(runtime.projectInfo).toEqual({ name: 'Alembic', lang: 'unknown', fileCount: 0 });
  });
});

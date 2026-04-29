import { describe, expect, test, vi } from 'vitest';
import {
  type BootstrapRuntimeContainer,
  initializeBootstrapRuntime,
} from '#workflows/capabilities/execution/internal-agent/context/BootstrapRuntimeInitializer.js';
import type { SessionStore } from '../../lib/agent/memory/SessionStore.js';
import type { IncrementalPlan } from '../../lib/external/mcp/handlers/types.js';

function makeContainer(
  overrides: Partial<BootstrapRuntimeContainer> = {}
): BootstrapRuntimeContainer {
  return {
    get: vi.fn(() => null),
    singletons: {},
    ...overrides,
  };
}

function makeIncrementalPlan(restoredEpisodic: SessionStore): IncrementalPlan {
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
  test('builds project graph, project info, runtime stores and memory coordinator', async () => {
    const projectGraph = {
      getOverview: vi.fn(() => ({ totalClasses: 2, totalProtocols: 1, buildTimeMs: 10 })),
    };
    const container = makeContainer({
      buildProjectGraph: vi.fn(async () => projectGraph),
    });

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
    expect(runtime.projectGraph).toBe(projectGraph);
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

  test('uses restored incremental SessionStore and syncs digests into DimensionContext', async () => {
    const restoredEpisodic = {
      getCompletedDimensions: () => ['api'],
      getDimensionReport: () => ({ digest: { summary: 'restored api' } }),
    } as unknown as SessionStore;

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

    expect(runtime.sessionStore).toBe(restoredEpisodic);
    expect(runtime.dimContext.completedDimensions.get('api')).toMatchObject({
      summary: 'restored api',
      dimId: 'api',
    });
  });

  test('continues when ProjectGraph creation fails', async () => {
    const runtime = await initializeBootstrapRuntime({
      container: makeContainer({
        buildProjectGraph: vi.fn(async () => {
          throw new Error('graph failed');
        }),
      }),
      projectRoot: '/repo/Alembic',
      dataRoot: '/data',
      primaryLang: null,
      allFiles: null,
      targetFileMap: null,
    });

    expect(runtime.projectGraph).toBeNull();
    expect(runtime.projectInfo).toEqual({ name: 'Alembic', lang: 'unknown', fileCount: 0 });
  });
});

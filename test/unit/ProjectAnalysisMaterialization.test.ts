import { describe, expect, test, vi } from 'vitest';
import {
  buildEntityGraphInput,
  materializeCallGraph,
  resolveProjectAnalysisMaterialization,
  runPhase1_7_CallGraph,
  runPhase2_DependencyGraph,
} from '#workflows/common-capabilities/project-analysis/ProjectAnalysisRunner.js';

describe('ProjectAnalysis materialization plan', () => {
  test('defaults to all current side effects enabled', () => {
    expect(resolveProjectAnalysisMaterialization(undefined)).toEqual({
      codeEntityGraph: true,
      callGraph: true,
      dependencyEdges: true,
      moduleEntities: true,
      guardViolations: true,
      panorama: true,
    });
  });

  test('can disable all materialization side effects', () => {
    expect(resolveProjectAnalysisMaterialization(false)).toEqual({
      codeEntityGraph: false,
      callGraph: false,
      dependencyEdges: false,
      moduleEntities: false,
      guardViolations: false,
      panorama: false,
    });
  });

  test('keeps defaults for unspecified materialization options', () => {
    expect(resolveProjectAnalysisMaterialization({ dependencyEdges: false })).toMatchObject({
      codeEntityGraph: true,
      dependencyEdges: false,
      panorama: true,
    });
  });

  test('builds entity graph input without touching repositories', () => {
    const astProjectSummary = { classes: [], protocols: [], fileSummaries: [] };

    expect(buildEntityGraphInput(null, '/project')).toBeNull();
    expect(buildEntityGraphInput(astProjectSummary, '/project')).toEqual({
      astProjectSummary,
      projectRoot: '/project',
    });
  });

  test('can analyze call graph without materializing code entity graph', async () => {
    const container = { get: vi.fn() };
    const logger = createLogger();

    const result = await runPhase1_7_CallGraph(
      createAstSummaryWithCallSite(),
      '/project',
      container,
      logger,
      { materialize: false }
    );

    expect(result.callGraphAnalysis?.callEdges).toHaveLength(1);
    expect(result.callGraphAnalysis?.dataFlowEdges).toHaveLength(1);
    expect(result.callGraphResult).toBeNull();
    expect(container.get).not.toHaveBeenCalled();
  });

  test('materializes call graph only when requested', async () => {
    const clearCallGraphForFiles = vi.fn().mockResolvedValue({ deletedEdges: 1 });
    const populateCallGraph = vi
      .fn()
      .mockResolvedValue({ entitiesUpserted: 2, edgesCreated: 1, durationMs: 4 });
    const getCodeEntityGraphClass = vi.fn().mockResolvedValue(
      class FakeCodeEntityGraph {
        clearCallGraphForFiles = clearCallGraphForFiles;
        populateCallGraph = populateCallGraph;
      }
    );
    const container = {
      get: vi.fn((name: string) =>
        name === 'codeEntityRepository' || name === 'knowledgeEdgeRepository' ? {} : undefined
      ),
    };
    const logger = createLogger();
    const callGraphAnalysis = createCallGraphAnalysis({ incremental: true });

    const result = await materializeCallGraph({
      callGraphAnalysis,
      projectRoot: '/project',
      container,
      logger,
      changedFiles: ['src/service/UserService.ts'],
      getCodeEntityGraphClass,
    });

    expect(getCodeEntityGraphClass).toHaveBeenCalledOnce();
    expect(clearCallGraphForFiles).toHaveBeenCalledWith(['src/service/UserService.ts']);
    expect(populateCallGraph).toHaveBeenCalledWith(
      callGraphAnalysis.callEdges,
      callGraphAnalysis.dataFlowEdges
    );
    expect(result.callGraphResult).toEqual({ entitiesUpserted: 2, edgesCreated: 1, durationMs: 4 });
  });

  test('can collect dependency graph without writing knowledge edges', async () => {
    const addEdge = vi.fn().mockResolvedValue({ success: true });
    const discoverer = createDiscoverer();
    const container = {
      get: vi.fn((name: string) => (name === 'knowledgeGraphService' ? { addEdge } : undefined)),
    };
    const logger = createLogger();

    const result = await runPhase2_DependencyGraph(discoverer, container, logger, 'rescan', {
      materializeEdges: false,
    });

    expect(result.depGraphData?.edges).toHaveLength(1);
    expect(result.depEdgesWritten).toBe(0);
    expect(addEdge).not.toHaveBeenCalled();
  });

  test('writes dependency edges when materialization is enabled', async () => {
    const addEdge = vi.fn().mockResolvedValue({ success: true });
    const discoverer = createDiscoverer();
    const container = {
      get: vi.fn((name: string) => (name === 'knowledgeGraphService' ? { addEdge } : undefined)),
    };
    const logger = createLogger();

    const result = await runPhase2_DependencyGraph(discoverer, container, logger, 'rescan');

    expect(result.depEdgesWritten).toBe(1);
    expect(addEdge).toHaveBeenCalledWith('app', 'module', 'core', 'module', 'depends_on', {
      weight: 1.0,
      source: 'demo-rescan',
    });
  });
});

function createDiscoverer() {
  return {
    id: 'demo',
    displayName: 'Demo',
    load: vi.fn(),
    listTargets: vi.fn(),
    getTargetFiles: vi.fn(),
    getDependencyGraph: vi.fn().mockResolvedValue({
      nodes: [{ id: 'app' }, { id: 'core' }],
      edges: [{ from: 'app', to: 'core' }],
    }),
  };
}

function createAstSummaryWithCallSite(): Parameters<typeof runPhase1_7_CallGraph>[0] {
  return {
    lang: 'typescript',
    fileCount: 1,
    classes: [{ name: 'UserService', kind: 'class', line: 1 }],
    protocols: [],
    categories: [],
    inheritanceGraph: [],
    patternStats: {},
    projectMetrics: {},
    fileSummaries: [
      {
        file: 'src/service/UserService.ts',
        classes: [{ name: 'UserService', kind: 'class', line: 1 }],
        protocols: [],
        methods: [
          { name: 'getUser', className: 'UserService', line: 5, kind: 'definition' },
          { name: 'listUsers', className: 'UserService', line: 15, kind: 'definition' },
        ],
        imports: [],
        exports: [],
        callSites: [
          {
            callee: 'listUsers',
            callerMethod: 'getUser',
            callerClass: 'UserService',
            callType: 'method',
            receiver: 'this',
            receiverType: 'UserService',
            argCount: 0,
            line: 8,
            isAwait: false,
          },
        ],
      },
    ],
  } as Parameters<typeof runPhase1_7_CallGraph>[0];
}

function createCallGraphAnalysis({ incremental }: { incremental: boolean }) {
  return {
    callEdges: [
      {
        caller: 'src/service/UserService.ts::UserService.getUser',
        callee: 'src/service/UserService.ts::UserService.listUsers',
        callType: 'method',
        resolveMethod: 'direct',
        line: 8,
        file: 'src/service/UserService.ts',
        isAwait: false,
        argCount: 0,
      },
    ],
    dataFlowEdges: [],
    stats: {
      totalCallSites: 1,
      resolvedCallSites: 1,
      resolvedRate: 1,
      totalEdges: 1,
      filesProcessed: 1,
      symbolCount: 2,
      durationMs: 3,
      incremental,
    },
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

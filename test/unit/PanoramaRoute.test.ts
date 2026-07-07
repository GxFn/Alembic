import type { CoverageLedgerRecord } from '@alembic/core/repositories';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => ({
  analysisScope: null as unknown,
  container: {
    get: vi.fn(),
  },
  coverageLedgerRepository: {
    listByProjectRoot: vi.fn(),
  },
  facts: null as unknown,
  knowledgeRepository: {
    countByLifecycles: vi.fn(),
  },
}));

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

vi.mock('../../lib/project-scope/ProjectScopeAnalysis.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../lib/project-scope/ProjectScopeAnalysis.js')>();
  return {
    ...actual,
    resolveProjectScopeAnalysisContext: vi.fn(() => mocks.analysisScope),
  };
});

vi.mock('../../lib/project-facts/ProjectContextWorkflowFacts.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../lib/project-facts/ProjectContextWorkflowFacts.js')>();
  return {
    ...actual,
    buildProjectContextWorkflowFacts: vi.fn(() => Promise.resolve(mocks.facts)),
  };
});

import panoramaRouter from '../../lib/http/routes/panorama.js';
import { buildProjectContextWorkflowFacts } from '../../lib/project-facts/ProjectContextWorkflowFacts.js';
import type { ProjectScopeAnalysisContext } from '../../lib/project-scope/ProjectScopeAnalysis.js';

describe('panorama HTTP routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.analysisScope = projectScopeAnalysis('/tmp/AlembicWorkspace', ['Alembic']);
    mocks.facts = {
      fileCount: 12,
      moduleCount: 1,
      presenterInput: {
        map: {
          dependencySummary: { edgeCount: 1 },
          cycles: [],
        },
      },
      projectMapModules: [
        {
          moduleId: 'target:Alembic:Alembic',
          moduleName: 'Alembic',
          modulePath: 'Alembic',
          ownedFileCount: 12,
          role: 'source',
        },
      ],
      projectRoot: '/tmp/AlembicWorkspace',
    };
    mocks.coverageLedgerRepository.listByProjectRoot.mockReturnValue([
      cell({
        projectRoot: '/tmp/AlembicWorkspace/Alembic',
        moduleId: 'target:Alembic:Alembic',
        dimensionId: 'architecture',
        coveredCount: 3,
        totalCandidateCount: 4,
        grade: 'partial',
      }),
    ]);
    mocks.knowledgeRepository.countByLifecycles.mockResolvedValue(5);
    mocks.container.get.mockImplementation((name: string) => {
      if (name === 'coverageLedgerRepository') {
        return mocks.coverageLedgerRepository;
      }
      if (name === 'knowledgeRepository') {
        return mocks.knowledgeRepository;
      }
      throw new Error(`unexpected service ${name}`);
    });
  });

  test('GET /panorama returns the old overview envelope shape from scoped data', async () => {
    const response = await getRouter(panoramaRouter, '/api/v1/panorama?refresh=true', {
      mountPath: '/api/v1/panorama',
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const data = response.body.data as Record<string, unknown>;
    expect(data).toMatchObject({
      moduleCount: 1,
      totalFiles: 12,
      totalRecipes: 5,
      projectRoot: '/tmp/AlembicWorkspace',
    });
    expect(data.layers).toEqual([
      expect.objectContaining({
        modules: [
          expect.objectContaining({
            name: 'Alembic',
            recipeCount: 3,
            recipeCountSource: 'coverage-ledger-direct',
          }),
        ],
      }),
    ]);
    expect(buildProjectContextWorkflowFacts).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisScope: mocks.analysisScope,
        maxFileDetails: 0,
        maxModuleDetails: 0,
        projectRoot: '/tmp/AlembicWorkspace',
        source: 'alembic-main-bootstrap',
      })
    );
    expect(mocks.coverageLedgerRepository.listByProjectRoot).toHaveBeenCalledWith(
      '/tmp/AlembicWorkspace/Alembic'
    );
  });

  test('GET /panorama/health returns derived health fields', async () => {
    const response = await getRouter(panoramaRouter, '/api/v1/panorama/health', {
      mountPath: '/api/v1/panorama',
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({
      avgCoupling: 1,
      cycleCount: 0,
      moduleCount: 1,
    });
    expect((response.body.data as Record<string, unknown>).healthScore).toEqual(expect.any(Number));
  });

  test('GET /panorama/gaps returns the gap array shape', async () => {
    const response = await getRouter(panoramaRouter, '/api/v1/panorama/gaps', {
      mountPath: '/api/v1/panorama',
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: expect.any(String),
          dimensionName: expect.any(String),
          priority: expect.any(String),
          status: expect.any(String),
          suggestedTopics: expect.any(Array),
        }),
      ])
    );
  });
});

function projectScopeAnalysis(
  controlRoot: string,
  folderNames: readonly string[]
): ProjectScopeAnalysisContext {
  return {
    controlRoot,
    currentFolderId: null,
    dataRoot: '/tmp/alembic-data',
    folderCount: folderNames.length,
    projectRoot: controlRoot,
    projectScope: {
      controlRoot: { path: controlRoot },
      currentFolderId: null,
      folders: folderNames.map((name) => ({
        displayName: name,
        id: name,
        path: `${controlRoot}/${name}`,
        role: 'source',
      })),
      projectScopeId: 'scope-route',
    } as NonNullable<ProjectScopeAnalysisContext['projectScope']>,
    projectScopeId: 'scope-route',
  };
}

function cell(overrides: Partial<CoverageLedgerRecord>): CoverageLedgerRecord {
  return {
    projectRoot: '/tmp/project',
    moduleId: 'target:Module:src',
    dimensionId: 'architecture',
    coveredCount: 0,
    totalCandidateCount: 0,
    grade: 'empty',
    exhausted: false,
    exhaustedReason: null,
    exhaustedSource: null,
    coveredSourceRefs: [],
    uncoveredHints: [],
    valueScore: 0,
    lastRound: null,
    deferred: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

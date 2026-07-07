import type { CoverageLedgerRecord } from '@alembic/core/repositories';
import { describe, expect, test } from 'vitest';
import {
  buildPanoramaEndpointView,
  resolvePanoramaCoverageProjectRoots,
} from '../../lib/project-facts/PanoramaEndpointView.js';
import type {
  ProjectContextModule,
  ProjectContextWorkflowFacts,
} from '../../lib/project-facts/ProjectContextWorkflowFacts.js';
import type { ProjectScopeAnalysisContext } from '../../lib/project-scope/ProjectScopeAnalysis.js';

describe('PanoramaEndpointView', () => {
  test('aggregates only ProjectScope members and rejects non-member coverage', () => {
    const workspaceRoot = '/tmp/AlembicWorkspace';
    const analysisScope = projectScopeAnalysis(workspaceRoot, ['Alembic', 'AlembicCore']);
    const view = buildPanoramaEndpointView({
      analysisScope,
      computedAt: 42,
      coverageLedgerCells: [
        cell({
          projectRoot: `${workspaceRoot}/Alembic`,
          moduleId: 'target:Alembic:Alembic',
          dimensionId: 'architecture',
          coveredCount: 4,
          totalCandidateCount: 4,
          grade: 'covered',
        }),
        cell({
          projectRoot: `${workspaceRoot}/AlembicCore`,
          moduleId: 'target:AlembicCore:AlembicCore',
          dimensionId: 'api',
          totalCandidateCount: 3,
          grade: 'empty',
          valueScore: 0.9,
        }),
        cell({
          projectRoot: `${workspaceRoot}/BiliDili`,
          moduleId: 'target:BiliDili:BiliDili',
          dimensionId: 'architecture',
          coveredCount: 99,
          totalCandidateCount: 99,
          grade: 'covered',
        }),
      ],
      facts: facts({
        fileCount: 30,
        modules: [
          module({ moduleName: 'Alembic', modulePath: 'Alembic', ownedFileCount: 12 }),
          module({ moduleName: 'AlembicCore', modulePath: 'AlembicCore', ownedFileCount: 18 }),
          module({ moduleName: 'BiliDili', modulePath: 'BiliDili', ownedFileCount: 50 }),
        ],
        projectRoot: workspaceRoot,
      }),
      totalRecipes: 11,
    });

    expect(resolvePanoramaCoverageProjectRoots(analysisScope)).toEqual([
      `${workspaceRoot}/Alembic`,
      `${workspaceRoot}/AlembicCore`,
    ]);
    expect(view.overview.moduleCount).toBe(2);
    expect(JSON.stringify(view.overview.layers)).not.toContain('BiliDili');
    expect(view.overview.projectScope).toMatchObject({
      excludedCoverageCellCount: 1,
      excludedModuleCount: 1,
      mode: 'members-only',
      projectRoot: workspaceRoot,
    });
    expect(view.overview.layers.flatMap((layer) => layer.modules).map((item) => item.name)).toEqual(
      ['Alembic', 'AlembicCore']
    );
    expect(view.gaps.some((gap) => gap.dimension === 'api' && gap.priority === 'high')).toBe(true);
    expect(view.health.avgCoupling).toBe(1);
    expect(view.health.healthScore).toBe(
      Math.round(
        view.health.healthRadar.overallScore * 0.6 +
          20 +
          (view.health.highPriorityGaps === 0 ? 10 : 0) +
          10
      )
    );
  });

  test('uses normalized target module ids for real per-module coverage counts', () => {
    const workspaceRoot = '/tmp/AlembicWorkspace';
    const view = buildPanoramaEndpointView({
      analysisScope: projectScopeAnalysis(workspaceRoot, ['Alembic']),
      coverageLedgerCells: [
        cell({
          projectRoot: `${workspaceRoot}/Alembic`,
          moduleId: 'target:Alembic:Alembic',
          dimensionId: 'architecture',
          coveredCount: 4,
          totalCandidateCount: 4,
          grade: 'covered',
        }),
      ],
      facts: facts({
        fileCount: 12,
        modules: [module({ moduleName: 'Alembic', modulePath: 'Alembic', ownedFileCount: 12 })],
        projectRoot: workspaceRoot,
      }),
      totalRecipes: 4,
    });

    const panoramaModule = view.overview.layers.flatMap((layer) => layer.modules)[0];
    expect(view.diagnostics.directModuleIdAligned).toBe(true);
    expect(view.overview.recipeCount).toMatchObject({
      mode: 'per-module-coverage-ledger',
      reason: 'direct-module-id-aligned',
    });
    expect(panoramaModule).toMatchObject({
      name: 'Alembic',
      recipeCount: 4,
      recipeCountSource: 'coverage-ledger-direct',
    });
  });

  test('degrades raw module ids to project total without fabricating per-module counts', () => {
    const projectRoot = '/tmp/single-repo';
    const view = buildPanoramaEndpointView({
      analysisScope: singleRepoAnalysis(projectRoot),
      coverageLedgerCells: [
        cell({
          projectRoot,
          moduleId: 'target:Legacy:src',
          dimensionId: 'architecture',
          coveredCount: 3,
          totalCandidateCount: 3,
          grade: 'covered',
        }),
      ],
      facts: facts({
        fileCount: 5,
        modules: [module({ moduleId: 'module:legacy', moduleName: 'Legacy', ownedFileCount: 5 })],
        projectRoot,
      }),
      totalRecipes: 7,
    });

    const panoramaModule = view.overview.layers.flatMap((layer) => layer.modules)[0];
    expect(view.diagnostics.directModuleIdAligned).toBe(false);
    expect(view.overview.recipeCount).toMatchObject({
      mode: 'project-total-only',
      projectRecipeCount: { totalRecipes: 7 },
      reason: 'direct-module-id-mismatch',
    });
    expect(panoramaModule).toMatchObject({
      recipeCount: null,
      recipeCountSource: 'degraded-project-total',
    });
  });

  test('preserves single-repo project-root scope behavior', () => {
    const projectRoot = '/tmp/single-repo';
    const view = buildPanoramaEndpointView({
      analysisScope: singleRepoAnalysis(projectRoot),
      coverageLedgerCells: [
        cell({
          projectRoot,
          moduleId: 'target:App:src',
          dimensionId: 'architecture',
          coveredCount: 2,
          totalCandidateCount: 3,
          grade: 'partial',
        }),
      ],
      facts: facts({
        fileCount: 9,
        modules: [module({ moduleName: 'App', modulePath: 'src', ownedFileCount: 9 })],
        projectRoot,
      }),
      totalRecipes: 3,
    });

    expect(resolvePanoramaCoverageProjectRoots(singleRepoAnalysis(projectRoot))).toEqual([
      projectRoot,
    ]);
    expect(view.overview.projectScope).toMatchObject({
      mode: 'project-root',
      memberRoots: [projectRoot],
      excludedCoverageCellCount: 0,
      excludedModuleCount: 0,
    });
    expect(view.overview.moduleCount).toBe(1);
    expect(view.overview.layers[0]?.modules[0]).toMatchObject({
      name: 'App',
      recipeCount: 2,
      recipeCountSource: 'coverage-ledger-direct',
    });
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
      projectScopeId: 'scope-test',
    } as NonNullable<ProjectScopeAnalysisContext['projectScope']>,
    projectScopeId: 'scope-test',
  };
}

function singleRepoAnalysis(projectRoot: string): ProjectScopeAnalysisContext {
  return {
    controlRoot: null,
    currentFolderId: null,
    dataRoot: '/tmp/alembic-data',
    folderCount: 0,
    projectRoot,
    projectScope: null,
    projectScopeId: null,
  };
}

function facts(input: {
  fileCount: number;
  modules: readonly ProjectContextModule[];
  projectRoot: string;
}): BuildFacts {
  return {
    fileCount: input.fileCount,
    moduleCount: input.modules.length,
    presenterInput: {
      map: {
        dependencySummary: { edgeCount: 2 },
        cycles: [],
      },
    } as unknown as ProjectContextWorkflowFacts['presenterInput'],
    projectMapModules: input.modules,
    projectRoot: input.projectRoot,
  };
}

type BuildFacts = Parameters<typeof buildPanoramaEndpointView>[0]['facts'];

function module(overrides: Partial<ProjectContextModule>): ProjectContextModule {
  const moduleName = overrides.moduleName ?? 'Module';
  const modulePath = overrides.modulePath;
  return {
    moduleId:
      overrides.moduleId ?? (modulePath ? `target:${moduleName}:${modulePath}` : moduleName),
    moduleName,
    ownedFileCount: 1,
    role: 'source',
    ...overrides,
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

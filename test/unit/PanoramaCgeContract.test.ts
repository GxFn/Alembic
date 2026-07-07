import { describe, expect, test } from 'vitest';
import { buildPanoramaModuleRecipeCountContract } from '../../lib/project-facts/PanoramaCgeContract.js';

describe('Panorama CG-E recipe count contract', () => {
  test('degrades to project total when Core P0 proves direct module id alignment is false', () => {
    const contract = buildPanoramaModuleRecipeCountContract({
      coverageLedgerCells: [
        {
          coveredCount: 4,
          moduleId: 'target:feature:src/feature',
          projectRoot: '/workspace/Alembic',
        },
        {
          coveredCount: 3,
          moduleId: 'target:shared:src/shared',
          projectRoot: '/workspace/Alembic',
        },
      ],
      moduleIdAlignment: {
        directAligned: false,
        source: 'core-p0-characterization',
      },
      projectMapModules: [
        {
          moduleId: 'module:core:feature:src/feature',
          moduleName: 'feature',
          modulePath: 'src/feature',
          projectRoot: '/workspace/Alembic',
        },
        {
          moduleId: 'module:core:shared:src/shared',
          moduleName: 'shared',
          modulePath: 'src/shared',
          projectRoot: '/workspace/Alembic',
        },
      ],
      projectRoot: '/workspace/Alembic',
      totalRecipes: 11,
    });

    expect(contract).toMatchObject({
      mode: 'project-total-only',
      projectRecipeCount: {
        source: 'knowledge-entries',
        totalRecipes: 11,
      },
      reason: 'direct-module-id-mismatch',
    });
    expect(contract.moduleRecipeCounts).toEqual([
      expect.objectContaining({
        moduleId: 'module:core:feature:src/feature',
        recipeCount: null,
        recipeCountSource: 'degraded-project-total',
      }),
      expect.objectContaining({
        moduleId: 'module:core:shared:src/shared',
        recipeCount: null,
        recipeCountSource: 'degraded-project-total',
      }),
    ]);
    expect(contract.moduleRecipeCounts.map((module) => module.recipeCount)).not.toEqual([4, 3]);
  });

  test('uses direct coverage cells only when module ids are proven aligned', () => {
    const contract = buildPanoramaModuleRecipeCountContract({
      coverageLedgerCells: [
        {
          coveredCount: 2,
          moduleId: 'target:feature:src/feature',
          projectRoot: '/workspace/Alembic',
        },
        {
          coveredCount: 3,
          moduleId: 'target:feature:src/feature',
          projectRoot: '/workspace/Alembic',
        },
      ],
      moduleIdAlignment: {
        directAligned: true,
        source: 'runtime-check',
      },
      projectMapModules: [
        {
          moduleId: 'target:feature:src/feature',
          moduleName: 'feature',
          modulePath: 'src/feature',
          projectRoot: '/workspace/Alembic',
        },
      ],
      projectRoot: '/workspace/Alembic',
      totalRecipes: 5,
    });

    expect(contract).toMatchObject({
      mode: 'per-module-coverage-ledger',
      reason: 'direct-module-id-aligned',
    });
    expect(contract.moduleRecipeCounts).toEqual([
      expect.objectContaining({
        moduleId: 'target:feature:src/feature',
        recipeCount: 5,
        recipeCountSource: 'coverage-ledger-direct',
      }),
    ]);
  });

  test('keeps controlRoot aggregation inside declared member roots', () => {
    const contract = buildPanoramaModuleRecipeCountContract({
      coverageLedgerCells: [
        {
          coveredCount: 6,
          moduleId: 'target:api:lib/api',
          projectRoot: '/workspace/Alembic',
        },
        {
          coveredCount: 99,
          moduleId: 'target:bili:src',
          projectRoot: '/workspace/BiliDili',
        },
      ],
      moduleIdAlignment: {
        directAligned: false,
        source: 'core-p0-characterization',
      },
      projectMapModules: [
        {
          moduleId: 'module:core:api:lib/api',
          moduleName: 'api',
          modulePath: 'lib/api',
          projectRoot: '/workspace/Alembic',
        },
        {
          moduleId: 'module:core:host:src',
          moduleName: 'host',
          modulePath: 'src',
          projectRoot: '/workspace/AlembicCore',
        },
        {
          moduleId: 'module:core:bili:src',
          moduleName: 'bili',
          modulePath: 'src',
          projectRoot: '/workspace/BiliDili',
        },
      ],
      projectRoot: '/workspace',
      scope: {
        controlRoot: '/workspace',
        memberRoots: ['/workspace/Alembic', '/workspace/AlembicCore'],
      },
      totalRecipes: 12,
    });

    expect(contract.scopeBoundary).toMatchObject({
      excludedCoverageCellCount: 1,
      excludedModuleCount: 1,
      mode: 'members-only',
    });
    expect(contract.moduleRecipeCounts.map((module) => module.moduleName)).toEqual(['api', 'host']);
    expect(contract.moduleRecipeCounts.map((module) => module.moduleName)).not.toContain('bili');
  });
});

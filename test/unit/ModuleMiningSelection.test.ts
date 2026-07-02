import { describe, expect, test } from 'vitest';
import { selectScopedModuleMiningModules } from '../../lib/daemon/ModuleMiningSelection.js';
import type { ProjectContextWorkflowFacts } from '../../lib/workflows/project-context/ProjectContextWorkflowFacts.js';

function makeFacts(): ProjectContextWorkflowFacts {
  return {
    projectMapModules: [
      {
        moduleId: 'mod-1',
        moduleName: 'module-1',
        modulePath: 'src/module-1',
        ownedFiles: ['src/module-1/index.ts'],
      },
      {
        moduleId: 'mod-2',
        moduleName: 'module-2',
        modulePath: 'src/module-2',
        ownedFiles: ['src/module-2/index.ts'],
      },
    ],
  } as unknown as ProjectContextWorkflowFacts;
}

describe('selectScopedModuleMiningModules', () => {
  test('keeps Entry A binding-rich module mining dimensions explicit', () => {
    const modules = selectScopedModuleMiningModules({
      bindings: [
        {
          dimensions: ['architecture', 'coding-standards'],
          moduleId: 'mod-1',
          modulePath: 'src/module-1',
          targetRecipes: 3,
        },
        {
          dimensions: ['error-resilience'],
          moduleId: 'mod-2',
          modulePath: 'src/module-2',
          targetRecipes: 1,
        },
      ],
      executionDimensions: ['architecture', 'coding-standards', 'error-resilience'],
      facts: makeFacts(),
      moduleScope: ['src/module-1', 'src/module-2'],
    });

    expect(modules).toEqual([
      expect.objectContaining({
        dimensions: ['architecture', 'coding-standards'],
        dimensionIds: ['architecture', 'coding-standards'],
        moduleName: 'module-1',
        plannedDimensionTargets: { architecture: 3, 'coding-standards': 3 },
        plannedDimensions: ['architecture', 'coding-standards'],
        targetRecipes: 3,
      }),
      expect.objectContaining({
        dimensions: ['error-resilience'],
        dimensionIds: ['error-resilience'],
        moduleName: 'module-2',
        plannedDimensionTargets: { 'error-resilience': 1 },
        plannedDimensions: ['error-resilience'],
        targetRecipes: 1,
      }),
    ]);
    expect(modules.map((module) => module.moduleId)).toEqual([
      'target:module-1:src/module-1',
      'target:module-2:src/module-2',
    ]);
  });

  test('changes Entry B scope-only selection into planned per-module targeting', () => {
    const modules = selectScopedModuleMiningModules({
      bindings: [
        {
          dimensions: ['architecture'],
          moduleName: 'module-2',
          targetRecipes: 2,
        },
      ],
      executionDimensions: ['architecture', 'coding-standards'],
      facts: makeFacts(),
      moduleScope: ['module-2'],
    });

    expect(modules).toEqual([
      expect.objectContaining({
        dimensions: ['architecture'],
        dimensionIds: ['architecture'],
        moduleId: 'target:module-2:src/module-2',
        moduleName: 'module-2',
        plannedDimensionTargets: { architecture: 2 },
        plannedDimensions: ['architecture'],
        targetRecipes: 2,
      }),
    ]);
    expect(modules[0]?.dimensions).not.toEqual(['architecture', 'coding-standards']);
  });

  test('keeps Entry B explicit module targets when gap analysis marks them fully covered', () => {
    const modules = selectScopedModuleMiningModules({
      bindings: [
        {
          dimensions: ['architecture'],
          moduleId: 'mod-2',
          moduleName: 'module-2',
          targetRecipes: 1,
        },
      ],
      executionDimensions: [],
      facts: makeFacts(),
      moduleScope: ['module-2'],
    });

    expect(modules).toEqual([
      expect.objectContaining({
        dimensions: ['architecture'],
        dimensionIds: ['architecture'],
        moduleId: 'target:module-2:src/module-2',
        moduleName: 'module-2',
        plannedDimensionTargets: { architecture: 1 },
        plannedDimensions: ['architecture'],
        targetRecipes: 1,
      }),
    ]);
  });

  test('keeps target-scoped ProjectMap module ids stable', () => {
    const modules = selectScopedModuleMiningModules({
      bindings: [
        {
          dimensions: ['architecture'],
          moduleId: 'target:module-2:src/module-2',
          targetRecipes: 1,
        },
      ],
      executionDimensions: [],
      facts: {
        ...makeFacts(),
        projectMapModules: [
          {
            moduleId: 'target:module-2:src/module-2',
            moduleName: 'module-2',
            modulePath: 'src/module-2',
            ownedFiles: ['src/module-2/index.ts'],
          },
        ],
      },
      moduleScope: ['target:module-2:src/module-2'],
    });

    expect(modules).toEqual([
      expect.objectContaining({
        moduleId: 'target:module-2:src/module-2',
        moduleName: 'module-2',
      }),
    ]);
  });

  test('keeps no-path ProjectMap module ids as selection fallback', () => {
    const modules = selectScopedModuleMiningModules({
      bindings: [
        {
          dimensions: ['architecture'],
          moduleId: 'legacy-module',
          targetRecipes: 1,
        },
      ],
      executionDimensions: [],
      facts: {
        ...makeFacts(),
        projectMapModules: [
          {
            moduleId: 'legacy-module',
            moduleName: 'legacy-module',
            ownedFiles: ['legacy/index.ts'],
          },
        ],
      },
      moduleScope: ['legacy-module'],
    });

    expect(modules).toEqual([
      expect.objectContaining({
        moduleId: 'legacy-module',
        moduleName: 'legacy-module',
      }),
    ]);
  });
});

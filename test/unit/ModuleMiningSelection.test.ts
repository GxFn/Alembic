import { describe, expect, test } from 'vitest';
import { selectProjectIndexModuleMiningModules } from '../../lib/daemon/ModuleMiningSelection.js';
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

describe('selectProjectIndexModuleMiningModules', () => {
  test('keeps Entry A binding-rich module mining dimensions explicit', () => {
    const modules = selectProjectIndexModuleMiningModules({
      bindings: [
        {
          dimensions: ['architecture', 'coding-standards'],
          moduleId: 'mod-1',
          modulePath: 'src/module-1',
        },
        {
          dimensions: ['error-resilience'],
          moduleId: 'mod-2',
          modulePath: 'src/module-2',
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
        plannedDimensions: ['architecture', 'coding-standards'],
      }),
      expect.objectContaining({
        dimensions: ['error-resilience'],
        dimensionIds: ['error-resilience'],
        moduleName: 'module-2',
        plannedDimensions: ['error-resilience'],
      }),
    ]);
  });

  test('changes Entry B scope-only selection into planned per-module targeting', () => {
    const modules = selectProjectIndexModuleMiningModules({
      bindings: [
        {
          dimensions: ['architecture'],
          moduleName: 'module-2',
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
        moduleId: 'mod-2',
        moduleName: 'module-2',
        plannedDimensions: ['architecture'],
      }),
    ]);
    expect(modules[0]?.dimensions).not.toEqual(['architecture', 'coding-standards']);
  });
});

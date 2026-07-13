import { describe, expect, test, vi } from 'vitest';
import { runUiStartupTasks } from '../../lib/recipe-pipeline/generate/runtime/UiStartupTasks.js';

describe('UiStartupTasks Recipe generation boundary', () => {
  test('first startup plans generation without running legacy vector reconcile', async () => {
    const reconcileIndex = vi.fn();
    const maintain = vi.fn().mockResolvedValue({ status: 'planned', active: null });
    const report = await runUiStartupTasks(
      startupContext({ active: null, maintain, reconcileIndex })
    );

    expect(reconcileIndex).not.toHaveBeenCalled();
    expect(maintain).toHaveBeenCalledWith('full-build');
    expect(report.recipeGeneration).toEqual({
      status: 'planned',
      activeGenerationId: null,
    });
  });

  test('existing active generation permits exact reconcile before maintenance', async () => {
    const reconcileIndex = vi.fn().mockResolvedValue({
      orphansRemoved: 1,
      missingSynced: 2,
      errors: [],
    });
    const maintain = vi.fn().mockResolvedValue({
      status: 'already-active',
      active: { generationId: 'generation-1' },
    });
    const report = await runUiStartupTasks(
      startupContext({
        active: { generationId: 'generation-1' },
        maintain,
        reconcileIndex,
      })
    );

    expect(reconcileIndex).toHaveBeenCalledOnce();
    expect(report.vectorReconcile).toEqual({ orphans: 1, missing: 2 });
    expect(maintain).toHaveBeenCalledWith('full-build');
  });
});

function startupContext(input: {
  active: { generationId: string } | null;
  maintain: ReturnType<typeof vi.fn>;
  reconcileIndex: ReturnType<typeof vi.fn>;
}) {
  const services = {
    recipeVectorGenerationRuntime: true,
    recipeVectorGenerationStorage: true,
    vectorService: true,
  };
  return {
    projectRoot: process.cwd(),
    container: {
      services,
      singletons: {},
      get(name: string) {
        if (name === 'database') {
          throw new Error('database intentionally absent in focused startup test');
        }
        if (name === 'recipeVectorGenerationStorage') {
          return { readActive: vi.fn().mockResolvedValue(input.active) };
        }
        if (name === 'recipeVectorGenerationRuntime') {
          return { maintain: input.maintain };
        }
        if (name === 'vectorService') {
          return { reconcileIndex: input.reconcileIndex };
        }
        throw new Error(`Unexpected service requested: ${name}`);
      },
    },
  };
}

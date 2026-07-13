import { RECIPE_PIPELINE_EVENTS } from '@alembic/core/knowledge';
import { describe, expect, test, vi } from 'vitest';
import {
  maintainRecipeVectorGeneration,
  registerRecipeVectorGenerationOnGenerateCompletion,
} from '../../lib/recipe-pipeline/generate/execution/consumers/RecipeVectorGenerationConsumer.js';

describe('Recipe vector generation workflow consumer', () => {
  test('runs maintenance only after the matching Generate session completes', async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const runtime = { maintain: vi.fn().mockResolvedValue({ status: 'planned', active: null }) };
    const eventBus = {
      on: vi.fn((event: string, listener: (payload: unknown) => void) =>
        listeners.set(event, listener)
      ),
      off: vi.fn((event: string) => listeners.delete(event)),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const container = {
      get(name: string) {
        if (name === 'eventBus') {
          return eventBus;
        }
        if (name === 'recipeVectorGenerationRuntime') {
          return runtime;
        }
        throw new Error(name);
      },
    };
    registerRecipeVectorGenerationOnGenerateCompletion({
      bootstrapSessionId: 'session-1',
      container,
      createdFrom: 'incremental',
      logger,
      logPrefix: 'Rescan',
    });

    listeners.get(RECIPE_PIPELINE_EVENTS.allCompleted)?.({ sessionId: 'other' });
    expect(runtime.maintain).not.toHaveBeenCalled();
    listeners.get(RECIPE_PIPELINE_EVENTS.allCompleted)?.({ sessionId: 'session-1' });
    await vi.waitFor(() => expect(runtime.maintain).toHaveBeenCalledWith('incremental'));
    expect(eventBus.off).toHaveBeenCalled();
  });

  test('logs failed generation maintenance without changing workflow completion', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    await maintainRecipeVectorGeneration({
      container: {
        get: () => ({
          maintain: vi.fn().mockResolvedValue({
            status: 'failed',
            active: { generationId: 'still-active' },
            generationId: 'failed-shadow',
            errors: ['simulated'],
          }),
        }),
      },
      createdFrom: 'full-build',
      logger,
      logPrefix: 'Startup',
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('maintenance failed'),
      expect.objectContaining({ activeGenerationId: 'still-active' })
    );
  });
});

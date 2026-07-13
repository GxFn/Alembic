import { RECIPE_PIPELINE_EVENTS } from '@alembic/core/knowledge';
import type { RecipeVectorGenerationSource } from '@alembic/core/vector';
import type { RecipeVectorGenerationRuntime } from '../../../../service/vector/RecipeVectorGenerationRuntime.js';

interface GenerationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

interface EventBusLike {
  on(eventName: string, listener: (payload: unknown) => void): void;
  off?(eventName: string, listener: (payload: unknown) => void): void;
}

interface GenerationContainer {
  get(name: string): unknown;
}

type MaintenanceSource = Exclude<RecipeVectorGenerationSource, 'migration'>;

/** 冷启动/增量流程共用的 generation maintenance 入口。 */
export async function maintainRecipeVectorGeneration(input: {
  container: GenerationContainer;
  createdFrom: MaintenanceSource;
  logger: GenerationLogger;
  logPrefix: string;
}): Promise<void> {
  try {
    const runtime = input.container.get(
      'recipeVectorGenerationRuntime'
    ) as RecipeVectorGenerationRuntime;
    const result = await runtime.maintain(input.createdFrom);
    if (result.status === 'failed') {
      input.logger.warn(`[${input.logPrefix}] Recipe vector generation maintenance failed`, {
        activeGenerationId: result.active?.generationId ?? null,
        errors: result.errors,
        failedGenerationId: result.generationId,
      });
      return;
    }
    input.logger.info(`[${input.logPrefix}] Recipe vector generation maintenance complete`, {
      activeGenerationId: result.active?.generationId ?? null,
      status: result.status,
      writePerformed: 'writePerformed' in result ? result.writePerformed : true,
    });
  } catch (error: unknown) {
    input.logger.warn(`[${input.logPrefix}] Recipe vector generation maintenance skipped`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 异步 Generate session 完成后执行一次 generation maintenance。 */
export function registerRecipeVectorGenerationOnGenerateCompletion(input: {
  bootstrapSessionId?: string;
  container: GenerationContainer;
  createdFrom: MaintenanceSource;
  logger: GenerationLogger;
  logPrefix: string;
}): (() => void) | null {
  if (!input.bootstrapSessionId) {
    input.logger.warn(`[${input.logPrefix}] Recipe vector generation hook skipped`, {
      reason: 'missing-bootstrap-session',
    });
    return null;
  }

  let eventBus: EventBusLike;
  try {
    eventBus = input.container.get('eventBus') as EventBusLike;
  } catch {
    input.logger.warn(`[${input.logPrefix}] Recipe vector generation hook skipped`, {
      reason: 'missing-event-bus',
    });
    return null;
  }

  const listener = (payload: unknown) => {
    const event =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    if (event.sessionId !== input.bootstrapSessionId) {
      return;
    }
    eventBus.off?.(RECIPE_PIPELINE_EVENTS.allCompleted, listener);
    void maintainRecipeVectorGeneration(input);
  };
  eventBus.on(RECIPE_PIPELINE_EVENTS.allCompleted, listener);
  return () => eventBus.off?.(RECIPE_PIPELINE_EVENTS.allCompleted, listener);
}

import Logger from '#infra/logging/Logger.js';
import { runCursorDelivery } from '#workflows/capabilities/completion/DeliveryCompletionStep.js';
import { verifyDelivery } from '#workflows/capabilities/completion/DeliveryVerificationStep.js';
import { refreshPanorama } from '#workflows/capabilities/completion/PanoramaCompletionStep.js';
import { consolidateSemanticMemory } from '#workflows/capabilities/completion/SemanticMemoryCompletionStep.js';
import { generateWiki } from '#workflows/capabilities/completion/WikiCompletionStep.js';
import type {
  CompletionContextLike,
  CompletionLogger,
  CompletionSessionLike,
  ServiceContainerLike,
  WorkflowCompletionFinalizerDependencies,
  WorkflowCompletionFinalizerResult,
  WorkflowSemanticMemoryMode,
} from '#workflows/capabilities/completion/WorkflowCompletionTypes.js';

export type {
  WorkflowCompletionFinalizerDependencies,
  WorkflowCompletionFinalizerResult,
  WorkflowSemanticMemoryConsolidationResult,
  WorkflowSemanticMemoryMode,
} from '#workflows/capabilities/completion/WorkflowCompletionTypes.js';

const logger = Logger.getInstance();

export async function runWorkflowCompletionFinalizer({
  ctx,
  session,
  projectRoot,
  dataRoot,
  log = logger,
  dependencies = {},
  semanticMemory = {},
}: {
  ctx: CompletionContextLike;
  session: CompletionSessionLike;
  projectRoot: string;
  dataRoot: string;
  log?: CompletionLogger;
  dependencies?: WorkflowCompletionFinalizerDependencies;
  semanticMemory?: { mode?: WorkflowSemanticMemoryMode };
}): Promise<WorkflowCompletionFinalizerResult> {
  const getServiceContainer = dependencies.getServiceContainer ?? defaultGetServiceContainer;
  const scheduleTask = dependencies.scheduleTask ?? defaultScheduleTask;
  const semanticMemoryMode = semanticMemory.mode ?? 'scheduled';

  await runCursorDelivery({ getServiceContainer, log });
  const deliveryVerification = await verifyDelivery({ ctx, log });
  await refreshPanorama({ getServiceContainer, log });

  scheduleTask(() => generateWiki({ getServiceContainer, projectRoot, log }));
  let semanticMemoryResult: WorkflowCompletionFinalizerResult['semanticMemoryResult'] = null;
  if (semanticMemoryMode === 'immediate') {
    semanticMemoryResult = await consolidateSemanticMemory({ ctx, session, dataRoot, log });
  } else if (semanticMemoryMode === 'scheduled') {
    scheduleTask(async () => {
      await consolidateSemanticMemory({ ctx, session, dataRoot, log });
    });
  }

  return { deliveryVerification, semanticMemoryResult };
}

async function defaultGetServiceContainer(): Promise<ServiceContainerLike> {
  const { getServiceContainer } = await import('#inject/ServiceContainer.js');
  return getServiceContainer() as ServiceContainerLike;
}

function defaultScheduleTask(task: () => Promise<void>): void {
  setImmediate(() => {
    task().catch((err: unknown) => {
      logger.warn(
        `[DimensionComplete] Scheduled completion task failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
      );
    });
  });
}

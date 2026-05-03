import Logger from '#infra/logging/Logger.js';
import {
  consolidateSemanticMemory,
  generateWiki,
  refreshPanorama,
  runCursorDelivery,
  verifyDelivery,
} from '#workflows/capabilities/completion/CompletionSteps.js';
import type {
  CompletionContextLike,
  CompletionLogger,
  CompletionSessionLike,
  ServiceContainerLike,
  ShouldAbortFn,
  WorkflowCompletionFinalizerDependencies,
  WorkflowCompletionFinalizerResult,
  WorkflowSemanticMemoryMode,
} from '#workflows/capabilities/completion/WorkflowCompletionTypes.js';

export type {
  WorkflowCompletionFinalizerDependencies,
  WorkflowCompletionFinalizerResult,
  WorkflowCompletionSummary,
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
  shouldAbort,
}: {
  ctx: CompletionContextLike;
  session: CompletionSessionLike;
  projectRoot: string;
  dataRoot: string;
  log?: CompletionLogger;
  dependencies?: WorkflowCompletionFinalizerDependencies;
  semanticMemory?: { mode?: WorkflowSemanticMemoryMode };
  shouldAbort?: ShouldAbortFn;
}): Promise<WorkflowCompletionFinalizerResult> {
  const getServiceContainer = dependencies.getServiceContainer ?? defaultGetServiceContainer;
  const scheduleTask = dependencies.scheduleTask ?? defaultScheduleTask;
  const semanticMemoryMode = semanticMemory.mode ?? 'scheduled';

  if (shouldAbort?.()) {
    log.info('[CompletionFinalizer] Aborted before delivery — user cancelled');
    return { deliveryVerification: null, semanticMemoryResult: null };
  }
  await runCursorDelivery({ getServiceContainer, log });
  const deliveryVerification = await verifyDelivery({ ctx, log });
  await refreshPanorama({ getServiceContainer, log });

  if (shouldAbort?.()) {
    log.info('[CompletionFinalizer] Aborted before wiki/memory — user cancelled');
    return { deliveryVerification, semanticMemoryResult: null };
  }
  scheduleTask(() => generateWiki({ getServiceContainer, projectRoot, log }));
  let semanticMemoryResult: WorkflowCompletionFinalizerResult['semanticMemoryResult'] = null;
  if (semanticMemoryMode === 'immediate') {
    if (!shouldAbort?.()) {
      semanticMemoryResult = await consolidateSemanticMemory({ ctx, session, dataRoot, log });
    }
  } else if (semanticMemoryMode === 'scheduled') {
    if (!shouldAbort?.()) {
      scheduleTask(async () => {
        await consolidateSemanticMemory({ ctx, session, dataRoot, log });
      });
    }
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

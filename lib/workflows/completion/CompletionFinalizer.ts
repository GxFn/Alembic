import Logger from '@alembic/core/logging';
import { consolidateSemanticMemory, generateWiki, refreshPanorama } from './CompletionSteps.js';
import type {
  CompletionContextLike,
  CompletionLogger,
  CompletionSessionLike,
  ServiceContainerLike,
  ShouldAbortFn,
  WorkflowCompletionFinalizerDependencies,
  WorkflowCompletionFinalizerResult,
  WorkflowCompletionStepOptions,
  WorkflowSemanticMemoryMode,
} from './CompletionTypes.js';

export type {
  WorkflowCompletionFinalizerDependencies,
  WorkflowCompletionFinalizerResult,
  WorkflowCompletionStepOptions,
  WorkflowCompletionSummary,
  WorkflowSemanticMemoryConsolidationResult,
  WorkflowSemanticMemoryMode,
} from './CompletionTypes.js';

const logger = Logger.getInstance();

export async function runWorkflowCompletionFinalizer({
  ctx,
  session,
  projectRoot,
  dataRoot,
  log = logger,
  dependencies = {},
  semanticMemory = {},
  steps = {},
  shouldAbort,
}: {
  ctx: CompletionContextLike;
  session: CompletionSessionLike;
  projectRoot: string;
  dataRoot: string;
  log?: CompletionLogger;
  dependencies?: WorkflowCompletionFinalizerDependencies;
  semanticMemory?: { mode?: WorkflowSemanticMemoryMode };
  steps?: WorkflowCompletionStepOptions;
  shouldAbort?: ShouldAbortFn;
}): Promise<WorkflowCompletionFinalizerResult> {
  const getServiceContainer = dependencies.getServiceContainer ?? defaultGetServiceContainer;
  const scheduleTask = dependencies.scheduleTask ?? defaultScheduleTask;
  const semanticMemoryMode = semanticMemory.mode ?? 'scheduled';
  const deliveryMode = steps.delivery ?? 'run';
  const panoramaMode = steps.panorama ?? 'run';
  const wikiMode = steps.wiki ?? 'schedule';

  if (shouldAbort?.()) {
    log.info('[CompletionFinalizer] Aborted before delivery — user cancelled');
    return {
      deliveryVerification: null,
      semanticMemoryResult: null,
      deliveryStatus: 'skipped',
      wikiStatus: 'skipped',
      panoramaStatus: 'skipped',
    };
  }
  const deliveryVerification: WorkflowCompletionFinalizerResult['deliveryVerification'] = null;
  const deliveryStatus: WorkflowCompletionFinalizerResult['deliveryStatus'] = 'skipped';
  if (deliveryMode === 'run') {
    log.info('[CompletionFinalizer] Project delivery retired for Alembic main package');
  } else {
    log.info('[CompletionFinalizer] Target delivery skipped by workflow option');
  }

  let panoramaStatus: WorkflowCompletionFinalizerResult['panoramaStatus'] = 'skipped';
  if (panoramaMode === 'run') {
    await refreshPanorama({ getServiceContainer, log });
    panoramaStatus = 'completed';
  } else {
    log.info('[CompletionFinalizer] Panorama refresh skipped by workflow option');
  }

  if (shouldAbort?.()) {
    log.info('[CompletionFinalizer] Aborted before wiki/memory — user cancelled');
    return {
      deliveryVerification,
      semanticMemoryResult: null,
      deliveryStatus,
      wikiStatus: 'skipped',
      panoramaStatus,
    };
  }
  let wikiStatus: WorkflowCompletionFinalizerResult['wikiStatus'] = 'skipped';
  if (wikiMode === 'schedule') {
    scheduleTask(() => generateWiki({ getServiceContainer, projectRoot, dataRoot, log }));
    wikiStatus = 'scheduled';
  } else {
    log.info('[CompletionFinalizer] Wiki generation skipped by workflow option');
  }
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

  return { deliveryVerification, semanticMemoryResult, deliveryStatus, wikiStatus, panoramaStatus };
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

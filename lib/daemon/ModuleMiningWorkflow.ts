import type { AgentService } from '@alembic/agent/service';
import { getJobProcessEventRecorder } from './DaemonJobServices.js';
import {
  asRecord,
  extractNewRecipesThisRound,
  getOptionalService,
  positiveIntegerArg,
  recordJobProcessEvent,
  stringValue,
} from './DaemonJobWorkflowHelpers.js';
import type {
  ModuleMiningKnowledgeRepositoryLike,
  ModuleMiningPersistedOutputDelta,
  ModuleMiningPersistenceSnapshot,
  ModuleMiningSourceRefRepositoryLike,
  RunDaemonJobOptions,
} from './DaemonJobWorkflowTypes.js';
import { selectProjectIndexModuleMiningModules } from './ModuleMiningSelection.js';
import { runPlanSelectionGate } from './PlanSelectionGate.js';

export async function runModuleMiningWorkflow(options: RunDaemonJobOptions): Promise<unknown> {
  const planGate = await runPlanSelectionGate(options, {
    generationStage: 'moduleMining',
    label: 'ModuleMining',
    source: 'alembic-main-rescan',
  });
  const modules = selectProjectIndexModuleMiningModules({
    bindings: planGate.selection.moduleBindings,
    executionDimensions: planGate.projection.executionDimensions,
    facts: planGate.projectContextFacts,
    moduleScope: planGate.projection.moduleScope,
  });
  if (modules.length === 0) {
    throw new Error('moduleMining requires at least one ProjectMap module.');
  }

  const explicitScaleCap = positiveIntegerArg(options.args?.scaleCap);
  const scaleCap =
    explicitScaleCap ?? Math.min(modules.length, planGate.projection.budget.totalRecipeBudget);
  const selectedModules = modules.slice(0, scaleCap);
  if (selectedModules.length === 0) {
    throw new Error('moduleMining scaleCap selected zero ProjectMap modules.');
  }

  const persistedOutputBefore = await readModuleMiningPersistenceSnapshot(options);
  const { runModuleMining } = await import('@alembic/agent/service');
  const result = await runModuleMining({
    agentService: options.container.get('agentService') as Pick<AgentService, 'run'>,
    budget: { ...planGate.projection.budget },
    modules: selectedModules,
    projectFacts: planGate.projectContextFacts,
    scaleCap,
  });
  const reportedNewRecipes = extractNewRecipesThisRound(result);
  const persistedOutputDelta = await readModuleMiningPersistedOutputDelta(
    options,
    persistedOutputBefore
  );
  const newRecipes = Math.max(reportedNewRecipes, persistedOutputDelta.recipeIds.length);
  if (newRecipes <= 0) {
    throw new Error('moduleMining produced zero recipes.');
  }

  options.logger.info('ModuleMining result accounting completed', {
    jobId: options.jobId,
    persistedNewRecipes: persistedOutputDelta.recipeIds.length,
    persistedSourceRefCount: persistedOutputDelta.sourceRefCount,
    reportedNewRecipes,
    stage: 'module-mining-result-accounting',
  });
  recordJobProcessEvent(getJobProcessEventRecorder(options.container), {
    jobId: options.jobId,
    kind: 'checkpoint',
    metadata: {
      persistedNewRecipes: persistedOutputDelta.recipeIds.length,
      persistedRecipeIds: persistedOutputDelta.recipeIds.slice(0, 25),
      persistedSourceRefCount: persistedOutputDelta.sourceRefCount,
      reportedNewRecipes,
    },
    phase: 'module-mining',
    severity: 'success',
    summary: `moduleMining produced ${newRecipes} source-ref-backed recipe(s).`,
    title: 'ModuleMining result accounting completed',
  });

  return {
    ...asRecord(result),
    asyncFill: false,
    moduleMining: {
      moduleCount: selectedModules.length,
      newRecipes,
      persistedNewRecipes: persistedOutputDelta.recipeIds.length,
      persistedSourceRefCount: persistedOutputDelta.sourceRefCount,
      reportedNewRecipes,
      scaleCap,
    },
    planSelectionProjection: planGate.projection,
  };
}

async function readModuleMiningPersistenceSnapshot(
  options: Pick<RunDaemonJobOptions, 'container' | 'jobId' | 'logger'>
): Promise<ModuleMiningPersistenceSnapshot | null> {
  const knowledgeRepository = getOptionalService<ModuleMiningKnowledgeRepositoryLike>(
    options.container,
    'knowledgeRepository'
  );
  const sourceRefRepository = getOptionalService<ModuleMiningSourceRefRepositoryLike>(
    options.container,
    'recipeSourceRefRepository'
  );
  if (!knowledgeRepository || !sourceRefRepository) {
    options.logger.warn(
      'ModuleMining persisted-output accounting skipped: repositories unavailable',
      {
        hasKnowledgeRepository: Boolean(knowledgeRepository),
        hasSourceRefRepository: Boolean(sourceRefRepository),
        jobId: options.jobId,
        stage: 'module-mining-result-accounting',
      }
    );
    return null;
  }

  try {
    const recipeIds = new Set(
      (await listModuleMiningKnowledgeEntries(knowledgeRepository))
        .map((entry) => recipeIdFromUnknown(entry))
        .filter((id): id is string => Boolean(id))
    );
    return {
      recipeIds,
      sourceRefCountByRecipeId: countSourceRefsByRecipeId(sourceRefRepository.findAll?.() ?? []),
    };
  } catch (err: unknown) {
    options.logger.warn('ModuleMining persisted-output accounting snapshot failed', {
      error: err instanceof Error ? err.message : String(err),
      jobId: options.jobId,
      stage: 'module-mining-result-accounting',
    });
    return null;
  }
}

async function readModuleMiningPersistedOutputDelta(
  options: Pick<RunDaemonJobOptions, 'container' | 'jobId' | 'logger'>,
  before: ModuleMiningPersistenceSnapshot | null
): Promise<ModuleMiningPersistedOutputDelta> {
  if (!before) {
    return { recipeIds: [], sourceRefCount: 0 };
  }

  const after = await readModuleMiningPersistenceSnapshot(options);
  if (!after) {
    return { recipeIds: [], sourceRefCount: 0 };
  }

  const recipeIds = [...after.recipeIds]
    .filter((recipeId) => !before.recipeIds.has(recipeId))
    .filter((recipeId) => (after.sourceRefCountByRecipeId.get(recipeId) ?? 0) > 0)
    .sort();
  const sourceRefCount = recipeIds.reduce(
    (total, recipeId) => total + (after.sourceRefCountByRecipeId.get(recipeId) ?? 0),
    0
  );

  return { recipeIds, sourceRefCount };
}

async function listModuleMiningKnowledgeEntries(
  repository: ModuleMiningKnowledgeRepositoryLike
): Promise<readonly unknown[]> {
  if (repository.findWithPagination) {
    const result = await repository.findWithPagination(
      {},
      { order: 'ASC', orderBy: 'createdAt', page: 1, pageSize: 50_000 }
    );
    if (Array.isArray(result.data)) {
      return result.data;
    }
  }
  if (repository.findAllByLifecycles) {
    return repository.findAllByLifecycles([
      'active',
      'decaying',
      'deprecated',
      'observing',
      'pending',
      'staging',
    ]);
  }
  return [];
}

function countSourceRefsByRecipeId(sourceRefs: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ref of sourceRefs) {
    const record = asRecord(ref);
    const recipeId = stringValue(record.recipeId) ?? stringValue(record.recipe_id);
    const sourcePath = stringValue(record.sourcePath) ?? stringValue(record.source_path);
    const status = stringValue(record.status) ?? 'active';
    if (!recipeId || !sourcePath || status === 'stale') {
      continue;
    }
    counts.set(recipeId, (counts.get(recipeId) ?? 0) + 1);
  }
  return counts;
}

function recipeIdFromUnknown(entry: unknown): string | null {
  const record = asRecord(entry);
  const directId = stringValue(record.id);
  if (directId) {
    return directId;
  }
  const json = typeof record.toJSON === 'function' ? record.toJSON() : null;
  return stringValue(asRecord(json).id) ?? null;
}

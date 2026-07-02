import type { AgentService } from '@alembic/agent/service';
import { getJobProcessEventRecorder } from '../../daemon/DaemonJobServices.js';
import {
  asRecord,
  extractNewRecipesThisRound,
  positiveIntegerArg,
  recordJobProcessEvent,
} from '../../daemon/DaemonJobWorkflowHelpers.js';
import type { RunDaemonJobOptions } from '../../daemon/DaemonJobWorkflowTypes.js';
import {
  readModuleMiningSourceRefDelta,
  readModuleMiningSourceRefSnapshot,
  toModuleMiningSelectedModulePayloads,
  writeModuleMiningCoverageLedger,
} from '../../shared/ModuleMiningEvidence.js';
import { runPlanSelectionGate } from '../plan/PlanSelectionGate.js';
import { selectScopedModuleMiningModules } from './ModuleMiningSelection.js';

export async function runModuleMiningWorkflow(options: RunDaemonJobOptions): Promise<unknown> {
  const planGate = await runPlanSelectionGate(options, {
    generationStage: 'moduleMining',
    label: 'ModuleMining',
    source: 'alembic-main-rescan',
  });
  const modules = selectScopedModuleMiningModules({
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
  const selectedModulePayloads = toModuleMiningSelectedModulePayloads(selectedModules);

  const sourceRefSnapshotBefore = readModuleMiningSourceRefSnapshot(options.container);
  const { runModuleMining } = await import('@alembic/agent/service');
  const result = await runModuleMining({
    agentService: options.container.get('agentService') as Pick<AgentService, 'run'>,
    budget: { ...planGate.projection.budget },
    modules: selectedModules,
    projectFacts: planGate.projectContextFacts,
    scaleCap,
  });
  const reportedNewRecipes = extractNewRecipesThisRound(result);
  const persistedOutputDelta = readModuleMiningSourceRefDelta(
    options.container,
    sourceRefSnapshotBefore
  );
  const projectRoot = stringValueFromUnknown(
    (planGate.projectContextFacts as { projectRoot?: unknown }).projectRoot
  );
  const coverageLedger = writeModuleMiningCoverageLedger({
    container: options.container,
    logger: options.logger,
    projectRoot,
    selectedModules,
    sourceRefPaths: persistedOutputDelta.sourceRefPaths,
  });
  const newRecipes = Math.max(reportedNewRecipes, persistedOutputDelta.recipeIds.length);
  if (newRecipes <= 0) {
    throw new Error('moduleMining produced zero recipes.');
  }

  options.logger.info('ModuleMining result accounting completed', {
    jobId: options.jobId,
    persistedNewRecipes: persistedOutputDelta.recipeIds.length,
    persistedSourceRefCount: persistedOutputDelta.sourceRefCount,
    reportedNewRecipes,
    selectedModules: selectedModulePayloads,
    stage: 'module-mining-result-accounting',
  });
  recordJobProcessEvent(getJobProcessEventRecorder(options.container), {
    content: {
      mimeType: 'application/json',
      role: 'assistant',
      text: JSON.stringify(
        {
          coverageLedger,
          selectedModules: selectedModulePayloads,
        },
        null,
        2
      ),
    },
    jobId: options.jobId,
    kind: 'checkpoint',
    metadata: {
      coverageLedger,
      persistedNewRecipes: persistedOutputDelta.recipeIds.length,
      persistedRecipeIds: persistedOutputDelta.recipeIds.slice(0, 25),
      persistedSourceRefCount: persistedOutputDelta.sourceRefCount,
      reportedNewRecipes,
      selectedModules: selectedModulePayloads,
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
      coverageLedger,
      moduleCount: selectedModules.length,
      newRecipes,
      persistedNewRecipes: persistedOutputDelta.recipeIds.length,
      persistedSourceRefCount: persistedOutputDelta.sourceRefCount,
      reportedNewRecipes,
      scaleCap,
      selectedModules: selectedModulePayloads,
      sourceRefPaths: persistedOutputDelta.sourceRefPaths,
    },
    planSelectionProjection: planGate.projection,
  };
}

function stringValueFromUnknown(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

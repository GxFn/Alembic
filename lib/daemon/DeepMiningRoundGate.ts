import { adviseCoverageLedger } from '@alembic/core/host-agent-workflows';
import type { PlanModuleBinding, PlanSelection } from '@alembic/core/plans';
import type {
  DeepMiningRoundRecord,
  EvolutionCoverageLedgerRepository,
} from '@alembic/core/repositories';
import { resolveProjectScopeAnalysisContext } from '../project-scope/ProjectScopeAnalysis.js';
import { getJobProcessEventRecorder } from './DaemonJobServices.js';
import {
  buildDaemonRescanWorkflowArgs,
  extractNewRecipesThisRound,
  firstPositiveIntegerArg,
  getOptionalService,
  nonNegativeNumber,
  positiveIntegerArg,
  recordJobProcessEvent,
  unwrapEnvelope,
} from './DaemonJobWorkflowHelpers.js';
import type {
  BootstrapPlanGateResult,
  DeepMiningRoundPlanContext,
  ModuleDimensionTarget,
  RunDaemonJobOptions,
} from './DaemonJobWorkflowTypes.js';
import { runPlanSelectionGate } from './PlanSelectionGate.js';

export async function runDeepMiningRounds(options: RunDaemonJobOptions): Promise<unknown> {
  const coverageLedgerRepository = getOptionalService<EvolutionCoverageLedgerRepository>(
    options.container,
    'coverageLedgerRepository'
  );
  if (!coverageLedgerRepository) {
    throw new Error('Coverage ledger repository is required for deepMining.');
  }

  const { runProjectIndexWorkflow } = await import(
    '../workflows/project-index/ProjectIndexWorkflow.js'
  );
  const analysisScope = resolveProjectScopeAnalysisContext(options.container);
  const projectRoot = analysisScope.projectRoot;

  const rounds: Array<Record<string, unknown>> = [];
  let latestRound = latestDeepMiningRound(
    coverageLedgerRepository.listRoundsByProjectRoot(projectRoot)
  );
  let advisor: ReturnType<typeof adviseCoverageLedger> | null = null;
  let latestPlanGate: BootstrapPlanGateResult | null = null;
  let latestModuleCount = 1;

  while (true) {
    const planGate = await runPlanSelectionGate(options, {
      generationStage: 'deepMining',
      label: 'DeepMining',
      source: 'alembic-main-rescan',
    });
    latestPlanGate = planGate;
    const planContext = buildDeepMiningRoundPlanContext(planGate);
    latestModuleCount = planContext.moduleCount;

    ensureCoverageLedgerCells({
      projectRoot,
      repository: coverageLedgerRepository,
      targets: planContext.moduleDimensionTargets,
    });

    advisor = adviseCoverageLedger({
      cells: coverageLedgerRepository.listByProjectRoot(projectRoot),
      latestRound,
      moduleCount: planContext.moduleCount,
      planK: planContext.planK,
      planMaxRounds: planContext.planMaxRounds,
    });
    if (advisor.shouldStop) {
      break;
    }

    const roundIndex = (latestRound?.roundIndex ?? 0) + 1;
    const rescanId = `${options.jobId}:deepMining:${roundIndex}`;
    const startedAt = Date.now();
    coverageLedgerRepository.upsertRound({
      projectRoot,
      rescanId,
      roundIndex,
      startedAt,
      triggerActor: 'daemon-job-runner',
    });

    const raw = await runProjectIndexWorkflow(
      { container: options.container, logger: options.logger },
      buildDaemonRescanWorkflowArgs({
        args: {
          ...options.args,
          contentMaxLines: planGate.projection.budget.contentMaxLines,
          dimensions: planGate.projection.executionDimensions,
          generationStage: 'deepMining',
          internalExecution: { runAsyncFillInline: true },
          maxFiles: planGate.projection.budget.maxFiles,
          miningMode: 'deepMining',
          moduleDimensionTargets: planContext.moduleDimensionTargets,
          moduleScope: planGate.projection.moduleScope,
          perDimensionTargets: planContext.perDimensionTargets,
          reason: `${options.source || 'daemon'}-deepMining-round-${roundIndex}`,
          roundIndex,
        },
        source: options.source,
      }),
      { mode: 'incremental' }
    );
    const result = unwrapEnvelope(raw);
    const newRecipesThisRound = extractNewRecipesThisRound(result);
    latestRound = coverageLedgerRepository.upsertRound({
      completedAt: Date.now(),
      newRecipesThisRound,
      projectRoot,
      rescanId,
      roundIndex,
      startedAt,
      triggerActor: 'daemon-job-runner',
    });
    advisor = adviseCoverageLedger({
      cells: coverageLedgerRepository.listByProjectRoot(projectRoot),
      latestRound,
      moduleCount: planContext.moduleCount,
      planK: planContext.planK,
      planMaxRounds: planContext.planMaxRounds,
    });
    rounds.push({
      newRecipesThisRound,
      rescanId,
      roundIndex,
      stopReasonAfterRound: advisor.stopReason,
    });
    recordJobProcessEvent(getJobProcessEventRecorder(options.container), {
      jobId: options.jobId,
      kind: 'checkpoint',
      metadata: {
        advisor,
        newRecipesThisRound,
        rescanId,
        roundIndex,
      },
      phase: 'deep-mining',
      severity: advisor.shouldStop ? 'success' : 'info',
      summary: `deepMining round ${roundIndex} produced ${newRecipesThisRound} new recipe(s).`,
      title: 'DeepMining round completed',
    });
    if (advisor.shouldStop) {
      break;
    }
  }

  if (!advisor || !latestPlanGate) {
    throw new Error('deepMining plan gate did not produce an advisor decision.');
  }

  return {
    asyncFill: false,
    deepMining: {
      advisor,
      moduleCount: latestModuleCount,
      rounds,
      stopReason: advisor.stopReason,
    },
    planSelectionProjection: latestPlanGate.projection,
    status: 'complete',
  };
}

function buildPlanPerDimensionTargets(selection: PlanSelection): Record<string, number> {
  const targets: Record<string, number> = {};
  for (const binding of selection.moduleBindings) {
    const targetRecipes = nonNegativeNumber(binding.targetRecipes);
    if (targetRecipes === null) {
      continue;
    }
    for (const dimensionId of binding.dimensions) {
      targets[dimensionId] = Math.max(targets[dimensionId] ?? 0, targetRecipes);
    }
  }
  return targets;
}

function buildPlanModuleDimensionTargets(selection: PlanSelection): ModuleDimensionTarget[] {
  return selection.moduleBindings.flatMap((binding) => {
    const targetRecipes = nonNegativeNumber(binding.targetRecipes);
    if (targetRecipes === null) {
      return [];
    }
    return binding.dimensions.map((dimensionId) => ({
      dimensionId,
      moduleId: binding.moduleId || binding.modulePath,
      moduleName: moduleNameFromBinding(binding),
      targetRecipes,
    }));
  });
}

function buildDeepMiningRoundPlanContext(
  planGate: BootstrapPlanGateResult
): DeepMiningRoundPlanContext {
  const moduleDimensionTargets = buildPlanModuleDimensionTargets(planGate.selection);
  if (moduleDimensionTargets.length === 0) {
    throw new Error('deepMining requires plan moduleBindings with module×dimension targets.');
  }

  const scale = planGate.selection.scale as Record<string, unknown>;
  return {
    moduleCount: Math.max(
      1,
      planGate.projectContextFacts.projectMapModules.length ||
        planGate.projectContextFacts.moduleCount ||
        planGate.projection.moduleScope.length ||
        1
    ),
    moduleDimensionTargets,
    perDimensionTargets: buildPlanPerDimensionTargets(planGate.selection),
    // Core 目前没有把 K/maxRounds 放进 typed PlanSelection.scale；若运行时 plan 显式给出就消费，
    // 否则保持 undefined，让 CoverageLedgerAdvisor 使用 D2 默认表。
    planK: firstPositiveIntegerArg(scale.k, scale.minNewRecipes),
    planMaxRounds: positiveIntegerArg(scale.maxRounds),
  };
}

function moduleNameFromBinding(binding: PlanModuleBinding): string {
  return (
    binding.modulePath.split('/').filter(Boolean).at(-1) || binding.moduleId || binding.modulePath
  );
}

function ensureCoverageLedgerCells(input: {
  projectRoot: string;
  repository: EvolutionCoverageLedgerRepository;
  targets: readonly ModuleDimensionTarget[];
}): void {
  for (const target of input.targets) {
    const moduleId = target.moduleId || target.moduleName;
    if (!moduleId) {
      continue;
    }
    const existing = input.repository.getCell({
      dimensionId: target.dimensionId,
      moduleId,
      projectRoot: input.projectRoot,
    });
    if (existing) {
      continue;
    }
    input.repository.upsertCell({
      coveredCount: 0,
      dimensionId: target.dimensionId,
      grade: 'empty',
      moduleId,
      projectRoot: input.projectRoot,
      totalCandidateCount: target.targetRecipes,
    });
  }
}

function latestDeepMiningRound(
  rounds: readonly DeepMiningRoundRecord[]
): DeepMiningRoundRecord | null {
  return [...rounds].sort((left, right) => right.roundIndex - left.roundIndex)[0] ?? null;
}

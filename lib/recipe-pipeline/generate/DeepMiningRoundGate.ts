import { basename } from 'node:path';
import { adviseCoverageLedger } from '@alembic/core/host-agent-workflows';
import type { PlanModuleBinding, PlanSelection } from '@alembic/core/plans';
import type {
  CoverageLedgerRecord,
  DeepMiningRoundRecord,
  EvolutionCoverageLedgerRepository,
} from '@alembic/core/repositories';
import { getJobProcessEventRecorder } from '../../daemon/DaemonJobServices.js';
import {
  buildDaemonRescanWorkflowArgs,
  extractNewRecipesThisRound,
  firstPositiveIntegerArg,
  getOptionalService,
  nonNegativeNumber,
  positiveIntegerArg,
  recordJobProcessEvent,
  unwrapEnvelope,
} from '../../daemon/DaemonJobWorkflowHelpers.js';
import type {
  DeepMiningRoundPlanContext,
  GeneratePlanGateResult,
  ModuleDimensionTarget,
  RunDaemonJobOptions,
} from '../../daemon/DaemonJobWorkflowTypes.js';
import { resolveProjectScopeAnalysisContext } from '../../project-scope/ProjectScopeAnalysis.js';
import { runPlanSelectionGate } from '../plan/PlanSelectionGate.js';

export async function runDeepMiningRounds(options: RunDaemonJobOptions): Promise<unknown> {
  const coverageLedgerRepository = getOptionalService<EvolutionCoverageLedgerRepository>(
    options.container,
    'coverageLedgerRepository'
  );
  if (!coverageLedgerRepository) {
    throw new Error('Coverage ledger repository is required for deepMining.');
  }

  const { runGenerateWorkflow } = await import('./GenerateWorkflow.js');
  const analysisScope = resolveProjectScopeAnalysisContext(options.container);
  const projectRoot = analysisScope.projectRoot;

  const rounds: Array<Record<string, unknown>> = [];
  let latestRound = latestDeepMiningRound(
    coverageLedgerRepository.listRoundsByProjectRoot(projectRoot)
  );
  let advisor: ReturnType<typeof adviseCoverageLedger> | null = null;
  let latestPlanGate: GeneratePlanGateResult | null = null;
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

    let raw: unknown;
    try {
      raw = await runGenerateWorkflow(
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
    } catch (err: unknown) {
      failCloseDeepMiningRound({
        error: err,
        options,
        projectRoot,
        repository: coverageLedgerRepository,
        rescanId,
        roundIndex,
        startedAt,
      });
      throw err;
    }
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

  const coverageLedgerSeed = buildCoverageLedgerSeed(
    coverageLedgerRepository.listByProjectRoot(projectRoot),
    { projectRoot }
  );
  recordCoverageLedgerSeedEvent({ coverageLedgerSeed, options });
  options.logger.info('DeepMining coverage ledger seed retained', {
    coverageLedgerSeed,
    jobId: options.jobId,
    stage: 'deep-mining-coverage-ledger-seed',
  });

  return {
    asyncFill: false,
    coverageLedgerSeed,
    deepMining: {
      advisor,
      coverageLedgerSeed,
      moduleCount: latestModuleCount,
      rounds,
      stopReason: advisor.stopReason,
    },
    planSelectionProjection: latestPlanGate.projection,
    status: 'complete',
  };
}

interface CoverageLedgerSeedSummary {
  aggregateOrRootModuleIds: string[];
  coveredPathCount: number;
  dimensionIds: string[];
  measuredCells: number;
  moduleCount: number;
  reason?: 'aggregate-or-root-only' | 'no-coverage-ledger-cells' | 'no-target-scoped-cells';
  status: 'skipped' | 'written';
  targetScopedCells: number;
  usableCells: number;
  writtenCells: number;
}

function buildCoverageLedgerSeed(
  cells: readonly CoverageLedgerRecord[],
  options: { projectRoot: string }
): CoverageLedgerSeedSummary {
  const writtenCells = cells.length;
  const aggregateOrRootModuleIds = uniqueSortedStrings(
    cells
      .map((cell) => cell.moduleId)
      .filter((moduleId) => isAggregateOrRootModuleId(moduleId, options))
  );
  const usableCells = cells.filter((cell) => isTargetScopedCoverageCell(cell, options));
  const measuredCells = usableCells.filter(isMeasuredCoverageCell);
  const dimensionIds = uniqueSortedStrings(usableCells.map((cell) => cell.dimensionId));
  const moduleIds = uniqueSortedStrings(usableCells.map((cell) => cell.moduleId));
  const coveredPathCount = uniqueSortedStrings(
    usableCells.flatMap((cell) =>
      Array.isArray(cell.coveredSourceRefs) ? cell.coveredSourceRefs : []
    )
  ).length;
  const targetScopedCells = usableCells.length;
  const reason =
    targetScopedCells > 0
      ? undefined
      : writtenCells === 0
        ? 'no-coverage-ledger-cells'
        : aggregateOrRootModuleIds.length === writtenCells
          ? 'aggregate-or-root-only'
          : 'no-target-scoped-cells';

  return {
    aggregateOrRootModuleIds,
    coveredPathCount,
    dimensionIds,
    measuredCells: measuredCells.length,
    moduleCount: moduleIds.length,
    ...(reason ? { reason } : {}),
    status: targetScopedCells > 0 ? 'written' : 'skipped',
    targetScopedCells,
    usableCells: targetScopedCells,
    writtenCells,
  };
}

function recordCoverageLedgerSeedEvent(input: {
  coverageLedgerSeed: CoverageLedgerSeedSummary;
  options: RunDaemonJobOptions;
}): void {
  recordJobProcessEvent(getJobProcessEventRecorder(input.options.container), {
    content: {
      mimeType: 'application/json',
      role: 'assistant',
      text: JSON.stringify({ coverageLedgerSeed: input.coverageLedgerSeed }, null, 2),
    },
    jobId: input.options.jobId,
    kind: 'summary',
    metadata: {
      coverageLedgerSeed: input.coverageLedgerSeed,
      source: input.options.source || 'system',
    },
    phase: 'deep-mining',
    severity: input.coverageLedgerSeed.status === 'written' ? 'success' : 'warning',
    summary:
      input.coverageLedgerSeed.status === 'written'
        ? `coverageLedgerSeed retained with ${input.coverageLedgerSeed.usableCells} usable target-scoped cell(s) and ${input.coverageLedgerSeed.measuredCells} measured cell(s).`
        : `coverageLedgerSeed skipped: ${input.coverageLedgerSeed.reason ?? 'unusable coverage ledger'}.`,
    title: 'DeepMining coverage ledger seed retained',
  });
}

function isTargetScopedCoverageCell(
  cell: CoverageLedgerRecord,
  options: { projectRoot: string }
): boolean {
  return (
    isTargetScopedModuleId(cell.moduleId, options) &&
    !isAggregateOrRootModuleId(cell.moduleId, options)
  );
}

function isTargetScopedModuleId(moduleId: string, options: { projectRoot: string }): boolean {
  const normalized = moduleId.trim();
  if (!normalized.startsWith('target:')) {
    return false;
  }
  const [, targetName, ...pathParts] = normalized.split(':');
  const modulePath = pathParts.join(':').trim();
  if (!targetName?.trim()) {
    return false;
  }
  if (modulePath && modulePath !== '.' && modulePath !== '/') {
    return true;
  }
  // BiliDili exposes real package targets such as target:Account:. at the package root.
  // Only the project-root target itself is an aggregate/root cell.
  return !isProjectRootTargetName(targetName, options.projectRoot);
}

function isAggregateOrRootModuleId(moduleId: string, options: { projectRoot: string }): boolean {
  const normalized = moduleId.trim();
  if (!normalized) {
    return true;
  }
  const lowered = normalized.toLowerCase();
  if (
    lowered === '.' ||
    lowered === '/' ||
    lowered === '*' ||
    lowered === 'all' ||
    lowered === 'aggregate' ||
    lowered === 'project' ||
    lowered === 'project-root' ||
    lowered === 'root' ||
    lowered === 'workspace-root' ||
    lowered.startsWith('aggregate:') ||
    lowered.startsWith('root:')
  ) {
    return true;
  }
  if (normalized.startsWith('target:')) {
    const [, targetName, ...pathParts] = normalized.split(':');
    const modulePath = pathParts.join(':').trim();
    if (modulePath && modulePath !== '.' && modulePath !== '/') {
      return false;
    }
    return isProjectRootTargetName(targetName, options.projectRoot);
  }
  return false;
}

function isProjectRootTargetName(targetName: string | undefined, projectRoot: string): boolean {
  const normalizedTargetName = targetName?.trim();
  if (!normalizedTargetName) {
    return true;
  }
  const projectRootName = basename(projectRoot).trim();
  return Boolean(projectRootName && normalizedTargetName === projectRootName);
}

function isMeasuredCoverageCell(cell: CoverageLedgerRecord): boolean {
  const coveredSourceRefs = Array.isArray(cell.coveredSourceRefs) ? cell.coveredSourceRefs : [];
  return (
    cell.coveredCount > 0 ||
    coveredSourceRefs.length > 0 ||
    cell.grade === 'covered' ||
    cell.grade === 'partial'
  );
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
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
  planGate: GeneratePlanGateResult
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

function failCloseDeepMiningRound(input: {
  error: unknown;
  options: RunDaemonJobOptions;
  projectRoot: string;
  repository: EvolutionCoverageLedgerRepository;
  rescanId: string;
  roundIndex: number;
  startedAt: number;
}): void {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const completedAt = Date.now();
  try {
    input.repository.upsertRound({
      completedAt,
      newRecipesThisRound: 0,
      projectRoot: input.projectRoot,
      rescanId: input.rescanId,
      roundIndex: input.roundIndex,
      startedAt: input.startedAt,
      triggerActor: 'daemon-job-runner',
    });
  } catch (closeErr: unknown) {
    input.options.logger.error('DeepMining round failed and fail-closed persistence failed', {
      closeError: closeErr instanceof Error ? closeErr.message : String(closeErr),
      error: message,
      jobId: input.options.jobId,
      rescanId: input.rescanId,
      roundIndex: input.roundIndex,
      stage: 'deep-mining-round-fail-close',
    });
    return;
  }

  input.options.logger.warn('DeepMining round failed after opening; marked round closed', {
    error: message,
    jobId: input.options.jobId,
    rescanId: input.rescanId,
    roundIndex: input.roundIndex,
    stage: 'deep-mining-round-fail-closed',
  });
  recordJobProcessEvent(getJobProcessEventRecorder(input.options.container), {
    content: {
      mimeType: 'text/plain',
      role: 'assistant',
      text: message,
    },
    jobId: input.options.jobId,
    kind: 'error',
    metadata: {
      completedAt,
      rescanId: input.rescanId,
      roundIndex: input.roundIndex,
      source: input.options.source || 'system',
    },
    phase: 'deep-mining',
    severity: 'error',
    summary: `deepMining round ${input.roundIndex} failed after opening; row was closed with 0 new recipe(s): ${message}`,
    title: 'DeepMining round failed closed',
  });
}

function latestDeepMiningRound(
  rounds: readonly DeepMiningRoundRecord[]
): DeepMiningRoundRecord | null {
  return [...rounds].sort((left, right) => right.roundIndex - left.roundIndex)[0] ?? null;
}

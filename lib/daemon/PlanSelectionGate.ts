import path from 'node:path';
import type { AgentService } from '@alembic/agent/service';
import {
  applyPlanSelection,
  assertPlanSelectionStageRequirements,
  type PlanModuleBinding,
  type PlanSelection,
  type PlanStageId,
} from '@alembic/core/plans';
import { resolveProjectScopeAnalysisContext } from '../project-scope/ProjectScopeAnalysis.js';
import { buildProjectContextWorkflowFacts } from '../workflows/project-context/ProjectContextWorkflowFacts.js';
import { getJobProcessEventRecorder } from './DaemonJobServices.js';
import {
  numberArg,
  positiveIntegerArg,
  recordJobProcessEvent,
  stringArrayArg,
} from './DaemonJobWorkflowHelpers.js';
import type { BootstrapPlanGateResult, RunDaemonJobOptions } from './DaemonJobWorkflowTypes.js';

export async function runBootstrapPlanGate(
  options: RunDaemonJobOptions
): Promise<BootstrapPlanGateResult> {
  return runPlanSelectionGate(options, {
    generationStage: 'coldStart',
    label: 'Bootstrap',
    source: 'alembic-main-bootstrap',
  });
}

export async function runPlanSelectionGate(
  options: RunDaemonJobOptions,
  gate: {
    generationStage: PlanStageId;
    label: string;
    source: 'alembic-main-bootstrap' | 'alembic-main-rescan';
  }
): Promise<BootstrapPlanGateResult> {
  const recorder = getJobProcessEventRecorder(options.container);
  const maxFiles = numberArg(options.args?.maxFiles, 500);
  const contentMaxLines = numberArg(options.args?.contentMaxLines, 120);
  const eventTitlePrefix = `${gate.label} plan gate`;

  try {
    const analysisScope = resolveProjectScopeAnalysisContext(options.container);
    const projectContextFacts = await buildProjectContextWorkflowFacts({
      analysisScope,
      contentMaxLines,
      ctx: { container: options.container, logger: options.logger },
      maxFiles,
      projectRoot: analysisScope.projectRoot,
      source: gate.source,
    });
    const { runPlanAgent } = await import('@alembic/agent/service');
    const rawSelection = await runPlanAgent({
      agentService: options.container.get('agentService') as Pick<AgentService, 'run'>,
      generationStage: gate.generationStage,
      projectContextFacts,
    });
    const { requestConstraints, selection } = constrainPlanSelectionForGate({
      args: options.args,
      gateStage: gate.generationStage,
      projectRoot: analysisScope.projectRoot,
      selection: rawSelection,
    });

    // 主仓库执行边界复用 Core 阶段约束，避免 deepMining/moduleMining 空模块目标先报 gate 成功。
    assertPlanSelectionStageRequirements(selection, { expectedStage: gate.generationStage });

    const projection = applyPlanSelection(selection);

    if (projection.executionDimensions.length === 0) {
      throw new Error(`Plan agent returned no executable dimensions for ${gate.generationStage}.`);
    }

    options.logger.info(`${eventTitlePrefix} completed`, {
      budget: projection.budget,
      executionDimensions: projection.executionDimensions,
      jobId: options.jobId,
      moduleScope: projection.moduleScope,
      requestConstraints,
      stage: `${gate.generationStage}-plan-gate`,
      unknownDimensionIds: projection.unknownDimensionIds ?? [],
    });
    recordJobProcessEvent(recorder, {
      jobId: options.jobId,
      kind: 'checkpoint',
      metadata: {
        budget: projection.budget,
        executionDimensions: projection.executionDimensions,
        generationStage: gate.generationStage,
        moduleScope: projection.moduleScope,
        requestConstraints,
        source: options.source || 'system',
        unknownDimensionIds: projection.unknownDimensionIds ?? [],
      },
      phase: 'plan-gate',
      severity: 'success',
      summary: `Plan agent selected ${projection.executionDimensions.length} ${gate.generationStage} dimension(s).`,
      title: `${eventTitlePrefix} completed`,
    });

    return { projectContextFacts, projection, selection };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    options.logger.error(`${eventTitlePrefix} failed; aborting ${gate.generationStage} job`, {
      error: message,
      generationStage: gate.generationStage,
      jobId: options.jobId,
      stage: `${gate.generationStage}-plan-gate`,
    });
    recordJobProcessEvent(recorder, {
      content: {
        mimeType: 'text/plain',
        role: 'assistant',
        text: `${eventTitlePrefix} failed before ${gate.generationStage}: ${message}`,
      },
      jobId: options.jobId,
      kind: 'error',
      metadata: {
        generationStage: gate.generationStage,
        source: options.source || 'system',
      },
      phase: 'plan-gate',
      severity: 'error',
      summary: `${eventTitlePrefix} failed before ${gate.generationStage}: ${message}`,
      title: `${eventTitlePrefix} failed`,
    });
    throw new Error(`${eventTitlePrefix} failed: ${message}`);
  }
}

interface PlanSelectionRequestConstraints {
  contentMaxLines?: number;
  dimensionIds: string[];
  maxFiles?: number;
  maxRounds?: number;
  minNewRecipes?: number;
  moduleScope: string[];
  scaleCap?: number;
}

function constrainPlanSelectionForGate(input: {
  args?: Record<string, unknown>;
  gateStage: PlanStageId;
  projectRoot: string;
  selection: PlanSelection;
}): { requestConstraints: Record<string, unknown> | null; selection: PlanSelection } {
  if (input.gateStage !== 'deepMining') {
    return { requestConstraints: null, selection: input.selection };
  }

  const constraints = readPlanSelectionRequestConstraints(input.args);
  if (!hasDeepMiningRequestConstraint(constraints)) {
    return { requestConstraints: null, selection: input.selection };
  }

  return {
    requestConstraints: serializePlanSelectionRequestConstraints(constraints),
    selection: applyDeepMiningRequestConstraints(input.selection, constraints, {
      projectRoot: input.projectRoot,
    }),
  };
}

function readPlanSelectionRequestConstraints(
  args: Record<string, unknown> | undefined
): PlanSelectionRequestConstraints {
  return {
    contentMaxLines: positiveIntegerArg(args?.contentMaxLines),
    dimensionIds: stringArrayArg(args?.dimensions) ?? [],
    maxFiles: positiveIntegerArg(args?.maxFiles),
    maxRounds: positiveIntegerArg(args?.maxRounds),
    minNewRecipes: positiveIntegerArg(args?.minNewRecipes),
    moduleScope: stringArrayArg(args?.moduleScope) ?? [],
    scaleCap: positiveIntegerArg(args?.scaleCap),
  };
}

function hasDeepMiningRequestConstraint(constraints: PlanSelectionRequestConstraints): boolean {
  return (
    constraints.dimensionIds.length > 0 ||
    constraints.moduleScope.length > 0 ||
    constraints.scaleCap !== undefined ||
    constraints.maxFiles !== undefined ||
    constraints.contentMaxLines !== undefined
  );
}

function applyDeepMiningRequestConstraints(
  selection: PlanSelection,
  constraints: PlanSelectionRequestConstraints,
  context: PlanSelectionConstraintContext
): PlanSelection {
  const requestedDimensions = new Set(constraints.dimensionIds);
  let moduleBindings = selection.moduleBindings.map((binding) =>
    requestedDimensions.size > 0
      ? { ...binding, dimensions: binding.dimensions.filter((id) => requestedDimensions.has(id)) }
      : binding
  );

  if (requestedDimensions.size > 0) {
    const missingDimensions = constraints.dimensionIds.filter(
      (id) => !selection.dimensions.includes(id)
    );
    if (missingDimensions.length > 0) {
      throw new Error(
        `DeepMining plan gate did not select requested dimension(s): ${missingDimensions.join(', ')}`
      );
    }
    moduleBindings = moduleBindings.filter((binding) => binding.dimensions.length > 0);
  }

  if (constraints.moduleScope.length > 0) {
    const candidatesBeforeModuleScope = moduleBindings;
    moduleBindings = moduleBindings.filter((binding) =>
      planModuleBindingMatchesScope(binding, constraints.moduleScope, context)
    );
    if (moduleBindings.length === 0) {
      throw new Error(
        formatModuleScopeConstraintMiss(
          constraints.moduleScope,
          candidatesBeforeModuleScope,
          context
        )
      );
    }
  }

  if (constraints.scaleCap !== undefined) {
    moduleBindings = moduleBindings.slice(0, constraints.scaleCap);
  }

  if (moduleBindings.length === 0) {
    throw new Error('DeepMining request constraints removed all module×dimension targets.');
  }

  const constrainedDimensions =
    requestedDimensions.size > 0 ||
    constraints.moduleScope.length > 0 ||
    constraints.scaleCap !== undefined
      ? uniqueStrings(moduleBindings.flatMap((binding) => [...binding.dimensions]))
      : uniqueStrings(selection.dimensions);
  if (constrainedDimensions.length === 0) {
    throw new Error('DeepMining request constraints removed all executable dimensions.');
  }

  const scale = { ...selection.scale } as PlanSelection['scale'] & Record<string, unknown>;
  if (constraints.maxFiles !== undefined) {
    scale.maxFiles = constraints.maxFiles;
  }
  if (constraints.contentMaxLines !== undefined) {
    scale.contentMaxLines = constraints.contentMaxLines;
  }
  if (constraints.scaleCap !== undefined) {
    scale.totalRecipeBudget = constraints.scaleCap;
  }
  if (constraints.maxRounds !== undefined && scale.maxRounds === undefined) {
    scale.maxRounds = constraints.maxRounds;
  }
  if (
    constraints.minNewRecipes !== undefined &&
    scale.k === undefined &&
    scale.minNewRecipes === undefined
  ) {
    scale.minNewRecipes = constraints.minNewRecipes;
  }

  return {
    ...selection,
    dimensions: constrainedDimensions,
    moduleBindings,
    scale,
  };
}

interface PlanSelectionConstraintContext {
  projectRoot: string;
}

function planModuleBindingMatchesScope(
  binding: PlanModuleBinding,
  moduleScope: readonly string[],
  context: PlanSelectionConstraintContext
): boolean {
  const requestedScope = new Set(normalizeScopeValues(moduleScope));
  return moduleBindingScopeAliases(binding, context).some((alias) => requestedScope.has(alias));
}

function formatModuleScopeConstraintMiss(
  moduleScope: readonly string[],
  moduleBindings: readonly PlanModuleBinding[],
  context: PlanSelectionConstraintContext
): string {
  const requested = normalizeScopeValues(moduleScope);
  const availableAliases = uniqueStrings(
    moduleBindings.flatMap((binding) => moduleBindingScopeAliases(binding, context))
  ).slice(0, 20);
  return [
    'DeepMining request constraints removed all module×dimension targets',
    `moduleScope=${requested.length > 0 ? requested.join(', ') : '(empty)'}`,
    `availableModuleAliases=${availableAliases.length > 0 ? availableAliases.join(', ') : '(none)'}`,
  ].join('; ');
}

function normalizeScopeValues(values: readonly string[]): string[] {
  return uniqueStrings(values.flatMap((value) => scopeValueAliases(value)));
}

function moduleBindingScopeAliases(
  binding: PlanModuleBinding,
  context: PlanSelectionConstraintContext
): string[] {
  const record = binding as unknown as Record<string, unknown>;
  const aliases = [
    ...scopeValueAliases(binding.modulePath, context),
    ...scopeValueAliases(binding.moduleId, context),
    ...scopeValueAliases(record.moduleName, context),
  ];
  if (moduleBindingRepresentsProjectRoot(binding, context)) {
    aliases.push(...projectRootScopeAliases(context.projectRoot));
  }
  return uniqueStrings(aliases);
}

function moduleBindingRepresentsProjectRoot(
  binding: PlanModuleBinding,
  context: PlanSelectionConstraintContext
): boolean {
  const rootPath = normalizePathLike(context.projectRoot);
  const rootBasename = rootPath ? path.posix.basename(rootPath) : null;
  return [binding.modulePath, binding.moduleId].some((value) => {
    if (typeof value !== 'string') {
      return false;
    }
    const normalized = normalizePathLike(value);
    return (
      normalized === '.' ||
      normalized === '/' ||
      (rootPath !== null && normalized === rootPath) ||
      (rootBasename !== null && normalized === rootBasename)
    );
  });
}

function projectRootScopeAliases(projectRoot: string): string[] {
  const normalizedRoot = normalizePathLike(projectRoot);
  if (!normalizedRoot) {
    return [];
  }
  return uniqueStrings([projectRoot, normalizedRoot, path.posix.basename(normalizedRoot)]);
}

function scopeValueAliases(value: unknown, context?: PlanSelectionConstraintContext): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  const aliases = [trimmed];
  const normalized = normalizePathLike(trimmed);
  if (normalized) {
    aliases.push(normalized);
    const relativeToProjectRoot = relativeProjectRootPath(normalized, context?.projectRoot);
    if (relativeToProjectRoot) {
      aliases.push(relativeToProjectRoot);
    }
    const basename = path.posix.basename(relativeToProjectRoot ?? normalized);
    if (basename && basename !== '.') {
      aliases.push(basename);
    }
  }

  const structuredAlias = terminalStructuredAlias(trimmed);
  if (structuredAlias) {
    aliases.push(structuredAlias);
  }

  return uniqueStrings(aliases);
}

function normalizePathLike(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, '/'));
  if (!normalized || normalized === '.') {
    return trimmed === '.' || trimmed === './' ? '.' : null;
  }
  return normalized.replace(/\/+$/u, '') || '/';
}

function relativeProjectRootPath(value: string, projectRoot: string | undefined): string | null {
  const rootPath = projectRoot ? normalizePathLike(projectRoot) : null;
  if (!rootPath || !path.posix.isAbsolute(value)) {
    return null;
  }
  if (value === rootPath) {
    return '.';
  }
  const rootPrefix = `${rootPath}/`;
  return value.startsWith(rootPrefix) ? value.slice(rootPrefix.length) : null;
}

function terminalStructuredAlias(value: string): string | null {
  const parts = value
    .split(/[/:\\]/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.');
  return parts.length > 1 ? (parts.at(-1) ?? null) : null;
}

function serializePlanSelectionRequestConstraints(
  constraints: PlanSelectionRequestConstraints
): Record<string, unknown> {
  return {
    ...(constraints.dimensionIds.length > 0 ? { dimensions: constraints.dimensionIds } : {}),
    ...(constraints.moduleScope.length > 0 ? { moduleScope: constraints.moduleScope } : {}),
    ...(constraints.scaleCap !== undefined ? { scaleCap: constraints.scaleCap } : {}),
    ...(constraints.maxFiles !== undefined ? { maxFiles: constraints.maxFiles } : {}),
    ...(constraints.contentMaxLines !== undefined
      ? { contentMaxLines: constraints.contentMaxLines }
      : {}),
    ...(constraints.maxRounds !== undefined ? { maxRounds: constraints.maxRounds } : {}),
    ...(constraints.minNewRecipes !== undefined
      ? { minNewRecipes: constraints.minNewRecipes }
      : {}),
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

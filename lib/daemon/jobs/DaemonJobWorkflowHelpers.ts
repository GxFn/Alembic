import type { PlanStageId } from '@alembic/core/plans';
import type { ServiceContainer } from '../../injection/ServiceContainer.js';
import type {
  JobProcessEventRecorder,
  JobProcessEventRecordInput,
} from '../observability/JobProcessEventRecorder.js';
import type { DaemonRescanWorkflowArgs, ModuleDimensionTarget } from './DaemonJobWorkflowTypes.js';

export function buildDaemonRescanWorkflowArgs(options: {
  args?: Record<string, unknown>;
  source?: string;
}): DaemonRescanWorkflowArgs {
  const args = options.args ?? {};
  const workflowArgs: DaemonRescanWorkflowArgs = {
    reason:
      typeof args.reason === 'string' && args.reason.trim().length > 0
        ? args.reason
        : `${options.source || 'daemon'}-rescan`,
    dimensions: Array.isArray(args.dimensions)
      ? args.dimensions.filter((dimension): dimension is string => typeof dimension === 'string')
      : undefined,
  };

  if (args.maxFiles !== undefined) {
    workflowArgs.maxFiles = args.maxFiles;
  }
  if (args.contentMaxLines !== undefined) {
    workflowArgs.contentMaxLines = args.contentMaxLines;
  }
  const internalExecution = normalizeDaemonRescanInternalExecution(args.internalExecution);
  if (internalExecution) {
    workflowArgs.internalExecution = internalExecution;
  }

  if (isMiningRescanArgs(args)) {
    const moduleScope = stringArrayArg(args.moduleScope);
    const perDimensionTargets = normalizeNumberRecord(args.perDimensionTargets);
    const moduleDimensionTargets = normalizeModuleDimensionTargets(args.moduleDimensionTargets);
    const miningMode = miningModeArg(args.miningMode) ?? miningModeArg(args.generationStage);
    const roundIndex = positiveIntegerArg(args.roundIndex);

    if (miningMode) {
      workflowArgs.miningMode = miningMode;
    }
    if (moduleScope) {
      workflowArgs.moduleScope = moduleScope;
    }
    if (perDimensionTargets && Object.keys(perDimensionTargets).length > 0) {
      workflowArgs.perDimensionTargets = perDimensionTargets;
    }
    if (moduleDimensionTargets.length > 0) {
      workflowArgs.moduleDimensionTargets = moduleDimensionTargets;
    }
    if (roundIndex !== undefined) {
      workflowArgs.roundIndex = roundIndex;
    }
  }

  return workflowArgs;
}

function normalizeDaemonRescanInternalExecution(value: unknown):
  | {
      runAsyncFillInline?: boolean;
    }
  | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const internalExecution: { runAsyncFillInline?: boolean } = {};
  if (value.runAsyncFillInline === true) {
    internalExecution.runAsyncFillInline = true;
  }
  return Object.keys(internalExecution).length > 0 ? internalExecution : undefined;
}

export function getOptionalService<T>(container: ServiceContainer, name: string): T | null {
  try {
    return container.get(name) as T;
  } catch {
    return null;
  }
}

export function recordJobProcessEvent(
  recorder: JobProcessEventRecorder | null | undefined,
  input: JobProcessEventRecordInput
): void {
  if (!recorder) {
    return;
  }
  try {
    recorder.record(input);
  } catch {
    /* Process event recording must never fail the daemon job itself. */
  }
}

export function unwrapEnvelope(raw: unknown): unknown {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (parsed && typeof parsed === 'object' && 'data' in parsed) {
    return (parsed as { data?: unknown }).data || parsed;
  }
  return parsed;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : { value };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function positiveIntegerArg(value: unknown): number | undefined {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : null;
  if (numericValue === null || !Number.isFinite(numericValue) || numericValue < 1) {
    return undefined;
  }
  return Math.floor(numericValue);
}

export function firstPositiveIntegerArg(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = positiveIntegerArg(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

export function stringArrayArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
  return values.length > 0 ? values : undefined;
}

export function generationStageArg(value: unknown): PlanStageId | undefined {
  return value === 'coldStart' || value === 'deepMining' || value === 'moduleMining'
    ? value
    : undefined;
}

export function miningModeArg(value: unknown): DaemonRescanWorkflowArgs['miningMode'] | undefined {
  return value === 'deepMining' || value === 'moduleMining' || value === 'per-module'
    ? value
    : undefined;
}

export function isMiningRescanArgs(args: Record<string, unknown>): boolean {
  return (
    generationStageArg(args.generationStage) === 'deepMining' ||
    generationStageArg(args.generationStage) === 'moduleMining' ||
    miningModeArg(args.miningMode) !== undefined
  );
}

export function normalizeNumberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([key, raw]) => [key.trim(), nonNegativeNumber(raw)] as const)
    .filter(
      (entry): entry is readonly [string, number] => entry[0].length > 0 && entry[1] !== null
    );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeModuleDimensionTargets(value: unknown): ModuleDimensionTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const dimensionId = stringValue(item.dimensionId);
    const targetRecipes = nonNegativeNumber(item.targetRecipes);
    if (!dimensionId || targetRecipes === null) {
      return [];
    }
    const target: ModuleDimensionTarget = {
      dimensionId,
      targetRecipes,
    };
    const moduleId = stringValue(item.moduleId);
    const moduleName = stringValue(item.moduleName);
    if (moduleId) {
      target.moduleId = moduleId;
    }
    if (moduleName) {
      target.moduleName = moduleName;
    }
    return [target];
  });
}

export function nonNegativeNumber(value: unknown): number | null {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : null;
  if (numericValue === null || !Number.isFinite(numericValue) || numericValue < 0) {
    return null;
  }
  return Math.floor(numericValue);
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function extractNewRecipesThisRound(result: unknown): number {
  const record = asRecord(result);
  const numericCandidates = [
    record.newRecipesThisRound,
    record.newRecipes,
    record.created,
    record.createdCount,
    asRecord(record.summary).newRecipes,
    asRecord(record.summary).created,
    asRecord(record.bootstrapCandidates).created,
    asRecord(record.moduleMining).newRecipes,
  ];
  for (const candidate of numericCandidates) {
    const value = nonNegativeNumber(candidate);
    if (value !== null) {
      return value;
    }
  }
  return countRecipeArrayFields(result);
}

function countRecipeArrayFields(value: unknown, depth = 0): number {
  if (depth > 6 || !isRecord(value)) {
    return 0;
  }
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if (
      Array.isArray(child) &&
      (key === 'recipes' || key === 'newRecipes' || key === 'createdRecipes')
    ) {
      count += child.length;
      continue;
    }
    if (isRecord(child)) {
      count += countRecipeArrayFields(child, depth + 1);
    }
  }
  return count;
}

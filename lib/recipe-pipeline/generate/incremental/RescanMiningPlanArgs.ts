/**
 * RescanMiningPlanArgs — 增量重扫挖掘计划选项构建与入参规整器
 *
 * 结构清洗 W3——自 sustain/KnowledgeRescanWorkflow 尾部（mining plan 选项构建
 * + validators/normalizers 段）纯移动拆出；IncrementalRescanWorkflow 按需导入。
 * 纯函数集合，零逻辑改动：miningMode 归一、moduleDimensionTargets/perDimensionTargets
 * 规整、coverage-ledger 仓库解析与按维度覆盖聚合。
 */

import type {
  InternalKnowledgeRescanArgs as KnowledgeRescanArgs,
  ModuleDimensionTarget,
} from '@alembic/core/host-agent-workflows';
import type { CoverageLedgerRepository } from '@alembic/core/repositories';
import type { ProjectContextWorkflowFacts } from '../../../project-facts/ProjectContextWorkflowFacts.js';
import type { GenerateWorkflowMcpContext } from '../GenerateWorkflow.js';

type RescanMcpContext = GenerateWorkflowMcpContext;

export type KnowledgeRescanMiningMode = 'deepMining' | 'moduleMining' | 'per-module';

interface CoverageLedgerRepositoryLike {
  getCell(scope: { dimensionId: string; moduleId: string; projectRoot: string }): {
    coveredCount: number;
  } | null;
  listByProjectRoot(projectRoot: string): Array<{
    coveredCount: number;
    dimensionId: string;
  }>;
}

export function buildKnowledgeRescanMiningPlanOptions(input: {
  args: KnowledgeRescanArgs;
  ctx: RescanMcpContext;
  miningMode?: KnowledgeRescanMiningMode;
  projectContextFacts: ProjectContextWorkflowFacts;
  projectRoot: string;
}) {
  const moduleScope = normalizeStringArray(input.args.moduleScope);
  if (!input.miningMode) {
    return { moduleMiningBindings: [], moduleScope, planOptions: {} };
  }

  const coverageLedgerRepository = getCoverageLedgerRepository(input.ctx.container);
  const moduleDimensionTargets = normalizeModuleDimensionTargets(input.args.moduleDimensionTargets);
  const moduleBindings = moduleDimensionTargets.map((target) => {
    const moduleId = target.moduleId || target.moduleName;
    const cell =
      moduleId && coverageLedgerRepository
        ? coverageLedgerRepository.getCell({
            dimensionId: target.dimensionId,
            moduleId,
            projectRoot: input.projectRoot,
          })
        : null;
    return {
      dimensionId: target.dimensionId,
      moduleId,
      moduleName: target.moduleName,
      perCellCoverage: cell?.coveredCount ?? 0,
      targetRecipes: target.targetRecipes,
    };
  });

  return {
    moduleMiningBindings: moduleDimensionTargets.map((target) => ({
      dimensions: [target.dimensionId],
      moduleId: target.moduleId,
      moduleName: target.moduleName,
    })),
    moduleScope,
    planOptions: {
      ledgerCoverageByDimension: coverageLedgerRepository
        ? buildLedgerCoverageByDimension(coverageLedgerRepository, input.projectRoot)
        : undefined,
      moduleBindings: moduleBindings.length > 0 ? moduleBindings : undefined,
      moduleCount:
        input.projectContextFacts.projectMapModules.length || input.projectContextFacts.moduleCount,
      perDimensionTargets: normalizeNumberRecord(input.args.perDimensionTargets),
    },
  };
}

function buildLedgerCoverageByDimension(
  repository: CoverageLedgerRepositoryLike,
  projectRoot: string
): Record<string, number> {
  const coverage: Record<string, number> = {};
  for (const cell of repository.listByProjectRoot(projectRoot)) {
    coverage[cell.dimensionId] = (coverage[cell.dimensionId] ?? 0) + cell.coveredCount;
  }
  return coverage;
}

export function getCoverageLedgerRepository(container: {
  get(name: string): unknown;
}): CoverageLedgerRepository | null {
  try {
    const repository = container.get('coverageLedgerRepository');
    if (
      repository &&
      typeof (repository as CoverageLedgerRepositoryLike).getCell === 'function' &&
      typeof (repository as CoverageLedgerRepositoryLike).listByProjectRoot === 'function' &&
      typeof (repository as { listRoundsByProjectRoot?: unknown }).listRoundsByProjectRoot ===
        'function' &&
      typeof (repository as { upsertCell?: unknown }).upsertCell === 'function'
    ) {
      return repository as CoverageLedgerRepository;
    }
  } catch {
    return null;
  }
  return null;
}

export function knowledgeRescanMiningModeArg(
  value: unknown
): KnowledgeRescanMiningMode | undefined {
  return value === 'deepMining' || value === 'moduleMining' || value === 'per-module'
    ? value
    : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function normalizeNumberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([key, raw]) => [key.trim(), nonNegativeInteger(raw)] as const)
    .filter(
      (entry): entry is readonly [string, number] => entry[0].length > 0 && entry[1] !== null
    );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeModuleDimensionTargets(value: unknown): ModuleDimensionTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const dimensionId = stringValue(item.dimensionId);
    const targetRecipes = nonNegativeInteger(item.targetRecipes);
    if (!dimensionId || targetRecipes === null) {
      return [];
    }
    return [
      {
        dimensionId,
        moduleId: stringValue(item.moduleId),
        moduleName: stringValue(item.moduleName),
        targetRecipes,
      },
    ];
  });
}

export function shouldRunInternalRescanFillInline(args: KnowledgeRescanArgs): boolean {
  const internalExecution = args.internalExecution;
  return isRecord(internalExecution) && internalExecution.runAsyncFillInline === true;
}

export function positiveInteger(value: unknown): number | undefined {
  const normalized = nonNegativeInteger(value);
  return normalized !== null && normalized > 0 ? normalized : undefined;
}

export function nonNegativeInteger(value: unknown): number | null {
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

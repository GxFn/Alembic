import type {
  ScanBaselineRef,
  ScanBudget,
  ScanChangeSet,
  ScanDepth,
  ScanMode,
  ScanPlan,
  ScanPlanRequest,
  ScanScope,
} from '#workflows/scan/ScanTypes.js';

interface IncrementalEvaluationResult {
  canIncremental: boolean;
  mode: string;
  affectedDimensions: string[];
  skippedDimensions: string[];
  reason: string;
  previousSnapshot?: unknown;
  diff?: { changeRatio?: number } | null;
}

interface IncrementalPlannerLike {
  evaluate(currentFiles: unknown[], allDimensionIds: string[]): IncrementalEvaluationResult;
}

export interface ScanPlanServiceOptions {
  incrementalPlanner?: IncrementalPlannerLike | null;
  fullRebuildThreshold?: number;
  maxIncrementalFiles?: number;
}

export class ScanPlanService {
  readonly #incrementalPlanner: IncrementalPlannerLike | null;
  readonly #fullRebuildThreshold: number;
  readonly #maxIncrementalFiles: number;

  constructor(options: ScanPlanServiceOptions = {}) {
    this.#incrementalPlanner = options.incrementalPlanner ?? null;
    this.#fullRebuildThreshold = options.fullRebuildThreshold ?? 0.5;
    this.#maxIncrementalFiles = options.maxIncrementalFiles ?? 40;
  }

  plan(request: ScanPlanRequest): ScanPlan {
    const activeDimensions = request.dimensions ?? request.allDimensionIds ?? [];
    const scope = buildScope(request);
    const baseline = buildBaselineRef(request);

    if (
      (request.requestedMode === 'deep-mining' || request.intent === 'deep-mining') &&
      request.hasBaseline === false &&
      !baseline
    ) {
      return this.#buildPlan({
        mode: 'cold-start',
        depth: 'standard',
        reason: '无 baseline，专题深挖需要先建立冷启动基线',
        activeDimensions,
        scope,
        budget: request.budget,
        fallback: null,
      });
    }

    if (request.requestedMode) {
      return this.#buildPlan({
        mode: request.requestedMode,
        depth: depthForMode(request.requestedMode),
        reason: '用户显式指定扫描模式',
        baseline,
        activeDimensions,
        scope,
        budget: request.budget,
        changeSet: request.changeSet,
      });
    }

    if (request.force) {
      return this.#buildPlan({
        mode: 'cold-start',
        depth: 'standard',
        reason: '用户强制 rebuild，需要全量冷启动',
        activeDimensions,
        scope,
        budget: request.budget,
      });
    }

    if (request.intent === 'maintenance') {
      return this.#buildPlan({
        mode: 'maintenance',
        depth: 'light',
        reason: '维护型扫描请求',
        activeDimensions: [],
        scope,
        budget: request.budget,
      });
    }

    if (request.intent === 'deep-mining') {
      return this.#buildPlan({
        mode: 'deep-mining',
        depth: 'deep',
        reason: '专题或模块深度挖掘请求',
        baseline,
        activeDimensions,
        scope,
        budget: request.budget,
      });
    }

    if (
      request.intent === 'bootstrap' &&
      (request.precomputedIncrementalPlan || (request.currentFiles && this.#incrementalPlanner))
    ) {
      return this.#planBootstrapIncremental(request, scope);
    }

    if (request.changeSet) {
      return this.#planChangeSet(request, scope);
    }

    if (request.hasBaseline === false) {
      return this.#buildPlan({
        mode: 'cold-start',
        depth: 'standard',
        reason: '无历史 baseline，需要冷启动',
        activeDimensions,
        scope,
        budget: request.budget,
      });
    }

    return this.#buildPlan({
      mode: 'maintenance',
      depth: 'light',
      reason: '未提供变更或深挖范围，执行日常维护检查',
      activeDimensions: [],
      scope,
      budget: request.budget,
    });
  }

  #planBootstrapIncremental(request: ScanPlanRequest, scope: ScanScope): ScanPlan {
    const allDimensionIds = request.allDimensionIds ?? request.dimensions ?? [];
    const requestedDimensions = request.dimensions ?? allDimensionIds;
    const incrementalPlanner = this.#incrementalPlanner;
    const evaluation = readIncrementalEvaluationResult(request.precomputedIncrementalPlan);
    if (!evaluation && !incrementalPlanner) {
      return this.#buildPlan({
        mode: 'cold-start',
        depth: 'standard',
        reason: '增量规划器不可用，回退全量冷启动',
        activeDimensions: requestedDimensions,
        scope,
        budget: request.budget,
      });
    }
    const resolvedEvaluation =
      evaluation ?? incrementalPlanner?.evaluate(request.currentFiles ?? [], allDimensionIds);
    if (!resolvedEvaluation) {
      return this.#buildPlan({
        mode: 'cold-start',
        depth: 'standard',
        reason: '增量规划结果不可用，回退全量冷启动',
        activeDimensions: requestedDimensions,
        scope,
        budget: request.budget,
      });
    }
    if (resolvedEvaluation.canIncremental && resolvedEvaluation.mode === 'incremental') {
      const requested = new Set(requestedDimensions);
      return this.#buildPlan({
        mode: 'cold-start',
        depth: 'standard',
        reason: `增量冷启动：${resolvedEvaluation.reason}`,
        activeDimensions: resolvedEvaluation.affectedDimensions.filter((dimension) =>
          requested.has(dimension)
        ),
        skippedDimensions: resolvedEvaluation.skippedDimensions.filter((dimension) =>
          requested.has(dimension)
        ),
        scope,
        budget: request.budget,
        rawIncrementalPlan: resolvedEvaluation,
      });
    }

    return this.#buildPlan({
      mode: 'cold-start',
      depth: 'standard',
      reason: resolvedEvaluation.reason || '增量不可用，回退全量冷启动',
      activeDimensions: requestedDimensions,
      scope,
      budget: request.budget,
      fallback: null,
      rawIncrementalPlan: resolvedEvaluation,
    });
  }

  #planChangeSet(request: ScanPlanRequest, scope: ScanScope): ScanPlan {
    const changeSet = normalizeChangeSet(request.changeSet);
    const changedCount = countChangedFiles(changeSet);
    const totalFileCount = Math.max(request.totalFileCount ?? 0, changedCount);
    const changeRatio = totalFileCount > 0 ? changedCount / totalFileCount : 0;
    const activeDimensions = request.dimensions ?? request.allDimensionIds ?? [];

    if (request.hasBaseline === false) {
      return this.#buildPlan({
        mode: 'cold-start',
        depth: 'standard',
        reason: '无 baseline，变更无法局部修正，回退冷启动',
        activeDimensions,
        scope,
        budget: request.budget,
        changeSet,
      });
    }

    if (changeRatio > this.#fullRebuildThreshold) {
      return this.#buildPlan({
        mode: 'deep-mining',
        depth: 'deep',
        reason: `变更比例 ${(changeRatio * 100).toFixed(1)}% 超过阈值，升级为深度挖掘`,
        activeDimensions,
        scope,
        budget: request.budget,
        changeSet,
        fallback: 'cold-start',
      });
    }

    if ((request.impactedRecipeIds?.length ?? 0) > 0 && changedCount <= this.#maxIncrementalFiles) {
      return this.#buildPlan({
        mode: 'incremental-correction',
        depth: 'standard',
        reason: '变更命中已有 sourceRefs，执行局部语义修正',
        activeDimensions,
        scope: { ...scope, recipeIds: request.impactedRecipeIds },
        budget: request.budget,
        changeSet,
      });
    }

    if ((changeSet?.added.length ?? 0) > 0 && changedCount <= this.#maxIncrementalFiles) {
      return this.#buildPlan({
        mode: 'deep-mining',
        depth: 'deep',
        reason: '存在新增文件，建议按新模块或低覆盖维度深挖',
        activeDimensions,
        scope,
        budget: request.budget,
        changeSet,
      });
    }

    return this.#buildPlan({
      mode: 'incremental-correction',
      depth: 'standard',
      reason: '小范围修改，执行增量修正扫描',
      activeDimensions,
      scope,
      budget: request.budget,
      changeSet,
    });
  }

  #buildPlan({
    mode,
    depth,
    reason,
    baseline,
    activeDimensions,
    skippedDimensions = [],
    scope,
    budget,
    changeSet,
    fallback = null,
    rawIncrementalPlan,
  }: {
    mode: ScanMode;
    depth: ScanDepth;
    reason: string;
    baseline?: ScanBaselineRef | null;
    activeDimensions: string[];
    skippedDimensions?: string[];
    scope: ScanScope;
    budget?: ScanBudget;
    changeSet?: ScanChangeSet;
    fallback?: ScanPlan['fallback'];
    rawIncrementalPlan?: unknown;
  }): ScanPlan {
    return {
      mode,
      depth,
      reason,
      baseline,
      activeDimensions,
      skippedDimensions,
      scope,
      changeSet,
      fallback,
      budgets: {
        maxFiles: budget?.maxFiles ?? defaultMaxFiles(mode),
        maxKnowledgeItems: budget?.maxKnowledgeItems ?? defaultMaxKnowledge(mode),
        maxTotalChars: budget?.maxTotalChars ?? defaultMaxChars(mode),
        maxAgentIterations: defaultMaxAgentIterations(mode, depth),
      },
      rawIncrementalPlan,
    };
  }
}

function buildBaselineRef(request: ScanPlanRequest): ScanBaselineRef | null {
  const runId = readOptionalString(request.baselineRunId);
  const snapshotId = readOptionalString(request.baselineSnapshotId);
  if (!runId && !snapshotId) {
    return null;
  }
  return { runId, snapshotId, source: 'request' };
}

function buildScope(request: ScanPlanRequest): ScanScope {
  return {
    dimensions: request.dimensions,
    files: request.changeSet ? collectChangedFiles(request.changeSet) : undefined,
    modules: request.modules,
    recipeIds: request.recipeIds,
    query: request.query,
  };
}

function normalizeChangeSet(changeSet: ScanChangeSet | undefined): ScanChangeSet | undefined {
  if (!changeSet) {
    return undefined;
  }
  return {
    added: [...new Set(changeSet.added)],
    modified: [...new Set(changeSet.modified)],
    deleted: [...new Set(changeSet.deleted)],
    renamed: changeSet.renamed ?? [],
    source: changeSet.source,
  };
}

function collectChangedFiles(changeSet: ScanChangeSet): string[] {
  return [
    ...new Set([
      ...changeSet.added,
      ...changeSet.modified,
      ...changeSet.deleted,
      ...(changeSet.renamed ?? []).flatMap((rename) => [rename.oldPath, rename.newPath]),
    ]),
  ];
}

function countChangedFiles(changeSet: ScanChangeSet | undefined): number {
  return changeSet ? collectChangedFiles(changeSet).length : 0;
}

function depthForMode(mode: ScanMode): ScanDepth {
  if (mode === 'maintenance') {
    return 'light';
  }
  if (mode === 'deep-mining') {
    return 'deep';
  }
  return 'standard';
}

function defaultMaxFiles(mode: ScanMode): number {
  switch (mode) {
    case 'cold-start':
      return 160;
    case 'deep-mining':
      return 80;
    case 'incremental-correction':
      return 32;
    case 'maintenance':
      return 12;
  }
}

function defaultMaxKnowledge(mode: ScanMode): number {
  switch (mode) {
    case 'cold-start':
      return 80;
    case 'deep-mining':
      return 60;
    case 'incremental-correction':
      return 30;
    case 'maintenance':
      return 20;
  }
}

function defaultMaxChars(mode: ScanMode): number {
  switch (mode) {
    case 'cold-start':
      return 120_000;
    case 'deep-mining':
      return 100_000;
    case 'incremental-correction':
      return 48_000;
    case 'maintenance':
      return 24_000;
  }
}

function defaultMaxAgentIterations(mode: ScanMode, depth: ScanDepth): number {
  if (mode === 'maintenance') {
    return 0;
  }
  if (mode === 'deep-mining') {
    return depth === 'exhaustive' ? 40 : 30;
  }
  if (mode === 'incremental-correction') {
    return 12;
  }
  return 30;
}

function readIncrementalEvaluationResult(value: unknown): IncrementalEvaluationResult | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.canIncremental !== 'boolean' ||
    typeof record.mode !== 'string' ||
    !Array.isArray(record.affectedDimensions) ||
    !Array.isArray(record.skippedDimensions) ||
    typeof record.reason !== 'string'
  ) {
    return null;
  }
  return {
    canIncremental: record.canIncremental,
    mode: record.mode,
    affectedDimensions: record.affectedDimensions.filter(
      (dimension): dimension is string => typeof dimension === 'string'
    ),
    skippedDimensions: record.skippedDimensions.filter(
      (dimension): dimension is string => typeof dimension === 'string'
    ),
    reason: record.reason,
    previousSnapshot: record.previousSnapshot,
    diff: record.diff as IncrementalEvaluationResult['diff'],
  };
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

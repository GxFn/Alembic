import type { ProjectSnapshot } from '#types/project-snapshot.js';
import {
  ScanRunTracker,
  type ScanRunTrackerContainer,
} from '#workflows/scan/lifecycle/ScanRunTracker.js';
import type { KnowledgeRetrievalPipeline } from '#workflows/scan/retrieval/KnowledgeRetrievalPipeline.js';
import type { ScanPlanService } from '#workflows/scan/ScanPlanService.js';
import type {
  KnowledgeEvidencePack,
  ScanBudget,
  ScanFileEvidenceInput,
  ScanPlan,
  ScanPlanRequest,
} from '#workflows/scan/ScanTypes.js';

export interface ColdStartScanContextOptions {
  enabled?: boolean;
  retrieveEvidence?: boolean;
  dimensions?: string[];
  budget?: ScanBudget;
}

export interface ColdStartScanContext {
  plan: ScanPlan;
  evidencePack: KnowledgeEvidencePack | null;
  evidenceSummary: Record<string, unknown> | null;
  run: ReturnType<ScanRunTracker['create']>['run'];
  evidencePackRecord: ReturnType<ScanRunTracker['create']>['evidencePackRecord'];
}

export interface ColdStartScanLifecycleContext {
  container: ScanRunTrackerContainer;
}

export async function buildColdStartScanContext(
  ctx: ColdStartScanLifecycleContext,
  snapshot: ProjectSnapshot,
  options: ColdStartScanContextOptions | undefined
): Promise<ColdStartScanContext | null> {
  if (!options?.enabled || snapshot.isEmpty) {
    return null;
  }

  const allDimensionIds = snapshot.activeDimensions.map((dimension) => dimension.id);
  const requestedDimensions = options.dimensions?.length
    ? allDimensionIds.filter((dimension) => options.dimensions?.includes(dimension))
    : allDimensionIds;
  const files = toScanFiles(snapshot);
  const planRequest: ScanPlanRequest = {
    projectRoot: snapshot.projectRoot,
    intent: 'bootstrap',
    hasBaseline: Boolean(snapshot.incrementalPlan?.previousSnapshot),
    allDimensionIds,
    dimensions: requestedDimensions,
    currentFiles: files,
    budget: options.budget,
    precomputedIncrementalPlan: snapshot.incrementalPlan ?? undefined,
  };
  const scanPlanService = readContainerService<ScanPlanService>(ctx, 'scanPlanService');
  const plan = scanPlanService?.plan(planRequest) ?? fallbackColdStartPlan(snapshot, planRequest);

  if (options.retrieveEvidence !== true) {
    const persisted = createColdStartScanRun({ ctx, projectRoot: snapshot.projectRoot, plan });
    return { plan, evidencePack: null, evidenceSummary: null, ...persisted };
  }

  const retrieval = readContainerService<KnowledgeRetrievalPipeline>(
    ctx,
    'knowledgeRetrievalPipeline'
  );
  if (!retrieval) {
    const evidenceSummary = { unavailable: true };
    const persisted = createColdStartScanRun({ ctx, projectRoot: snapshot.projectRoot, plan });
    return { plan, evidencePack: null, evidenceSummary, ...persisted };
  }

  const evidencePack = await retrieval.retrieve({
    projectRoot: snapshot.projectRoot,
    mode: plan.mode,
    intent: 'build-baseline',
    depth: plan.depth,
    scope: { dimensions: plan.activeDimensions },
    files,
    budget: {
      ...options.budget,
      maxFiles: options.budget?.maxFiles ?? plan.budgets.maxFiles,
      maxKnowledgeItems: options.budget?.maxKnowledgeItems ?? plan.budgets.maxKnowledgeItems,
      maxTotalChars: options.budget?.maxTotalChars ?? plan.budgets.maxTotalChars,
    },
    primaryLang: snapshot.language.primaryLang,
  });
  const evidenceSummary = summarizeEvidencePack(evidencePack);
  const persisted = createColdStartScanRun({
    ctx,
    projectRoot: snapshot.projectRoot,
    plan,
    evidencePack,
    evidenceSummary,
  });
  return { plan, evidencePack, evidenceSummary, ...persisted };
}

export function projectColdStartScanContextSummary(
  scanContext: ColdStartScanContext | null
): Record<string, unknown> | null {
  if (!scanContext) {
    return null;
  }
  return {
    plan: {
      mode: scanContext.plan.mode,
      depth: scanContext.plan.depth,
      reason: scanContext.plan.reason,
      activeDimensions: scanContext.plan.activeDimensions,
      skippedDimensions: scanContext.plan.skippedDimensions,
      budgets: scanContext.plan.budgets,
    },
    evidence: scanContext.evidenceSummary,
    run: scanContext.run
      ? {
          id: scanContext.run.id,
          status: scanContext.run.status,
          startedAt: scanContext.run.startedAt,
          completedAt: scanContext.run.completedAt,
          durationMs: scanContext.run.durationMs,
        }
      : null,
    evidencePackRecord: scanContext.evidencePackRecord
      ? {
          id: scanContext.evidencePackRecord.id,
          packKind: scanContext.evidencePackRecord.packKind,
          charCount: scanContext.evidencePackRecord.charCount,
          truncated: scanContext.evidencePackRecord.truncated,
        }
      : null,
  };
}

function createColdStartScanRun({
  ctx,
  projectRoot,
  plan,
  evidencePack,
  evidenceSummary,
}: {
  ctx: ColdStartScanLifecycleContext;
  projectRoot: string;
  plan: ScanPlan;
  evidencePack?: KnowledgeEvidencePack | null;
  evidenceSummary?: Record<string, unknown> | null;
}): ReturnType<ScanRunTracker['create']> {
  return ScanRunTracker.fromContainer(ctx.container).create(
    {
      projectRoot,
      mode: 'cold-start',
      depth: plan.depth,
      reason: plan.reason,
      activeDimensions: plan.activeDimensions,
      scope: plan.scope,
      budgets: projectScanBudget(plan),
    },
    evidencePack
      ? {
          packKind: 'cold-start',
          pack: evidencePack,
          summary: evidenceSummary ?? undefined,
        }
      : null
  );
}

function readContainerService<T>(ctx: ColdStartScanLifecycleContext, name: string): T | null {
  try {
    return (ctx.container.get?.(name) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

function toScanFiles(snapshot: ProjectSnapshot): ScanFileEvidenceInput[] {
  return snapshot.allFiles.map((file) => ({
    relativePath: file.relativePath || file.name,
    path: file.path,
    name: file.name,
    language: file.language,
    content: file.content,
  }));
}

function fallbackColdStartPlan(snapshot: ProjectSnapshot, request: ScanPlanRequest): ScanPlan {
  const incrementalPlan = snapshot.incrementalPlan;
  const requestedDimensions = request.dimensions ?? request.allDimensionIds ?? [];
  const requested = new Set(requestedDimensions);
  const activeDimensions =
    incrementalPlan?.canIncremental && incrementalPlan.mode === 'incremental'
      ? (incrementalPlan.affectedDimensions ?? []).filter((dimension) => requested.has(dimension))
      : requestedDimensions;
  const skippedDimensions =
    incrementalPlan?.canIncremental && incrementalPlan.mode === 'incremental'
      ? (incrementalPlan.skippedDimensions ?? []).filter((dimension) => requested.has(dimension))
      : [];

  return {
    mode: 'cold-start',
    depth: 'standard',
    reason: incrementalPlan
      ? `Phase 1-4 复用增量计划：${incrementalPlan.reason}`
      : 'Phase 1-4 项目分析完成，执行冷启动基线构建',
    activeDimensions,
    skippedDimensions,
    scope: { dimensions: requestedDimensions },
    fallback: null,
    budgets: {
      maxFiles: request.budget?.maxFiles ?? 160,
      maxKnowledgeItems: request.budget?.maxKnowledgeItems ?? 80,
      maxTotalChars: request.budget?.maxTotalChars ?? 120_000,
      maxAgentIterations: 30,
    },
    rawIncrementalPlan: incrementalPlan,
  };
}

function summarizeEvidencePack(pack: KnowledgeEvidencePack): Record<string, unknown> {
  return {
    fileCount: pack.files.length,
    knowledgeCount: pack.knowledge.length,
    graphEntityCount: pack.graph.entities.length,
    graphEdgeCount: pack.graph.edges.length,
    gapCount: pack.gaps.length,
    truncated: pack.diagnostics.truncated,
    warnings: pack.diagnostics.warnings.length,
    retrievalMs: pack.diagnostics.retrievalMs,
  };
}

function projectScanBudget(plan: ScanPlan): ScanBudget {
  return {
    maxFiles: plan.budgets.maxFiles,
    maxKnowledgeItems: plan.budgets.maxKnowledgeItems,
    maxTotalChars: plan.budgets.maxTotalChars,
  };
}

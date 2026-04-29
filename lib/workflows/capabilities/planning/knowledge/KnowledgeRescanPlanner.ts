import type { RecipeSnapshotEntry } from '#service/cleanup/CleanupService.js';
import type { AstSummary, DependencyGraph, DimensionDef } from '#types/project-snapshot.js';
import {
  buildEvolutionPrescreen,
  type EvolutionPrescreen,
} from '#workflows/capabilities/planning/knowledge/EvolutionPrescreen.js';
import {
  type AuditVerdict,
  type BuildKnowledgeRescanPlanOptions,
  buildKnowledgeRescanPlan,
  type KnowledgeRescanDimensionPlan,
  type KnowledgeRescanPlan,
  type RescanExecutionReason,
  type RescanExecutionReasonKind,
  TARGET_RECIPES_PER_DIMENSION,
} from './KnowledgeRescanPlanBuilder.js';
import {
  type ExternalDimensionGap,
  type ExternalRescanEvidencePlan,
  type InternalRescanGapPlan,
  projectExternalRescanEvidencePlan,
  projectInternalRescanGapPlan,
  projectInternalRescanPromptRecipes,
  projectInternalRescanPromptRecipesFromParts,
} from './RescanEvidenceProjectors.js';

// ── RelevanceAudit 类型定义（原 RelevanceAuditor.ts）──────────

/** 单个 Recipe 的审计结果 */
export interface RelevanceAuditResult {
  recipeId: string;
  title: string;
  relevanceScore: number;
  verdict: 'healthy' | 'watch' | 'decay' | 'severe' | 'dead';
  evidence: {
    triggerStillMatches: boolean;
    symbolsAlive: number;
    depsIntact: boolean;
    codeFilesExist: number;
  };
  decayReasons: string[];
}

/** 审计汇总 */
export interface RelevanceAuditSummary {
  totalAudited: number;
  healthy: number;
  watch: number;
  decay: number;
  severe: number;
  dead: number;
  results: RelevanceAuditResult[];
  proposalsCreated: number;
  immediateDeprecated: number;
}

export {
  buildKnowledgeRescanPlan,
  projectExternalRescanEvidencePlan,
  projectInternalRescanGapPlan,
  projectInternalRescanPromptRecipes,
  TARGET_RECIPES_PER_DIMENSION,
};

export type {
  AuditVerdict,
  ExternalDimensionGap,
  ExternalRescanEvidencePlan,
  InternalRescanGapPlan,
  KnowledgeRescanDimensionPlan,
  KnowledgeRescanPlan,
  RescanExecutionReason,
  RescanExecutionReasonKind,
};

interface RescanLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

interface KnowledgeSyncService {
  sync(db: unknown, opts: { force: boolean }): { synced: number; created: number; updated: number };
}

interface RescanServiceContainer {
  get(name: string): unknown;
  services?: Record<string, unknown>;
}

export interface KnowledgeSyncOptions {
  container: RescanServiceContainer;
  db: unknown;
  logger: RescanLogger;
  logPrefix: string;
}

export interface RecipeAuditOptions {
  container: RescanServiceContainer;
  logger: RescanLogger;
  recipeEntries: RecipeSnapshotEntry[];
  allFiles: Array<{ relativePath?: string; name: string }>;
  astProjectSummary: AstSummary | null | undefined;
  depGraphData: DependencyGraph | null | undefined;
}

export function syncKnowledgeStoreForRescan(opts: KnowledgeSyncOptions): void {
  try {
    if (opts.container.services && !opts.container.services.knowledgeSyncService) {
      return;
    }

    const syncService = opts.container.get('knowledgeSyncService') as KnowledgeSyncService;

    if (!syncService) {
      return;
    }

    const syncReport = syncService.sync(opts.db, { force: true });
    opts.logger.info(`[${opts.logPrefix}] KnowledgeSyncService sync complete`, {
      synced: syncReport.synced,
      created: syncReport.created,
      updated: syncReport.updated,
    });
  } catch (err: unknown) {
    opts.logger.warn(
      `[${opts.logPrefix}] KnowledgeSyncService sync failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** @deprecated RelevanceAuditor 已移除，此函数保留为空操作桩。进化入口改为 RecipeImpactPlanner + Evolution Agent。 */
export async function auditRecipesForRescan(
  _opts: RecipeAuditOptions
): Promise<RelevanceAuditSummary> {
  return {
    totalAudited: 0,
    healthy: 0,
    watch: 0,
    decay: 0,
    severe: 0,
    dead: 0,
    results: [],
    proposalsCreated: 0,
    immediateDeprecated: 0,
  };
}

export function buildRescanPrescreen(
  auditSummary: RelevanceAuditSummary,
  recipeEntries: RecipeSnapshotEntry[],
  dimensions: Array<{ id: string }>
): EvolutionPrescreen {
  return buildEvolutionPrescreen(auditSummary, recipeEntries, dimensions);
}

export function planInternalRescanGaps(
  opts: BuildKnowledgeRescanPlanOptions
): InternalRescanGapPlan {
  return projectInternalRescanGapPlan(buildKnowledgeRescanPlan(opts));
}

export function buildExistingRecipesForInternalFill(opts: {
  recipeEntries: RecipeSnapshotEntry[];
  auditSummary: RelevanceAuditSummary;
  auditVerdictMap: Map<string, AuditVerdict>;
}): Array<{
  id: string;
  title: string;
  trigger: string;
  knowledgeType: string;
  status: 'decaying' | 'healthy';
  decayReason?: string;
  auditScore?: number;
  content?: { markdown?: string; rationale?: string; coreCode?: string };
  sourceRefs?: string[];
  auditEvidence?: Record<string, unknown>;
}> {
  return projectInternalRescanPromptRecipesFromParts(opts);
}

export function buildExternalRescanEvidencePlan(opts: {
  recipeEntries: RecipeSnapshotEntry[];
  auditSummary: RelevanceAuditSummary;
  dimensions: DimensionDef[];
  targetPerDimension?: number;
}): ExternalRescanEvidencePlan {
  return projectExternalRescanEvidencePlan(buildKnowledgeRescanPlan(opts));
}

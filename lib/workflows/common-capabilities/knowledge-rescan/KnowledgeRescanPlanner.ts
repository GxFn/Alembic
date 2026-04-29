import type { RecipeSnapshotEntry } from '#service/cleanup/CleanupService.js';
import {
  RelevanceAuditor,
  type RelevanceAuditSummary,
} from '#service/evolution/RelevanceAuditor.js';
import type { AstSummary, DependencyGraph, DimensionDef } from '#types/project-snapshot.js';
import {
  buildEvolutionPrescreen,
  type EvolutionPrescreen,
} from '#workflows/common-capabilities/knowledge-rescan/EvolutionPrescreen.js';
import {
  extractCodeEntities,
  extractDependencyEdges,
} from '#workflows/common-capabilities/knowledge-rescan/RecipeAuditEvidence.js';
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

export async function auditRecipesForRescan(
  opts: RecipeAuditOptions
): Promise<RelevanceAuditSummary> {
  const auditor = new RelevanceAuditor({
    knowledgeRepo: opts.container.get(
      'knowledgeRepository'
    ) as import('#repo/knowledge/KnowledgeRepository.impl.js').default,
    evolutionGateway: opts.container.get(
      'evolutionGateway'
    ) as import('#service/evolution/EvolutionGateway.js').EvolutionGateway,
    logger: opts.logger,
  });

  const codeEntities = extractCodeEntities(opts.astProjectSummary);
  const dependencyEdges = extractDependencyEdges(opts.depGraphData);

  return auditor.audit(opts.recipeEntries, {
    fileList: opts.allFiles.map((file) => file.relativePath || file.name),
    codeEntities,
    dependencyGraph: dependencyEdges,
  });
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

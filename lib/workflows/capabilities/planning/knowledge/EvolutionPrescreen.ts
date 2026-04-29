import type {
  RelevanceAuditResult,
  RelevanceAuditSummary,
} from '#service/evolution/RelevanceAuditor.js';

export interface PrescreenNeedsVerification {
  recipeId: string;
  title: string;
  dimension: string;
  relevanceVerdict: 'decay' | 'severe' | 'watch';
  relevanceScore: number;
  auditHint: string;
  decayReasons: string[];
}

export interface PrescreenAutoResolved {
  recipeId: string;
  resolution: 'auto-skip' | 'auto-deprecated';
  reason: string;
}

export interface DimensionGapInfo {
  target: number;
  healthy: number;
  observing: number;
  gap: number;
}

export interface EvolutionPrescreen {
  needsVerification: PrescreenNeedsVerification[];
  autoResolved: PrescreenAutoResolved[];
  dimensionGaps: Record<string, DimensionGapInfo>;
}

const TARGET_PER_DIM = 5;

export function buildEvolutionPrescreen(
  auditSummary: RelevanceAuditSummary,
  snapshotEntries: Array<{
    id: string;
    title: string;
    lifecycle: string;
    knowledgeType: string;
    trigger: string;
  }>,
  dimensions: Array<{ id: string }>
): EvolutionPrescreen {
  const needsVerification: PrescreenNeedsVerification[] = [];
  const autoResolved: PrescreenAutoResolved[] = [];
  const snapById = new Map(snapshotEntries.map((entry) => [entry.id, entry]));

  for (const result of auditSummary.results) {
    const snap = snapById.get(result.recipeId);
    const dimension = snap?.knowledgeType || 'unknown';

    switch (result.verdict) {
      case 'healthy': {
        autoResolved.push({
          recipeId: result.recipeId,
          resolution: 'auto-skip',
          reason: `relevanceScore=${result.relevanceScore}, verdict=healthy — 自动跳过`,
        });
        break;
      }
      case 'dead': {
        autoResolved.push({
          recipeId: result.recipeId,
          resolution: 'auto-deprecated',
          reason: `relevanceScore=${result.relevanceScore}, verdict=dead — 已自动废弃`,
        });
        break;
      }
      case 'watch':
      case 'decay':
      case 'severe': {
        needsVerification.push({
          recipeId: result.recipeId,
          title: result.title,
          dimension,
          relevanceVerdict: result.verdict,
          relevanceScore: result.relevanceScore,
          auditHint: buildAuditHint(result),
          decayReasons: result.decayReasons || [],
        });
        break;
      }
    }
  }

  const healthyByDim = new Map<string, number>();
  const observingByDim = new Map<string, number>();

  for (const entry of snapshotEntries) {
    const dim = entry.knowledgeType || 'unknown';
    const auditResult = auditSummary.results.find((result) => result.recipeId === entry.id);

    if (entry.lifecycle === 'active' || entry.lifecycle === 'evolving') {
      if (!auditResult || auditResult.verdict === 'healthy' || auditResult.verdict === 'watch') {
        healthyByDim.set(dim, (healthyByDim.get(dim) || 0) + 1);
      }
    } else if (entry.lifecycle === 'staging') {
      if (!auditResult || auditResult.verdict === 'healthy' || auditResult.verdict === 'watch') {
        observingByDim.set(dim, (observingByDim.get(dim) || 0) + 1);
      }
    }
  }

  const dimensionGaps: Record<string, DimensionGapInfo> = {};
  for (const dim of dimensions) {
    const healthy = healthyByDim.get(dim.id) || 0;
    const observing = observingByDim.get(dim.id) || 0;
    dimensionGaps[dim.id] = {
      target: TARGET_PER_DIM,
      healthy,
      observing,
      gap: Math.max(0, TARGET_PER_DIM - healthy - observing),
    };
  }

  return { needsVerification, autoResolved, dimensionGaps };
}

function buildAuditHint(result: RelevanceAuditResult): string {
  const parts: string[] = [];
  if (!result.evidence.triggerStillMatches) {
    parts.push('trigger 不再匹配');
  }
  if (result.evidence.symbolsAlive === 0) {
    parts.push('引用符号全部消失');
  }
  if (!result.evidence.depsIntact) {
    parts.push('依赖关系断裂');
  }
  if (result.evidence.codeFilesExist === 0) {
    parts.push('源文件全部缺失');
  }
  if (result.decayReasons.length > 0) {
    parts.push(...result.decayReasons.slice(0, 2));
  }
  return parts.length > 0 ? parts.join('; ') : `relevanceScore=${result.relevanceScore}`;
}

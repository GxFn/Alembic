/**
 * buildEvolutionPrescreen — 进化前置过滤（文档 §6）
 *
 * 在增量扫描的 RelevanceAuditor 执行后、Mission Briefing 构建前调用。
 * 将 Recipe 分为两组：
 *   1. needsVerification — Agent 需要验证（decay/severe/watch+impacted）
 *   2. autoResolved — 系统自动处理（healthy → auto-skip, dead → auto-deprecated）
 *
 * 效果：Agent 只需验证少量 Recipe，token 消耗大幅降低。
 *
 * @module handlers/evolution-prescreen
 */

import type {
  RelevanceAuditResult,
  RelevanceAuditSummary,
} from '#service/evolution/RelevanceAuditor.js';

/* ────────────────────── Types ────────────────────── */

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
  /** 需要 Agent 验证的 Recipe */
  needsVerification: PrescreenNeedsVerification[];
  /** 已自动处理的 Recipe（不需要 Agent） */
  autoResolved: PrescreenAutoResolved[];
  /** 各维度的明确 gap 数 */
  dimensionGaps: Record<string, DimensionGapInfo>;
}

/* ────────────────────── Constants ────────────────────── */

const TARGET_PER_DIM = 5;

/* ────────────────────── Builder ────────────────────── */

/**
 * 构建进化前置过滤结果。
 *
 * @param auditSummary - RelevanceAuditor 审计结果
 * @param snapshotEntries - Recipe 快照条目
 * @param dimensions - 激活的维度列表
 */
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

  // 建立 id → snapshot 映射
  const snapById = new Map(snapshotEntries.map((e) => [e.id, e]));

  for (const result of auditSummary.results) {
    const snap = snapById.get(result.recipeId);
    const dimension = snap?.knowledgeType || 'unknown';

    switch (result.verdict) {
      case 'healthy': {
        // 自动 skip — 不需要 Agent 验证
        autoResolved.push({
          recipeId: result.recipeId,
          resolution: 'auto-skip',
          reason: `relevanceScore=${result.relevanceScore}, verdict=healthy — 自动跳过`,
        });
        break;
      }

      case 'dead': {
        // 已被 RelevanceAuditor 直接 deprecated
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
        // 需要 Agent 验证
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

  // 计算各维度 gap（扣除 healthy + observing）
  const healthyByDim = new Map<string, number>();
  const observingByDim = new Map<string, number>();

  for (const entry of snapshotEntries) {
    const dim = entry.knowledgeType || 'unknown';
    const auditResult = auditSummary.results.find((r) => r.recipeId === entry.id);

    if (entry.lifecycle === 'active' || entry.lifecycle === 'evolving') {
      // Confirmed recipes — check if healthy
      if (!auditResult || auditResult.verdict === 'healthy' || auditResult.verdict === 'watch') {
        healthyByDim.set(dim, (healthyByDim.get(dim) || 0) + 1);
      }
    } else if (entry.lifecycle === 'staging') {
      // Staging — observing window
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

/* ────────────────────── Helpers ────────────────────── */

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

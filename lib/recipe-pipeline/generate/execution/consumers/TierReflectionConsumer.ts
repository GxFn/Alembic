/**
 * TierReflectionConsumer — 分层反思生成（跨维度 pattern 发现）
 *
 * 结构清洗 W2：自 GenerateConsumers.ts 纯移动拆出。承载
 * consumeGenerateTierReflection：汇总单个 tier 的维度统计、调用 Core 的
 * buildTierReflection 构建跨维度反思并写回 SessionStore。
 * 逻辑与日志文案保持逐字不变。
 */

import type { SessionStore } from '@alembic/agent/memory';
import { buildTierReflection } from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import type { DimensionStat } from './shared.js';

const logger = Logger.getInstance();

// ---------------------------------------------------------------------------
// Tier reflection consumer
// ---------------------------------------------------------------------------

export interface ConsumeGenerateTierReflectionOptions {
  tierIndex: number;
  tierResults: Map<string, DimensionStat>;
  sessionStore: SessionStore;
}

export interface GenerateTierReflection {
  tierIndex: number;
  completedDimensions: string[];
  topFindings: Array<Record<string, unknown>>;
  crossDimensionPatterns: string[];
  suggestionsForNextTier: string[];
}

export function consumeGenerateTierReflection({
  tierIndex,
  tierResults,
  sessionStore,
}: ConsumeGenerateTierReflectionOptions): GenerateTierReflection | null {
  const tierStats = [...tierResults.values()];
  const totalCandidates = tierStats.reduce((s, r) => s + (r.candidateCount || 0), 0);
  logger.info(
    `[generate] Tier ${tierIndex + 1} complete: ${tierResults.size} dimensions, ${totalCandidates} candidates`
  );

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- SessionStore structurally compatible
    const reflection = buildTierReflection(
      tierIndex,
      tierResults as Parameters<typeof buildTierReflection>[1],
      sessionStore as Parameters<typeof buildTierReflection>[2]
    );
    sessionStore.addTierReflection(
      tierIndex,
      reflection as Parameters<typeof sessionStore.addTierReflection>[1]
    );
    logger.info(
      `[generate] Tier ${tierIndex + 1} reflection: ` +
        `${reflection.topFindings.length} top findings, ` +
        `${reflection.crossDimensionPatterns.length} patterns`
    );
    return reflection as GenerateTierReflection;
  } catch (refErr: unknown) {
    logger.warn(
      `[generate] Tier ${tierIndex + 1} reflection failed: ${refErr instanceof Error ? refErr.message : String(refErr)}`
    );
    return null;
  }
}

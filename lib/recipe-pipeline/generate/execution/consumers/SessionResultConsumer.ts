/**
 * SessionResultConsumer — 整体会话结果消费与缺失维度检测
 *
 * 结构清洗 W2：自 GenerateConsumers.ts 纯移动拆出。承载
 * consumeGenerateSessionResult（父会话投影合并、失败/缺失维度告警、
 * 记忆与缓存统计日志）与 consumeMissingGenerateDimensions。
 * 逻辑与日志文案保持逐字不变。
 */

import type { SessionStore } from '@alembic/agent/memory';
import type { AgentRunResult } from '@alembic/agent/service';
import Logger from '@alembic/core/logging';
import {
  type GenerateSessionProjection,
  projectGenerateSessionResult,
} from '../AgentRunProjections.js';
import type { DimensionStat } from './shared.js';

const logger = Logger.getInstance();

// ---------------------------------------------------------------------------
// Session consumer
// ---------------------------------------------------------------------------

export interface ConsumeGenerateSessionResultOptions {
  parentRunResult: AgentRunResult;
  activeDimIds: string[];
  skippedDimIds: string[];
  durationMs: number;
  sessionStore: SessionStore;
  dimensionStats: Record<string, DimensionStat>;
  consumeMissingDimension: (dimId: string) => void;
}

export function consumeGenerateSessionResult({
  parentRunResult,
  activeDimIds,
  skippedDimIds,
  durationMs,
  sessionStore,
  dimensionStats,
  consumeMissingDimension,
}: ConsumeGenerateSessionResultOptions): GenerateSessionProjection {
  const projection = projectGenerateSessionResult({
    parentRunResult,
    activeDimIds,
    skippedDimIds,
  });
  consumeMissingGenerateDimensions({
    missingDimensionIds: projection.missingDimensionIds,
    dimensionStats,
    consumeMissingDimension,
  });
  logger.info(
    `[generate] All tiers complete: ${projection.completedDimensions} dimensions in ${durationMs}ms`
  );
  if (
    projection.parentStatus !== 'success' ||
    projection.failedDimensionIds.length > 0 ||
    projection.abortedDimensionIds.length > 0
  ) {
    logger.warn(
      `[generate] Bootstrap session completed with ${projection.failedDimensionIds.length} failed, ${projection.abortedDimensionIds.length} aborted dimensions (status=${projection.parentStatus})`
    );
  }
  if (projection.missingDimensionIds.length > 0) {
    logger.warn(
      `[generate] Bootstrap session missing dimension results: [${projection.missingDimensionIds.join(', ')}]`
    );
  }

  const emStats = sessionStore.getStats();
  logger.info(
    `[generate] Memory stats: ${emStats.completedDimensions} dims, ` +
      `${emStats.totalFindings} findings, ${emStats.referencedFiles} files, ` +
      `${emStats.crossReferences} cross-refs, ${emStats.tierReflections} reflections`
  );
  if (emStats.cache) {
    logger.info(
      `[generate] Cache stats: ${emStats.cache.hitRate} hit rate, ` +
        `${emStats.cache.searchCacheSize} searches, ${emStats.cache.fileCacheSize} files`
    );
  }
  return projection;
}

export function consumeMissingGenerateDimensions({
  missingDimensionIds,
  dimensionStats,
  consumeMissingDimension,
}: {
  missingDimensionIds: string[];
  dimensionStats: Record<string, DimensionStat>;
  consumeMissingDimension: (dimId: string) => void;
}) {
  for (const dimId of missingDimensionIds) {
    if (dimensionStats[dimId]) {
      continue;
    }
    consumeMissingDimension(dimId);
  }
}

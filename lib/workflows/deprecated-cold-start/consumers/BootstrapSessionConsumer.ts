import type { SessionStore } from '#agent/memory/SessionStore.js';
import type { AgentRunResult } from '#agent/service/index.js';
import Logger from '#infra/logging/Logger.js';
import type { DimensionStat } from '#workflows/deprecated-cold-start/consumers/BootstrapDimensionConsumer.js';
import {
  type BootstrapSessionProjection,
  projectBootstrapSessionResult,
} from '#workflows/deprecated-cold-start/projections/BootstrapSessionProjection.js';

const logger = Logger.getInstance();

export interface ConsumeBootstrapSessionResultOptions {
  parentRunResult: AgentRunResult;
  activeDimIds: string[];
  skippedDimIds: string[];
  durationMs: number;
  sessionStore: SessionStore;
  dimensionStats: Record<string, DimensionStat>;
  consumeMissingDimension: (dimId: string) => void;
}

export function consumeBootstrapSessionResult({
  parentRunResult,
  activeDimIds,
  skippedDimIds,
  durationMs,
  sessionStore,
  dimensionStats,
  consumeMissingDimension,
}: ConsumeBootstrapSessionResultOptions): BootstrapSessionProjection {
  const projection = projectBootstrapSessionResult({
    parentRunResult,
    activeDimIds,
    skippedDimIds,
  });
  consumeMissingBootstrapDimensions({
    missingDimensionIds: projection.missingDimensionIds,
    dimensionStats,
    consumeMissingDimension,
  });
  logger.info(
    `[Insight-v3] All tiers complete: ${projection.completedDimensions} dimensions in ${durationMs}ms`
  );
  if (
    projection.parentStatus !== 'success' ||
    projection.failedDimensionIds.length > 0 ||
    projection.abortedDimensionIds.length > 0
  ) {
    logger.warn(
      `[Insight-v3] Bootstrap session completed with ${projection.failedDimensionIds.length} failed, ${projection.abortedDimensionIds.length} aborted dimensions (status=${projection.parentStatus})`
    );
  }
  if (projection.missingDimensionIds.length > 0) {
    logger.warn(
      `[Insight-v3] Bootstrap session missing dimension results: [${projection.missingDimensionIds.join(', ')}]`
    );
  }

  const emStats = sessionStore.getStats();
  logger.info(
    `[Insight-v3] Memory stats: ${emStats.completedDimensions} dims, ` +
      `${emStats.totalFindings} findings, ${emStats.referencedFiles} files, ` +
      `${emStats.crossReferences} cross-refs, ${emStats.tierReflections} reflections`
  );
  if (emStats.cache) {
    logger.info(
      `[Insight-v3] Cache stats: ${emStats.cache.hitRate} hit rate, ` +
        `${emStats.cache.searchCacheSize} searches, ${emStats.cache.fileCacheSize} files`
    );
  }
  return projection;
}

export function consumeMissingBootstrapDimensions({
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

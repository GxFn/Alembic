import type { AgentRunResult } from '#agent/service/index.js';

export interface BootstrapSessionProjection {
  dimensionResults: Record<string, AgentRunResult>;
  completedDimensions: number;
  failedDimensionIds: string[];
  abortedDimensionIds: string[];
  missingDimensionIds: string[];
  parentStatus: AgentRunResult['status'];
}

export function projectBootstrapSessionResult({
  parentRunResult,
  activeDimIds,
  skippedDimIds,
}: {
  parentRunResult: AgentRunResult;
  activeDimIds: string[];
  skippedDimIds: string[];
}): BootstrapSessionProjection {
  const dimensionResults = toBootstrapSessionDimensionResults(parentRunResult);
  const skipped = new Set(skippedDimIds);
  const runnableDimIds = activeDimIds.filter((dimId) => !skipped.has(dimId));
  const failedStatuses = new Set<AgentRunResult['status']>(['error', 'blocked', 'timeout']);
  const failedDimensionIds = Object.entries(dimensionResults)
    .filter(([, result]) => failedStatuses.has(result.status))
    .map(([dimId]) => dimId);
  const abortedDimensionIds = Object.entries(dimensionResults)
    .filter(([, result]) => result.status === 'aborted')
    .map(([dimId]) => dimId);
  const missingDimensionIds = runnableDimIds.filter((dimId) => !dimensionResults[dimId]);
  return {
    dimensionResults,
    completedDimensions: Object.keys(dimensionResults).length,
    failedDimensionIds,
    abortedDimensionIds,
    missingDimensionIds,
    parentStatus: parentRunResult.status,
  };
}

export function toBootstrapSessionDimensionResults(parentRunResult: AgentRunResult) {
  const dimensionResults = parentRunResult.phases?.dimensionResults;
  if (
    !dimensionResults ||
    typeof dimensionResults !== 'object' ||
    Array.isArray(dimensionResults)
  ) {
    return {};
  }
  return dimensionResults as Record<string, AgentRunResult>;
}

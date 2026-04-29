import type { SessionStore } from '#agent/memory/SessionStore.js';
import Logger from '#infra/logging/Logger.js';
import type { DimensionStat } from '#workflows/capabilities/execution/internal-agent/consumers/BootstrapDimensionConsumer.js';
import { buildTierReflection } from '#workflows/capabilities/planning/dimensions/bootstrapDimensionConfigs.js';

const logger = Logger.getInstance();

export interface ConsumeBootstrapTierReflectionOptions {
  tierIndex: number;
  tierResults: Map<string, DimensionStat>;
  sessionStore: SessionStore;
}

export interface BootstrapTierReflection {
  tierIndex: number;
  completedDimensions: string[];
  topFindings: Array<Record<string, unknown>>;
  crossDimensionPatterns: string[];
  suggestionsForNextTier: string[];
}

export function consumeBootstrapTierReflection({
  tierIndex,
  tierResults,
  sessionStore,
}: ConsumeBootstrapTierReflectionOptions): BootstrapTierReflection | null {
  const tierStats = [...tierResults.values()];
  const totalCandidates = tierStats.reduce((s, r) => s + (r.candidateCount || 0), 0);
  logger.info(
    `[Insight-v3] Tier ${tierIndex + 1} complete: ${tierResults.size} dimensions, ${totalCandidates} candidates`
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
      `[Insight-v3] Tier ${tierIndex + 1} reflection: ` +
        `${reflection.topFindings.length} top findings, ` +
        `${reflection.crossDimensionPatterns.length} patterns`
    );
    return reflection as BootstrapTierReflection;
  } catch (refErr: unknown) {
    logger.warn(
      `[Insight-v3] Tier ${tierIndex + 1} reflection failed: ${refErr instanceof Error ? refErr.message : String(refErr)}`
    );
    return null;
  }
}

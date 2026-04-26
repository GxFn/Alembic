import { EpisodicConsolidator } from '#agent/domain/EpisodicConsolidator.js';
import { MemoryEmbeddingStore } from '#agent/memory/MemoryEmbeddingStore.js';
import { PersistentMemory } from '#agent/memory/PersistentMemory.js';
import type { SessionStore } from '#agent/memory/SessionStore.js';
import Logger from '#infra/logging/Logger.js';

const logger = Logger.getInstance();

export interface ConsolidationResult {
  total: { added: number; updated: number; merged: number; skipped: number };
  durationMs: number;
  [key: string]: unknown;
}

interface SemanticMemoryStats {
  total: number;
  avgImportance: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
}

interface SemanticMemoryLike {
  getStats(): SemanticMemoryStats;
}

interface SemanticConsolidatorLike {
  consolidate(sessionStore: SessionStore, options: Record<string, unknown>): ConsolidationResult;
}

interface BootstrapSemanticMemoryContext {
  container: {
    get(name: string): unknown;
  };
}

export interface ConsumeBootstrapSemanticMemoryOptions {
  ctx: BootstrapSemanticMemoryContext;
  dataRoot: string;
  sessionId: string;
  sessionStore: SessionStore;
  createPersistentMemory?: (db: unknown) => SemanticMemoryLike;
  createConsolidator?: (semanticMemory: SemanticMemoryLike) => SemanticConsolidatorLike;
}

export function consumeBootstrapSemanticMemory({
  ctx,
  dataRoot,
  sessionId,
  sessionStore,
  createPersistentMemory = (db) =>
    new PersistentMemory(db as ConstructorParameters<typeof PersistentMemory>[0], {
      logger,
      embeddingStore: new MemoryEmbeddingStore(dataRoot),
    }),
  createConsolidator = (semanticMemory) =>
    new EpisodicConsolidator(semanticMemory as PersistentMemory, { logger }),
}: ConsumeBootstrapSemanticMemoryOptions): ConsolidationResult | null {
  try {
    const db = ctx.container.get('database');
    if (!db) {
      logger.warn('[Insight-v3] Database not available — skipping Semantic Memory consolidation');
      return null;
    }

    const semanticMemory = createPersistentMemory(db);
    const consolidator = createConsolidator(semanticMemory);
    const consolidationResult = consolidator.consolidate(sessionStore, {
      bootstrapSession: sessionId,
      clearPrevious: true,
    });

    const smStats = semanticMemory.getStats();
    logger.info(
      `[Insight-v3] Semantic Memory consolidation: ` +
        `+${consolidationResult.total.added} ADD, ` +
        `~${consolidationResult.total.updated} UPDATE, ` +
        `⊕${consolidationResult.total.merged} MERGE | ` +
        `Total: ${smStats.total} memories (avg importance: ${smStats.avgImportance})`
    );
    logger.info(
      `[Insight-v3] Memory by type: ${Object.entries(smStats.byType)
        .map(([t, n]) => `${t}=${n}`)
        .join(', ')} | ` +
        `by source: ${Object.entries(smStats.bySource)
          .map(([s, n]) => `${s}=${n}`)
          .join(', ')}`
    );
    logConsolidationDetails(consolidationResult);
    return consolidationResult;
  } catch (consolidateErr: unknown) {
    logger.warn(
      `[Insight-v3] Semantic Memory consolidation failed (non-blocking): ${consolidateErr instanceof Error ? consolidateErr.message : String(consolidateErr)}`
    );
    return null;
  }
}

function logConsolidationDetails(consolidationResult: ConsolidationResult) {
  const cr = consolidationResult as Record<string, unknown>;
  if (cr.perDimension) {
    const perDim = cr.perDimension as Record<string, number>;
    const topDims = Object.entries(perDim)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 6);
    logger.info(
      `[Insight-v3] Memory per-dimension (top ${topDims.length}): ${topDims.map(([d, n]) => `${d}=${n}`).join(', ')}`
    );
  }
  if (cr.importanceDistribution) {
    const hist = cr.importanceDistribution as Record<number, number>;
    const histStr = Object.entries(hist)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([k, v]) => `imp${k}=${v}`)
      .join(' ');
    logger.info(`[Insight-v3] Importance histogram: ${histStr}`);
  }
}

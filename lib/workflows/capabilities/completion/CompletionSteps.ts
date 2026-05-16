/**
 * CompletionSteps — Workflow 完成阶段的各步骤实现
 *
 * 包含 Cursor Delivery、交付验证、Panorama 刷新、Wiki 生成
 * 和语义记忆固化，由 WorkflowCompletionFinalizer 按顺序调用。
 */

import type {
  CompletionContextLike,
  CompletionLogger,
  CompletionSessionLike,
  CompletionSessionStoreLike,
  DeliveryPipelineLike,
  LoadServiceContainer,
  PanoramaServiceLike,
  PersistentMemoryDb,
  WikiGeneratorLike,
  WorkflowSemanticMemoryConsolidationResult,
} from '#workflows/capabilities/completion/WorkflowCompletionTypes.js';

// ── DeliveryCompletionStep ──

export async function runCursorDelivery({
  getServiceContainer,
  log,
}: {
  getServiceContainer: LoadServiceContainer;
  log: CompletionLogger;
}): Promise<void> {
  try {
    const container = await getServiceContainer();
    const pipeline = container.services?.cursorDeliveryPipeline
      ? (container.get?.('cursorDeliveryPipeline') as DeliveryPipelineLike | undefined)
      : undefined;
    if (!pipeline) {
      return;
    }

    const deliveryResult = await pipeline.deliver();
    log.info(
      `[DimensionComplete] Auto Cursor Delivery complete — ` +
        `A: ${deliveryResult.channelA?.rulesCount || 0} rules, ` +
        `B: ${deliveryResult.channelB?.topicCount || 0} topics, ` +
        `C: ${deliveryResult.channelC?.synced || 0} skills, ` +
        `F: ${deliveryResult.channelF?.filesWritten || 0} agent files`
    );
  } catch (err: unknown) {
    log.warn(
      `[DimensionComplete] Auto CursorDelivery failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── DeliveryVerificationStep ──

export async function verifyDelivery({
  ctx,
  log,
}: {
  ctx: CompletionContextLike;
  log: CompletionLogger;
}): Promise<import('#service/bootstrap/DeliveryVerifier.js').DeliveryVerification | null> {
  try {
    const { DeliveryVerifier } = await import('#service/bootstrap/DeliveryVerifier.js');
    const { resolveDataRoot, resolveProjectRoot } = await import('#shared/resolveProjectRoot.js');
    const projectRoot = resolveProjectRoot(ctx.container as never);
    const dataRoot = resolveDataRoot(ctx.container as never) || projectRoot;
    const verifier = new DeliveryVerifier(projectRoot, dataRoot);
    const verification = verifier.verify();
    if (!verification.allPassed) {
      log.warn('[DimensionComplete] Delivery verification incomplete', {
        failures: verification.failures,
      });
    } else {
      log.info('[DimensionComplete] Delivery verification passed — all channels OK');
    }
    return verification;
  } catch (err: unknown) {
    log.warn(
      `[DimensionComplete] DeliveryVerifier failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

// ── PanoramaCompletionStep ──

export async function refreshPanorama({
  getServiceContainer,
  log,
}: {
  getServiceContainer: LoadServiceContainer;
  log: CompletionLogger;
}): Promise<void> {
  try {
    const container = await getServiceContainer();
    const panoramaService = container.services?.panoramaService
      ? (container.get?.('panoramaService') as PanoramaServiceLike | undefined)
      : undefined;
    if (!panoramaService || typeof panoramaService.rescan !== 'function') {
      return;
    }

    await panoramaService.rescan();
    const overview = await panoramaService.getOverview();
    log.info(
      `[DimensionComplete] Panorama refreshed — ${overview.moduleCount} modules, ${overview.gapCount} gaps`
    );
  } catch (err: unknown) {
    log.warn(
      `[DimensionComplete] Panorama refresh failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── WikiCompletionStep ──

export async function generateWiki({
  getServiceContainer,
  projectRoot,
  log,
}: {
  getServiceContainer: LoadServiceContainer;
  projectRoot: string;
  log: CompletionLogger;
}): Promise<void> {
  try {
    const container = await getServiceContainer();
    const { WikiGenerator } = await import('#service/wiki/WikiGenerator.js');
    const moduleService = container.get?.('moduleService');
    const knowledgeService = container.get?.('knowledgeService');
    if (!moduleService || !knowledgeService) {
      return;
    }

    const wikiDeps: import('#service/wiki/WikiGenerator.js').WikiDeps = {
      projectRoot,
      moduleService: moduleService as import('#service/wiki/WikiGenerator.js').WikiModuleService,
      knowledgeService:
        knowledgeService as import('#service/wiki/WikiGenerator.js').WikiKnowledgeService,
      options: { mode: 'bootstrap' },
    };
    const wikiGenerator: WikiGeneratorLike = new WikiGenerator(wikiDeps);
    const wikiResult = await wikiGenerator.generate();
    log.info(
      `[DimensionComplete] Auto Wiki generation: ${(wikiResult as { totalPages?: number }).totalPages || 0} pages`
    );
  } catch (err: unknown) {
    log.warn(
      `[DimensionComplete] Wiki generation failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── SemanticMemoryCompletionStep ──

interface SemanticMemoryConsolidatorLike {
  consolidate(
    sessionStore: CompletionSessionStoreLike,
    options: Record<string, unknown>
  ): Promise<unknown> | unknown;
}

export interface SemanticMemoryCompletionDependencies {
  createPersistentMemory?: (
    db: PersistentMemoryDb,
    dataRoot: string,
    log: CompletionLogger
  ) => Promise<unknown> | unknown;
  createConsolidator?: (
    semanticMemory: unknown,
    log: CompletionLogger
  ) => Promise<SemanticMemoryConsolidatorLike> | SemanticMemoryConsolidatorLike;
}

export async function consolidateSemanticMemory({
  ctx,
  session,
  dataRoot,
  log,
  dependencies = {},
}: {
  ctx: CompletionContextLike;
  session: CompletionSessionLike;
  dataRoot: string;
  log: CompletionLogger;
  dependencies?: SemanticMemoryCompletionDependencies;
}): Promise<WorkflowSemanticMemoryConsolidationResult | null> {
  try {
    const db = ctx.container.get?.('database') ?? ctx.container.get?.('db');
    if (!isPersistentMemoryDb(db) || !isCompletionSessionStore(session.sessionStore)) {
      return null;
    }

    const semanticMemory = dependencies.createPersistentMemory
      ? await dependencies.createPersistentMemory(db, dataRoot, log)
      : await createDefaultPersistentMemory(db, dataRoot, log);
    const consolidator = dependencies.createConsolidator
      ? await dependencies.createConsolidator(semanticMemory, log)
      : await createDefaultConsolidator(semanticMemory, log);
    const result = await consolidator.consolidate(session.sessionStore, {
      bootstrapSession: session.id,
      clearPrevious: true,
    });
    const total = isWorkflowSemanticMemoryConsolidationResult(result) ? result.total : null;
    log.info(
      `[DimensionComplete] Semantic Memory consolidation: +${total?.added || 0} ADD, ~${total?.updated || 0} UPDATE`
    );
    if (isWorkflowSemanticMemoryConsolidationResult(result)) {
      return result;
    }
    return null;
  } catch (err: unknown) {
    log.warn(
      `[DimensionComplete] SemanticMemory consolidation failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

async function createDefaultPersistentMemory(
  db: PersistentMemoryDb,
  dataRoot: string,
  log: CompletionLogger
) {
  const { PersistentMemory } = await import('#agent/memory/PersistentMemory.js');
  const { MemoryEmbeddingStore } = await import('#agent/memory/MemoryEmbeddingStore.js');
  return new PersistentMemory(db, {
    logger: {
      info: (msg: string) => log.info(msg),
      warn: (msg: string) => log.warn(msg),
    },
    embeddingStore: new MemoryEmbeddingStore(dataRoot),
  });
}

async function createDefaultConsolidator(semanticMemory: unknown, log: CompletionLogger) {
  const { EpisodicConsolidator } = await import('#agent/domain/EpisodicConsolidator.js');
  const { PersistentMemory } = await import('#agent/memory/PersistentMemory.js');
  return new EpisodicConsolidator(semanticMemory as InstanceType<typeof PersistentMemory>, {
    logger: {
      info: (msg: string) => log.info(msg),
    },
  });
}

function isPersistentMemoryDb(value: unknown): value is PersistentMemoryDb {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as {
    prepare?: unknown;
    exec?: unknown;
    transaction?: unknown;
    getDb?: unknown;
  };
  return (
    typeof candidate.getDb === 'function' ||
    (typeof candidate.prepare === 'function' &&
      typeof candidate.exec === 'function' &&
      typeof candidate.transaction === 'function')
  );
}

function isCompletionSessionStore(value: unknown): value is CompletionSessionStoreLike {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as {
    getCompletedDimensions?: unknown;
    getDimensionReport?: unknown;
    toJSON?: unknown;
  };
  return (
    typeof candidate.getCompletedDimensions === 'function' &&
    typeof candidate.getDimensionReport === 'function' &&
    typeof candidate.toJSON === 'function'
  );
}

function isWorkflowSemanticMemoryConsolidationResult(
  value: unknown
): value is WorkflowSemanticMemoryConsolidationResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { total?: unknown; durationMs?: unknown };
  if (!candidate.total || typeof candidate.total !== 'object') {
    return false;
  }
  const total = candidate.total as Record<string, unknown>;
  return (
    typeof total.added === 'number' &&
    typeof total.updated === 'number' &&
    typeof total.merged === 'number' &&
    typeof total.skipped === 'number' &&
    typeof candidate.durationMs === 'number'
  );
}

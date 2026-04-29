import type {
  CompletionContextLike,
  CompletionLogger,
  CompletionSessionLike,
  CompletionSessionStoreLike,
  PersistentMemoryDb,
  WorkflowSemanticMemoryConsolidationResult,
} from '#workflows/common-capabilities/completion/WorkflowCompletionTypes.js';

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

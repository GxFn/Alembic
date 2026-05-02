import {
  type CleanupResult,
  CleanupService,
  type RecipeSnapshot,
} from '#service/cleanup/CleanupService.js';

interface CleanupPolicyLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface CleanupPolicyContext {
  projectRoot: string;
  dataRoot?: string;
  db?: unknown;
  logger?: CleanupPolicyLogger;
}

export interface RescanCleanupResult {
  recipeSnapshot: RecipeSnapshot;
  cleanResult: CleanupResult;
}

function createCleanupService(ctx: CleanupPolicyContext): CleanupService {
  return new CleanupService({
    projectRoot: ctx.projectRoot,
    dataRoot: ctx.dataRoot,
    db: ctx.db,
    logger: ctx.logger,
  });
}

export function createCleanupPolicyService(ctx: CleanupPolicyContext): CleanupService {
  return createCleanupService(ctx);
}

export async function runFullResetPolicy(ctx: CleanupPolicyContext): Promise<CleanupResult> {
  return createCleanupService(ctx).fullReset();
}

export async function runRescanCleanPolicy(
  ctx: CleanupPolicyContext
): Promise<RescanCleanupResult> {
  const cleanupService = createCleanupService(ctx);
  const recipeSnapshot = await cleanupService.snapshotRecipes();
  const cleanResult = await cleanupService.rescanClean();
  return { recipeSnapshot, cleanResult };
}

/**
 * 强制 Rescan 清理策略 — 清除会话态缓存但保留增量证据
 * (bootstrap_snapshots, bootstrap_dim_files, recipe_source_refs 不被清除)
 */
export async function runForceRescanCleanPolicy(
  ctx: CleanupPolicyContext
): Promise<RescanCleanupResult> {
  const cleanupService = createCleanupService(ctx);
  const recipeSnapshot = await cleanupService.snapshotRecipes();
  const cleanResult = await cleanupService.forceRescanClean();
  return { recipeSnapshot, cleanResult };
}

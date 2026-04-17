/**
 * UiStartupTasks — asd ui 启动后异步后台刷新任务
 *
 * 在 Dashboard 启动后异步执行，不阻塞 UI:
 *   1. syncAll:               .md → DB 全量同步 + sourceRefs 对账
 *   2. staging promote:       到期 staging → active 晋升
 *   3. vector reconcile:      向量对账（best-effort）
 *   4. refreshIndex:          BM25 增量刷新
 *   5. proposalCheck:         启动时兜底清理（过期 Pending + Observing 兜底评估）
 *   6. signalSubscription:    订阅 SignalBus（信号驱动提案评估）
 */

import Logger from '../../infrastructure/logging/Logger.js';

const logger = Logger.getInstance();

interface UiStartupContext {
  projectRoot: string;
  container: {
    get(name: string): unknown;
    services: Record<string, unknown>;
    singletons: Record<string, unknown>;
  };
}

export interface UiStartupReport {
  syncAll?: { synced: number; created: number; updated: number };
  reconcile?: { inserted: number; active: number; stale: number };
  staging?: { promoted: number };
  vectorReconcile?: { orphans: number; missing: number };
  indexRefresh?: boolean;
  proposalCheck?: { executed: number; rejected: number; expired: number };
  signalSubscription?: boolean;
  durationMs: number;
  errors: string[];
}

/**
 * 异步执行所有启动后台任务。
 * 每个阶段独立 try/catch，一个失败不影响后续。
 */
export async function runUiStartupTasks(ctx: UiStartupContext): Promise<UiStartupReport> {
  const start = Date.now();
  const report: UiStartupReport = { durationMs: 0, errors: [] };

  logger.info('[UiStartupTasks] Starting background refresh...');

  // ── Stage 1: syncAll (.md → DB + sourceRefs reconcile) ──
  try {
    const { KnowledgeSyncService } = await import('../../cli/KnowledgeSyncService.js');
    const { SourceRefReconciler } = await import('../../service/knowledge/SourceRefReconciler.js');
    const sourceRefReconciler = ctx.container.singletons.sourceRefReconciler as
      | InstanceType<typeof SourceRefReconciler>
      | undefined;
    const syncService = new KnowledgeSyncService(ctx.projectRoot, {
      sourceRefReconciler: sourceRefReconciler || undefined,
    });

    const db = ctx.container.get('database');

    const syncReport = await syncService.syncAll(db, { skipViolations: true });
    report.syncAll = {
      synced: syncReport.synced,
      created: syncReport.created,
      updated: syncReport.updated,
    };
    if (syncReport.reconcileReport) {
      report.reconcile = {
        inserted: syncReport.reconcileReport.inserted,
        active: syncReport.reconcileReport.active,
        stale: syncReport.reconcileReport.stale,
      };
    }
    logger.info('[UiStartupTasks] Stage 1 complete: syncAll', report.syncAll);
  } catch (err: unknown) {
    const msg = `syncAll failed: ${(err as Error).message}`;
    report.errors.push(msg);
    logger.warn(`[UiStartupTasks] ${msg}`);
  }

  // ── Stage 2: Staging auto-promotion (Bug 2 fix) ──
  try {
    if (ctx.container.services.stagingManager) {
      const sm = ctx.container.get('stagingManager') as {
        checkAndPromote(): { promoted: { id: string }[] };
      };
      const result = await sm.checkAndPromote();
      report.staging = { promoted: result.promoted.length };
      if (result.promoted.length > 0) {
        logger.info(
          `[UiStartupTasks] Stage 2: auto-promoted ${result.promoted.length} staging entries`
        );
      }
    }
  } catch (err: unknown) {
    const msg = `staging promote failed: ${(err as Error).message}`;
    report.errors.push(msg);
    logger.warn(`[UiStartupTasks] ${msg}`);
  }

  // ── Stage 3: Vector reconcile (best-effort) ──
  try {
    if (ctx.container.services.vectorService) {
      const vectorService = ctx.container.get('vectorService') as {
        syncCoordinator?: {
          reconcile(): Promise<{ orphansRemoved: number; missingQueued: number }>;
        };
      };
      if (
        vectorService.syncCoordinator &&
        typeof vectorService.syncCoordinator.reconcile === 'function'
      ) {
        const result = await vectorService.syncCoordinator.reconcile();
        report.vectorReconcile = {
          orphans: result.orphansRemoved,
          missing: result.missingQueued,
        };
        logger.info('[UiStartupTasks] Stage 3: vector reconcile complete', report.vectorReconcile);
      }
    }
  } catch (err: unknown) {
    const msg = `vector reconcile failed: ${(err as Error).message}`;
    report.errors.push(msg);
    logger.warn(`[UiStartupTasks] ${msg}`);
  }

  // ── Stage 4: BM25 index refresh ──
  try {
    if (ctx.container.services.searchEngine) {
      const searchEngine = ctx.container.get('searchEngine') as {
        refreshIndex(opts?: { force?: boolean }): void;
      };
      searchEngine.refreshIndex({ force: true });
      report.indexRefresh = true;
      logger.info('[UiStartupTasks] Stage 4: BM25 index refreshed');
    }
  } catch (err: unknown) {
    const msg = `index refresh failed: ${(err as Error).message}`;
    report.errors.push(msg);
    logger.warn(`[UiStartupTasks] ${msg}`);
  }

  // ── Stage 5: ProposalExecutor — 启动时兜底清理（过期 Pending + Observing 兜底评估） ──
  try {
    if (ctx.container.services.proposalExecutor) {
      const executor = ctx.container.get('proposalExecutor') as {
        checkAndExecute(): {
          executed: { id: string }[];
          rejected: { id: string }[];
          expired: { id: string }[];
        };
      };
      const result = await executor.checkAndExecute();
      report.proposalCheck = {
        executed: result.executed.length,
        rejected: result.rejected.length,
        expired: result.expired.length,
      };
      const total = result.executed.length + result.rejected.length + result.expired.length;
      if (total > 0) {
        logger.info(
          `[UiStartupTasks] Stage 5: proposal cleanup — executed=${result.executed.length}, rejected=${result.rejected.length}, expired=${result.expired.length}`
        );
      }
    }
  } catch (err: unknown) {
    const msg = `proposal cleanup failed: ${(err as Error).message}`;
    report.errors.push(msg);
    logger.warn(`[UiStartupTasks] ${msg}`);
  }

  // ── Stage 6: ProposalExecutor — 订阅 SignalBus（信号驱动提案评估） ──
  try {
    if (ctx.container.services.proposalExecutor && ctx.container.services.signalBus) {
      const executor = ctx.container.get('proposalExecutor') as {
        subscribeToSignals(bus: unknown): void;
      };
      const signalBus = ctx.container.get('signalBus');
      executor.subscribeToSignals(signalBus);
      logger.info('[UiStartupTasks] Stage 6: ProposalExecutor subscribed to SignalBus');
    }
  } catch (err: unknown) {
    const msg = `signal subscription failed: ${(err as Error).message}`;
    report.errors.push(msg);
    logger.warn(`[UiStartupTasks] ${msg}`);
  }

  report.durationMs = Date.now() - start;
  logger.info(`[UiStartupTasks] All tasks completed in ${report.durationMs}ms`, {
    errors: report.errors.length,
  });

  return report;
}

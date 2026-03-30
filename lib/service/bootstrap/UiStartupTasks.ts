/**
 * UiStartupTasks — asd ui 启动后异步后台刷新任务
 *
 * 在 Dashboard 启动后异步执行，不阻塞 UI:
 *   1. syncAll:               .md → DB 全量同步 + sourceRefs 对账
 *   2. staging promote:       到期 staging → active 晋升
 *   3. vector reconcile:      向量对账（best-effort）
 *   4. refreshIndex:          BM25 增量刷新
 *   5. proposalCheck:         到期 Proposal 检查 + 自动执行/拒绝
 *   6. metabolismCycle:       知识新陈代谢（矛盾/冗余/衰退扫描 → 新 Proposal）
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
  metabolismCycle?: {
    proposalCount: number;
    contradictions: number;
    redundancies: number;
    decaying: number;
  };
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

    const db = ctx.container.get('database') as { getDb(): unknown };
    const rawDb = db.getDb() as Parameters<InstanceType<typeof KnowledgeSyncService>['sync']>[0];

    const syncReport = await syncService.syncAll(rawDb, { skipViolations: true });
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
      const result = sm.checkAndPromote();
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

  // ── Stage 5: ProposalExecutor — 到期 Proposal 检查 + 自动执行 ──
  try {
    if (ctx.container.services.proposalExecutor) {
      const executor = ctx.container.get('proposalExecutor') as {
        checkAndExecute(): {
          executed: { id: string }[];
          rejected: { id: string }[];
          expired: { id: string }[];
        };
      };
      const result = executor.checkAndExecute();
      report.proposalCheck = {
        executed: result.executed.length,
        rejected: result.rejected.length,
        expired: result.expired.length,
      };
      const total = result.executed.length + result.rejected.length + result.expired.length;
      if (total > 0) {
        logger.info(
          `[UiStartupTasks] Stage 5: proposal check — executed=${result.executed.length}, rejected=${result.rejected.length}, expired=${result.expired.length}`
        );
      }
    }
  } catch (err: unknown) {
    const msg = `proposal check failed: ${(err as Error).message}`;
    report.errors.push(msg);
    logger.warn(`[UiStartupTasks] ${msg}`);
  }

  // ── Stage 6: KnowledgeMetabolism — 知识新陈代谢扫描 ──
  try {
    if (ctx.container.services.knowledgeMetabolism) {
      const metabolism = ctx.container.get('knowledgeMetabolism') as {
        runFullCycle(): {
          proposals: unknown[];
          summary: {
            contradictionCount: number;
            redundancyCount: number;
            decayingCount: number;
            proposalCount: number;
          };
        };
      };
      const result = metabolism.runFullCycle();
      report.metabolismCycle = {
        proposalCount: result.summary.proposalCount,
        contradictions: result.summary.contradictionCount,
        redundancies: result.summary.redundancyCount,
        decaying: result.summary.decayingCount,
      };
      if (result.summary.proposalCount > 0) {
        logger.info(
          `[UiStartupTasks] Stage 6: metabolism cycle — ${result.summary.proposalCount} proposals generated`
        );
      }
    }
  } catch (err: unknown) {
    const msg = `metabolism cycle failed: ${(err as Error).message}`;
    report.errors.push(msg);
    logger.warn(`[UiStartupTasks] ${msg}`);
  }

  report.durationMs = Date.now() - start;
  logger.info(`[UiStartupTasks] All tasks completed in ${report.durationMs}ms`, {
    errors: report.errors.length,
  });

  return report;
}

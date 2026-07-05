/**
 * SourceRefSyncConsumer — bootstrap 收尾后的 recipe_source_refs 同步
 *
 * 背景（问题 A，2026-07-06）：
 *   bootstrap 建库路径（gateway create）只写 knowledge_entries，从不填充
 *   recipe_source_refs；该表此前唯一的批量填充点是 rescan Step 1.5 的
 *   SourceRefReconciler（IncrementalRescanWorkflow）。KnowledgeSyncService.syncAll
 *   的 sourceRef 全量扫描已移除，daemon 启动也不再补。结果是全量冷启动产出的
 *   Recipe 在 recipe_map 挂载退化到 repo 级（sourceRefs 为空）、prime 的
 *   locator 证据缺失（degraded knowledge-empty）。
 *
 * 方案（镜像 rescan Step 1.5 的同步路线）：
 *   在 ColdStartWorkflow 启动异步填充时注册一次性 allCompleted 监听
 *   （按 bootstrapSessionId 匹配，形态对齐
 *   registerProjectContextWorkflowSessionReleaseOnGenerateCompletion），
 *   全部维度完成后调用 DI 单例 sourceRefReconciler.reconcile({ force: true })
 *   —— 从 knowledge_entries.reasoning 解析 sources 并 upsert 到
 *   recipe_source_refs。只写 refs 表、幂等、不修改 knowledge_entries。
 *
 * 有意不做（与 rescan 的差异）：
 *   - 不调用 repairRenames()/applyRepairs()：rename 修复会改写 recipe 字段与
 *     .md 文件，属于 rescan 的维护语义；冷启动收尾只需初次填充。
 *   - completed_with_errors / aborted 也照跑：已入库的条目同样需要 refs。
 */

import { RECIPE_PIPELINE_EVENTS } from '@alembic/core/knowledge';

/** 与 ctx.logger 结构对齐的最小日志契约（避免引入宿主 Logger 依赖）。 */
interface SourceRefSyncLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** reconcile 报告的最小结构（与 Core SourceRefReconciler.ReconcileReport 对齐）。 */
interface ReconcileReportLike {
  inserted: number;
  active: number;
  stale: number;
  skipped: number;
  recipesProcessed: number;
  failed: number;
  blockers?: unknown[];
}

interface SourceRefReconcilerLike {
  reconcile(opts?: { force?: boolean }): Promise<ReconcileReportLike>;
}

interface EventBusLike {
  on(eventName: string, listener: (payload: unknown) => void): void;
  off?(eventName: string, listener: (payload: unknown) => void): void;
}

/** container.get 缺注册会 throw —— 统一走防御式取用（对齐 rescan 的取法）。 */
function tryGetService<T>(container: { get(name: string): unknown }, name: string): T | null {
  try {
    return (container.get(name) as T) ?? null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 注册 bootstrap 收尾 SourceRef 同步监听。
 *
 * @returns 解除监听的 detach 闭包；前置条件缺失（无 sessionId / 无 eventBus）
 *   时返回 null 并留 warn 日志（降级安全：refs 缺失只影响挂载精度，不阻塞冷启动）。
 */
export function registerSourceRefSyncOnGenerateCompletion(input: {
  bootstrapSessionId?: string;
  container: { get(name: string): unknown };
  logger: SourceRefSyncLogger;
  logPrefix?: string;
}): (() => void) | null {
  const logPrefix = input.logPrefix || 'Bootstrap';

  if (!input.bootstrapSessionId) {
    input.logger.warn(`[${logPrefix}] SourceRef sync hook skipped`, {
      reason: 'missing-bootstrap-session',
    });
    return null;
  }

  const eventBus = tryGetService<EventBusLike>(input.container, 'eventBus');
  if (!eventBus || typeof eventBus.on !== 'function') {
    input.logger.warn(`[${logPrefix}] SourceRef sync hook skipped`, {
      bootstrapSessionId: input.bootstrapSessionId,
      reason: 'missing-event-bus',
    });
    return null;
  }

  const listener = (payload: unknown) => {
    const event =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    if (stringValue(event.sessionId) !== input.bootstrapSessionId) {
      return;
    }

    // 一次性：命中本 session 即解除，避免监听器随 daemon 生命周期累积。
    eventBus.off?.(RECIPE_PIPELINE_EVENTS.allCompleted, listener);

    const reconciler = tryGetService<SourceRefReconcilerLike>(
      input.container,
      'sourceRefReconciler'
    );
    if (!reconciler || typeof reconciler.reconcile !== 'function') {
      input.logger.warn(`[${logPrefix}] SourceRef sync skipped after completion`, {
        bootstrapSessionId: input.bootstrapSessionId,
        reason: 'missing-source-ref-reconciler',
      });
      return;
    }

    // EventBus 监听是同步调用面 —— 异步 reconcile 用 fire-and-forget + 全量捕获，
    // 失败只降级留痕（refs 可由下次 rescan Step 1.5 补齐），绝不影响完成事件链。
    void reconciler
      .reconcile({ force: true })
      .then((report) => {
        input.logger.info(`[${logPrefix}] SourceRef sync complete after bootstrap`, {
          active: report.active,
          blockers: report.blockers?.length ?? 0,
          bootstrapSessionId: input.bootstrapSessionId,
          failed: report.failed,
          inserted: report.inserted,
          recipesProcessed: report.recipesProcessed,
          skipped: report.skipped,
          stale: report.stale,
          status: stringValue(event.status) ?? null,
        });
      })
      .catch((err: unknown) => {
        input.logger.warn(`[${logPrefix}] SourceRef sync failed after bootstrap (non-blocking)`, {
          bootstrapSessionId: input.bootstrapSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  eventBus.on(RECIPE_PIPELINE_EVENTS.allCompleted, listener);
  return () => eventBus.off?.(RECIPE_PIPELINE_EVENTS.allCompleted, listener);
}

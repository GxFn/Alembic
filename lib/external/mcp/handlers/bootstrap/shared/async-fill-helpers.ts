/**
 * Shared helpers for async AI-fill pipeline dispatch.
 *
 * Previously duplicated in:
 *   - bootstrap-internal.ts (Phase 5)
 *   - rescan-internal.ts (Step 6-7)
 *
 * @module bootstrap/shared/async-fill-helpers
 */

import type { BootstrapSessionShape, DimensionDef } from '#types/project-snapshot.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
import type { McpContext } from '../../types.js';

// ── Task definitions ─────────────────────────────────────

interface TaskDef {
  id: string;
  meta: {
    type: string;
    dimId: string;
    label: string | undefined;
    skillWorthy: boolean;
    skillMeta: Record<string, unknown> | null;
  };
}

/**
 * Build task definitions from dimensions for BootstrapTaskManager.
 */
export function buildTaskDefs(dimensions: DimensionDef[]): TaskDef[] {
  return dimensions.map((dim) => ({
    id: dim.id,
    meta: {
      type: dim.skillWorthy ? 'skill' : 'candidate',
      dimId: dim.id,
      label: dim.label,
      skillWorthy: !!dim.skillWorthy,
      skillMeta: dim.skillMeta || null,
    },
  }));
}

// ── BootstrapTaskManager session ─────────────────────────

interface TaskManagerLogger {
  warn(...args: unknown[]): void;
}

/**
 * Start a BootstrapTaskManager session (graceful degradation if unavailable).
 */
export function startTaskManagerSession(
  container: McpContext['container'],
  taskDefs: TaskDef[],
  logger: TaskManagerLogger,
  logPrefix: string
): BootstrapSessionShape | null {
  try {
    const taskManager = container.get('bootstrapTaskManager');
    return taskManager.startSession(taskDefs) as BootstrapSessionShape;
  } catch (e: unknown) {
    logger.warn(
      `[${logPrefix}] BootstrapTaskManager init failed (graceful degradation): ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

// ── Pipeline Fill View dispatch (Phase D-2) ──────────────

/**
 * Dispatch fillDimensionsV3 from a PipelineFillView.
 *
 * Passes the view directly to orchestrator (no more flat-context expansion).
 * Fires via setImmediate (fire-and-forget).
 *
 * @param view - Typed PipelineFillView from handler
 * @param dimensions - Active dimensions for this run (may differ from snapshot.activeDimensions for rescan gap-only)
 * @param fillDimensionsV3 - The pipeline function to invoke
 * @param logPrefix - Log prefix (e.g. 'Bootstrap', 'Rescan-Internal')
 */
export function dispatchPipelineFill(
  view: PipelineFillView,
  dimensions: DimensionDef[],
  fillDimensionsV3: (view: PipelineFillView, dimensions: DimensionDef[]) => Promise<void>,
  logPrefix: string
): void {
  const ctxLogger = view.ctx.logger as
    | { info(...args: unknown[]): void; error(...args: unknown[]): void }
    | undefined;
  setImmediate(() => {
    ctxLogger?.info(`[${logPrefix}] Dispatching v3 AI-First pipeline`);
    fillDimensionsV3(view, dimensions).catch((e: unknown) => {
      ctxLogger?.error(
        `[${logPrefix}] Async fill failed: ${e instanceof Error ? e.message : String(e)}`
      );
    });
  });
}

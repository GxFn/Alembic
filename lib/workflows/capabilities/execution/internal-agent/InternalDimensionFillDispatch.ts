import type { BootstrapSessionShape, DimensionDef } from '#types/project-snapshot.js';
import type { PipelineFillView } from '#types/snapshot-views.js';

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

interface TaskManagerContainer {
  get(name: string): unknown;
}

interface TaskManagerLogger {
  warn(...args: unknown[]): void;
}

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

export function startTaskManagerSession(
  container: TaskManagerContainer,
  taskDefs: TaskDef[],
  logger: TaskManagerLogger,
  logPrefix: string
): BootstrapSessionShape | null {
  try {
    const taskManager = container.get('bootstrapTaskManager') as {
      startSession(taskDefs: TaskDef[]): BootstrapSessionShape;
    };
    return taskManager.startSession(taskDefs);
  } catch (err: unknown) {
    logger.warn(
      `[${logPrefix}] BootstrapTaskManager init failed (graceful degradation): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

export function dispatchPipelineFill(
  view: PipelineFillView,
  dimensions: DimensionDef[],
  fillDimensions: (view: PipelineFillView, dimensions: DimensionDef[]) => Promise<void>,
  logPrefix: string
): void {
  const ctxLogger = view.ctx.logger as
    | { info(...args: unknown[]): void; error(...args: unknown[]): void }
    | undefined;
  setImmediate(() => {
    ctxLogger?.info(`[${logPrefix}] Dispatching v3 AI-First pipeline`);
    fillDimensions(view, dimensions).catch((err: unknown) => {
      ctxLogger?.error(
        `[${logPrefix}] Async fill failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  });
}

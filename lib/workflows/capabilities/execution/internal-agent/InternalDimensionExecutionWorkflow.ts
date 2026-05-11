import type { DimensionDef } from '#types/project-snapshot.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
import { runInternalDimensionExecution } from '#workflows/capabilities/execution/internal-agent/InternalDimensionExecutionPipeline.js';
import {
  buildTaskDefs,
  dispatchPipelineFill,
  startTaskManagerSession,
} from '#workflows/capabilities/execution/internal-agent/InternalDimensionFillDispatch.js';

export type DimensionExecutionTaskDefs = ReturnType<typeof buildTaskDefs>;
export type DimensionExecutionContainer = Parameters<typeof startTaskManagerSession>[0];
export type DimensionExecutionLogger = Parameters<typeof startTaskManagerSession>[2];
export type DimensionExecutionSession = ReturnType<typeof startTaskManagerSession>;

export interface InternalDimensionExecutionSessionPlan {
  taskDefs: DimensionExecutionTaskDefs;
  bootstrapSession: DimensionExecutionSession;
}

export function buildInternalDimensionExecutionTaskDefs(
  dimensions: DimensionDef[]
): DimensionExecutionTaskDefs {
  return buildTaskDefs(dimensions);
}

export function startInternalDimensionExecutionSession(opts: {
  container: DimensionExecutionContainer;
  dimensions: DimensionDef[];
  logger: DimensionExecutionLogger;
  logPrefix: string;
}): InternalDimensionExecutionSessionPlan {
  const taskDefs = buildInternalDimensionExecutionTaskDefs(opts.dimensions);
  const bootstrapSession = startTaskManagerSession(
    opts.container,
    taskDefs,
    opts.logger,
    opts.logPrefix
  );
  return { taskDefs, bootstrapSession };
}

export function dispatchInternalDimensionExecution(opts: {
  view: PipelineFillView;
  dimensions: DimensionDef[];
  logPrefix: string;
}): void {
  dispatchPipelineFill(opts.view, opts.dimensions, runInternalDimensionExecution, opts.logPrefix);
}

export type DimensionFillTaskDefs = DimensionExecutionTaskDefs;
export type DimensionFillContainer = DimensionExecutionContainer;
export type DimensionFillLogger = DimensionExecutionLogger;
export type DimensionFillSession = DimensionExecutionSession;
export type InternalDimensionFillSessionPlan = InternalDimensionExecutionSessionPlan;

export const buildInternalDimensionFillTaskDefs = buildInternalDimensionExecutionTaskDefs;
export const startInternalDimensionFillSession = startInternalDimensionExecutionSession;
export const dispatchInternalDimensionFill = dispatchInternalDimensionExecution;

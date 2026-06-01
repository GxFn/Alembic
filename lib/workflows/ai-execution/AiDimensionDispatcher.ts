import type { DimensionDef } from '@alembic/core/project-intelligence';
import type { PipelineFillView } from '@alembic/core/types';
import { runAiDimensionPipeline } from './AiDimensionPipeline.js';
import {
  buildTaskDefs,
  dispatchPipelineFill,
  startTaskManagerSession,
} from './TaskManagerDispatch.js';

export type DimensionExecutionTaskDefs = ReturnType<typeof buildTaskDefs>;
export type DimensionExecutionContainer = Parameters<typeof startTaskManagerSession>[0];
export type DimensionExecutionLogger = Parameters<typeof startTaskManagerSession>[2];
export type DimensionExecutionSession = ReturnType<typeof startTaskManagerSession>;

export interface AiDimensionSessionPlan {
  taskDefs: DimensionExecutionTaskDefs;
  bootstrapSession: DimensionExecutionSession;
}

export function buildAiDimensionTaskDefs(dimensions: DimensionDef[]): DimensionExecutionTaskDefs {
  return buildTaskDefs(dimensions);
}

export function startAiDimensionSession(opts: {
  container: DimensionExecutionContainer;
  dimensions: DimensionDef[];
  logger: DimensionExecutionLogger;
  logPrefix: string;
}): AiDimensionSessionPlan {
  const taskDefs = buildAiDimensionTaskDefs(opts.dimensions);
  const bootstrapSession = startTaskManagerSession(
    opts.container,
    taskDefs,
    opts.logger,
    opts.logPrefix
  );
  return { taskDefs, bootstrapSession };
}

export function dispatchAiDimensionRuns(opts: {
  view: PipelineFillView;
  dimensions: DimensionDef[];
  logPrefix: string;
}): void {
  dispatchPipelineFill(opts.view, opts.dimensions, runAiDimensionPipeline, opts.logPrefix);
}

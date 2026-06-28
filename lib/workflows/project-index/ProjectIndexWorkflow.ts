import type {
  InternalColdStartArgs,
  InternalKnowledgeRescanArgs,
  WorkflowMcpContext,
} from '@alembic/core/host-agent-workflows';
import type { PlanSelectionProjection } from '@alembic/core/plans';
import type { McpContext } from '@alembic/core/types';
import type { ProjectContextWorkflowFacts } from '../project-context/ProjectContextWorkflowFacts.js';

export type ProjectIndexWorkflowMode = 'full' | 'incremental';
export type ProjectIndexMcpContext = WorkflowMcpContext & McpContext;

export type ProjectIndexFullArgs = InternalColdStartArgs & {
  planSelectionProjection?: PlanSelectionProjection;
  projectContextFacts?: ProjectContextWorkflowFacts;
};
export type ProjectIndexIncrementalArgs = InternalKnowledgeRescanArgs;

type ProjectIndexFullWorkflowRunner = (
  ctx: ProjectIndexMcpContext,
  args: ProjectIndexFullArgs
) => Promise<unknown>;
type ProjectIndexIncrementalWorkflowRunner = (
  ctx: ProjectIndexMcpContext,
  args: ProjectIndexIncrementalArgs
) => Promise<unknown>;

const implementations: {
  full?: ProjectIndexFullWorkflowRunner;
  incremental?: ProjectIndexIncrementalWorkflowRunner;
} = {};

export function registerProjectIndexWorkflowImplementation(
  mode: 'full',
  runner: ProjectIndexFullWorkflowRunner
): void;
export function registerProjectIndexWorkflowImplementation(
  mode: 'incremental',
  runner: ProjectIndexIncrementalWorkflowRunner
): void;
export function registerProjectIndexWorkflowImplementation(
  mode: ProjectIndexWorkflowMode,
  runner: ProjectIndexFullWorkflowRunner | ProjectIndexIncrementalWorkflowRunner
): void {
  if (mode === 'full') {
    implementations.full = runner as ProjectIndexFullWorkflowRunner;
    return;
  }
  implementations.incremental = runner as ProjectIndexIncrementalWorkflowRunner;
}

export async function runProjectIndexWorkflow(
  ctx: ProjectIndexMcpContext,
  args: ProjectIndexFullArgs,
  options: { mode: 'full' }
): Promise<unknown>;
export async function runProjectIndexWorkflow(
  ctx: ProjectIndexMcpContext,
  args: ProjectIndexIncrementalArgs,
  options: { mode: 'incremental' }
): Promise<unknown>;
export async function runProjectIndexWorkflow(
  ctx: ProjectIndexMcpContext,
  args: ProjectIndexFullArgs | ProjectIndexIncrementalArgs,
  options: { mode: ProjectIndexWorkflowMode }
): Promise<unknown> {
  ctx.logger.info('[ProjectIndexWorkflow] Dispatching project-index workflow', {
    mode: options.mode,
  });
  if (options.mode === 'full') {
    const runner = await loadProjectIndexWorkflowImplementation('full');
    return runner(ctx, args as ProjectIndexFullArgs);
  }
  const runner = await loadProjectIndexWorkflowImplementation('incremental');
  return runner(ctx, args as ProjectIndexIncrementalArgs);
}

async function loadProjectIndexWorkflowImplementation(
  mode: 'full'
): Promise<ProjectIndexFullWorkflowRunner>;
async function loadProjectIndexWorkflowImplementation(
  mode: 'incremental'
): Promise<ProjectIndexIncrementalWorkflowRunner>;
async function loadProjectIndexWorkflowImplementation(
  mode: ProjectIndexWorkflowMode
): Promise<ProjectIndexFullWorkflowRunner | ProjectIndexIncrementalWorkflowRunner> {
  const existing = implementations[mode];
  if (existing) {
    return existing;
  }

  if (mode === 'full') {
    await import('../cold-start/ColdStartWorkflow.js');
  } else {
    await import('../knowledge-rescan/KnowledgeRescanWorkflow.js');
  }

  const loaded = implementations[mode];
  if (!loaded) {
    throw new Error(`ProjectIndexWorkflow implementation not registered for mode=${mode}`);
  }
  return loaded;
}

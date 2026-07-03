import type {
  InternalColdStartArgs,
  InternalKnowledgeRescanArgs,
  WorkflowMcpContext,
} from '@alembic/core/host-agent-workflows';
import type { PlanSelectionProjection } from '@alembic/core/plans';
import type { McpContext } from '@alembic/core/types';
import type { ProjectContextWorkflowFacts } from '../../project-facts/ProjectContextWorkflowFacts.js';

export type GenerateWorkflowMode = 'full' | 'incremental';
export type GenerateWorkflowMcpContext = WorkflowMcpContext & McpContext;

export type GenerateFullArgs = InternalColdStartArgs & {
  planSelectionProjection?: PlanSelectionProjection;
  projectContextFacts?: ProjectContextWorkflowFacts;
};
export type GenerateIncrementalArgs = InternalKnowledgeRescanArgs;

type ProjectIndexFullWorkflowRunner = (
  ctx: GenerateWorkflowMcpContext,
  args: GenerateFullArgs
) => Promise<unknown>;
type ProjectIndexIncrementalWorkflowRunner = (
  ctx: GenerateWorkflowMcpContext,
  args: GenerateIncrementalArgs
) => Promise<unknown>;

const implementations: {
  full?: ProjectIndexFullWorkflowRunner;
  incremental?: ProjectIndexIncrementalWorkflowRunner;
} = {};

export function registerGenerateWorkflowImplementation(
  mode: 'full',
  runner: ProjectIndexFullWorkflowRunner
): void;
export function registerGenerateWorkflowImplementation(
  mode: 'incremental',
  runner: ProjectIndexIncrementalWorkflowRunner
): void;
export function registerGenerateWorkflowImplementation(
  mode: GenerateWorkflowMode,
  runner: ProjectIndexFullWorkflowRunner | ProjectIndexIncrementalWorkflowRunner
): void {
  if (mode === 'full') {
    implementations.full = runner as ProjectIndexFullWorkflowRunner;
    return;
  }
  implementations.incremental = runner as ProjectIndexIncrementalWorkflowRunner;
}

export async function runGenerateWorkflow(
  ctx: GenerateWorkflowMcpContext,
  args: GenerateFullArgs,
  options: { mode: 'full' }
): Promise<unknown>;
export async function runGenerateWorkflow(
  ctx: GenerateWorkflowMcpContext,
  args: GenerateIncrementalArgs,
  options: { mode: 'incremental' }
): Promise<unknown>;
export async function runGenerateWorkflow(
  ctx: GenerateWorkflowMcpContext,
  args: GenerateFullArgs | GenerateIncrementalArgs,
  options: { mode: GenerateWorkflowMode }
): Promise<unknown> {
  ctx.logger.info('[GenerateWorkflow] Dispatching generate workflow', {
    mode: options.mode,
  });
  if (options.mode === 'full') {
    const runner = await loadGenerateWorkflowImplementation('full');
    return runner(ctx, args as GenerateFullArgs);
  }
  const runner = await loadGenerateWorkflowImplementation('incremental');
  return runner(ctx, args as GenerateIncrementalArgs);
}

async function loadGenerateWorkflowImplementation(
  mode: 'full'
): Promise<ProjectIndexFullWorkflowRunner>;
async function loadGenerateWorkflowImplementation(
  mode: 'incremental'
): Promise<ProjectIndexIncrementalWorkflowRunner>;
async function loadGenerateWorkflowImplementation(
  mode: GenerateWorkflowMode
): Promise<ProjectIndexFullWorkflowRunner | ProjectIndexIncrementalWorkflowRunner> {
  const existing = implementations[mode];
  if (existing) {
    return existing;
  }

  if (mode === 'full') {
    await import('./ColdStartWorkflow.js');
  } else {
    await import('../sustain/KnowledgeRescanWorkflow.js');
  }

  const loaded = implementations[mode];
  if (!loaded) {
    throw new Error(`ProjectIndexWorkflow implementation not registered for mode=${mode}`);
  }
  return loaded;
}

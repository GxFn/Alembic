import type { AgentService, SystemRunContextFactory } from '#agent/service/index.js';
import Logger from '#infra/logging/Logger.js';
import { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import { resolveDataRoot } from '#shared/resolveProjectRoot.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
import type { IncrementalPlan } from '#types/workflows.js';
import type { BootstrapFileEntry } from '#workflows/capabilities/execution/internal-agent/BootstrapInputBuilders.js';
import type {
  BootstrapTaskManagerLike,
  BootstrapWorkflowContext,
} from '#workflows/capabilities/execution/internal-agent/InternalDimensionFillTypes.js';

const logger = Logger.getInstance();

export interface InternalDimensionFillPreparation {
  view: PipelineFillView;
  dimensions: DimensionDef[];
  ctx: BootstrapWorkflowContext;
  projectRoot: string;
  dataRoot: string;
  depGraphData: PipelineFillView['snapshot']['dependencyGraph'];
  guardAudit: PipelineFillView['snapshot']['guardAudit'];
  primaryLang: string;
  astProjectSummary: PipelineFillView['snapshot']['ast'];
  incrementalPlan: IncrementalPlan | null;
  panoramaResult: Record<string, unknown> | null;
  callGraphResult: PipelineFillView['snapshot']['callGraph'];
  existingRecipes: unknown;
  evolutionPrescreen: unknown;
  rescanExecutionDecisions: PipelineFillView['rescanExecutionDecisions'];
  targetFileMap: PipelineFillView['targetFileMap'];
  taskManager: BootstrapTaskManagerLike | null;
  sessionId: string;
  sessionAbortSignal: AbortSignal | null;
  isIncremental: boolean;
  emitter: BootstrapEventEmitter;
  allFiles: BootstrapFileEntry[] | null;
  agentService: AgentService | null;
  systemRunContextFactory: SystemRunContextFactory | null;
  isMockMode: boolean;
  skipTargetDelivery: boolean;
}

export function prepareInternalDimensionFillRun(
  view: PipelineFillView,
  dimensions: DimensionDef[]
): InternalDimensionFillPreparation {
  const { snapshot, projectRoot } = view;
  const ctx = view.ctx as BootstrapWorkflowContext;
  const dataRoot =
    resolveDataRoot(ctx.container as { singletons?: Record<string, unknown> }) || projectRoot;
  const incrementalPlan = snapshot.incrementalPlan as IncrementalPlan | null;
  const isIncremental =
    incrementalPlan?.canIncremental === true && incrementalPlan.mode === 'incremental';
  const emitter = new BootstrapEventEmitter(ctx.container);

  let taskManager: BootstrapTaskManagerLike | null = null;
  try {
    taskManager = ctx.container.get('bootstrapTaskManager') as BootstrapTaskManagerLike;
  } catch {
    /* not available */
  }

  let agentService: AgentService | null = null;
  let systemRunContextFactory: SystemRunContextFactory | null = null;
  let isMockMode = false;
  try {
    const manager = ctx.container.singletons?._aiProviderManager as { isMock: boolean } | undefined;
    isMockMode = manager?.isMock ?? false;
    if (!isMockMode) {
      agentService = ctx.container.get('agentService');
      systemRunContextFactory = ctx.container.get('systemRunContextFactory');
    }
  } catch {
    /* not available */
  }

  logger.info(
    `[InternalDimensionExecution] ═══ entered — ${isIncremental ? 'INCREMENTAL' : 'FULL'} pipeline`
  );

  return {
    view,
    dimensions,
    ctx,
    projectRoot,
    dataRoot,
    depGraphData: snapshot.dependencyGraph,
    guardAudit: snapshot.guardAudit,
    primaryLang: snapshot.language.primaryLang ?? 'unknown',
    astProjectSummary: snapshot.ast,
    incrementalPlan,
    panoramaResult: snapshot.panorama as Record<string, unknown> | null,
    callGraphResult: snapshot.callGraph,
    existingRecipes: view.existingRecipes ?? null,
    evolutionPrescreen: view.evolutionPrescreen ?? null,
    rescanExecutionDecisions: view.rescanExecutionDecisions,
    targetFileMap: view.targetFileMap,
    taskManager,
    sessionId: view.bootstrapSession?.id ?? '',
    sessionAbortSignal: taskManager?.getSessionAbortSignal?.() ?? null,
    isIncremental,
    emitter,
    allFiles: snapshot.allFiles as unknown as BootstrapFileEntry[] | null,
    agentService,
    systemRunContextFactory,
    isMockMode,
    skipTargetDelivery: view.skipTargetDelivery === true,
  };
}

export function emitInternalDimensionFillAiUnavailable(
  preparation: InternalDimensionFillPreparation
): void {
  logger.error('[Insight-v3] AI Provider not available — bootstrap requires AI');
  preparation.emitter.emitProgress('bootstrap:ai-unavailable', {
    message:
      'AI Provider 不可用，Bootstrap 需要 AI 才能运行。请先配置 AI Provider（如 OpenAI、Anthropic 等）后重试。',
  });
  for (const dim of preparation.dimensions) {
    preparation.emitter.emitDimensionComplete(dim.id, {
      type: 'skipped',
      reason: 'ai-unavailable',
    });
  }
}

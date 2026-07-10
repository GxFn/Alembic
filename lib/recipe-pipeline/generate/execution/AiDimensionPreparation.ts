import type { AgentService, SystemRunContextFactory } from '@alembic/agent/service';
import { type SourceGraphLifecycleResult, SourceGraphLifecycleService } from '@alembic/core';
import Logger from '@alembic/core/logging';
import type { DimensionDef, IncrementalPlan } from '@alembic/core/types';
import { resolveDataRoot } from '@alembic/core/workspace';
import { getAiRuntimeStatus } from '#inject/AiRuntimeStatus.js';
import { GenerateEventEmitter } from '#recipe-pipeline/generate/runtime/GenerateEventEmitter.js';
import {
  type ProjectContextDependencyGraph,
  projectContextDependencyGraph,
} from '../../../project-facts/ProjectContextConsumerFacts.js';
import type { ProjectContextFillView } from '../../../project-facts/ProjectContextWorkflowFacts.js';
import {
  type ProjectScopeSourceIdentity,
  resolveProjectScopeSourceIdentitiesFromCarrier,
} from '../../../project-scope/ProjectScopeAnalysis.js';
import type { GenerateFileEntry } from './AgentRunInputBuilders.js';
import type { GenerateTaskManagerLike, GenerateWorkflowContext } from './AiDimensionTypes.js';

const logger = Logger.getInstance();

export interface AiDimensionPreparation {
  view: ProjectContextFillView;
  dimensions: DimensionDef[];
  ctx: GenerateWorkflowContext;
  projectRoot: string;
  dataRoot: string;
  /**
   * 声明式模块依赖图(2026-07-10 接线):来自 Discoverer 清单解析(SPM target deps/
   * easybox boxspec dependency),经快照 normalizeDepGraph 进 briefing,让维度挖掘
   * 看到模块结构的权威声明。获取失败降级 null(与历史行为一致,不阻断挖掘)。
   */
  depGraphData: ProjectContextDependencyGraph | null;
  /**
   * Track2(2026-07-10)source-graph 激活:catchUpOnStartup 幂等编排(无快照全量/
   * stale 增量/fresh noop),files 全语言入库+JS 系实体/边。observe-first:本期只
   * 建库+日志,不进维度 prompt/briefing(Swift 实体解析与 prompt 消费登记后续)。
   * 失败降级 null,不阻断挖掘。
   */
  sourceGraphResult: SourceGraphLifecycleResult | null;
  guardAudit: null;
  primaryLang: string;
  astProjectSummary: null;
  incrementalPlan: IncrementalPlan | null;
  panoramaResult: Record<string, unknown> | null;
  callGraphResult: null;
  existingRecipes: unknown;
  evolutionPrescreen: unknown;
  rescanExecutionDecisions: ProjectContextFillView['rescanExecutionDecisions'];
  targetFileMap: ProjectContextFillView['targetFileMap'];
  taskManager: GenerateTaskManagerLike | null;
  sessionId: string;
  sessionAbortSignal: AbortSignal | null;
  isIncremental: boolean;
  emitter: GenerateEventEmitter;
  allFiles: GenerateFileEntry[] | null;
  projectScopeSourceIdentities: ProjectScopeSourceIdentity[];
  onDimensionResult: ProjectContextFillView['onDimensionResult'];
  agentService: AgentService | null;
  systemRunContextFactory: SystemRunContextFactory | null;
  aiUnavailable: boolean;
  skipTargetDelivery: boolean;
}

export async function prepareAiDimensionPipeline(
  view: ProjectContextFillView,
  dimensions: DimensionDef[]
): Promise<AiDimensionPreparation> {
  const { projectContextFacts, projectRoot } = view;
  const ctx = view.ctx as GenerateWorkflowContext;
  const projectScopeSourceIdentities = resolveProjectScopeSourceIdentitiesFromCarrier(view);
  const dataRoot =
    resolveDataRoot(ctx.container as { singletons?: Record<string, unknown> }) || projectRoot;
  const incrementalPlan = projectContextFacts.incrementalPlan;
  const isIncremental =
    incrementalPlan?.canIncremental === true && incrementalPlan.mode === 'incremental';
  const emitter = new GenerateEventEmitter(ctx.container);

  let taskManager: GenerateTaskManagerLike | null = null;
  try {
    taskManager = ctx.container.get('generateTaskManager') as GenerateTaskManagerLike;
  } catch {
    /* not available */
  }

  let agentService: AgentService | null = null;
  let systemRunContextFactory: SystemRunContextFactory | null = null;
  const aiStatus = getAiRuntimeStatus(ctx.container);
  try {
    if (aiStatus.ready) {
      agentService = ctx.container.get('agentService');
      systemRunContextFactory = ctx.container.get('systemRunContextFactory');
    }
  } catch {
    /* not available */
  }

  logger.info(`[AiDimension] ═══ entered — ${isIncremental ? 'INCREMENTAL' : 'FULL'} pipeline`);

  // 声明式依赖图接线(2026-07-10):此前恒 null,briefing 的 dependencyGraph 槽位
  // 从未被填过。失败降级 null 并打日志(不阻断挖掘,行为回落与历史一致)。
  let depGraphData: ProjectContextDependencyGraph | null = null;
  try {
    depGraphData = await projectContextDependencyGraph(projectRoot);
    logger.info(
      `[AiDimension] dependency graph loaded: nodes=${depGraphData.nodes.length} edges=${depGraphData.edges.length} source=${String(depGraphData.dependencySummary?.declaredEdgeSource ?? 'project-context')}`
    );
  } catch (err: unknown) {
    logger.warn(
      `[AiDimension] dependency graph unavailable — briefing proceeds without it: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Track2 source-graph 激活:catchUpOnStartup 幂等(全量/增量/noop),
  // durableTables 计数即观测面。失败降级 null,不阻断挖掘。
  let sourceGraphResult: SourceGraphLifecycleResult | null = null;
  try {
    const { getCoreRepositoryBundle } = await import('../../../injection/modules/InfraModule.js');
    // GenerateWorkflowContainer 是 ServiceContainer 的窄化视图,运行时同一实例;
    // repository bundle 缓存挂在 singletons,经 unknown 桥接取全量容器形态。
    const repositories = getCoreRepositoryBundle(
      ctx.container as unknown as Parameters<typeof getCoreRepositoryBundle>[0]
    );
    const lifecycle = new SourceGraphLifecycleService(
      repositories.sourceGraphRepository as ConstructorParameters<
        typeof SourceGraphLifecycleService
      >[0]
    );
    const startedAtMs = Date.now();
    sourceGraphResult = await lifecycle.catchUpOnStartup({ projectRoot });
    logger.info(
      `[AiDimension] source graph ${sourceGraphResult.action} (${sourceGraphResult.reason}): ` +
        `files=${sourceGraphResult.durableTables.source_graph_files} ` +
        `symbols=${sourceGraphResult.durableTables.source_graph_symbols} ` +
        `edges=${sourceGraphResult.durableTables.source_graph_edges} ` +
        `durationMs=${Date.now() - startedAtMs}`
    );
  } catch (err: unknown) {
    logger.warn(
      `[AiDimension] source graph catch-up unavailable — mining proceeds without it: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return {
    view,
    dimensions,
    ctx,
    projectRoot,
    dataRoot,
    depGraphData,
    sourceGraphResult,
    guardAudit: null,
    primaryLang: projectContextFacts.primaryLang ?? 'unknown',
    astProjectSummary: null,
    incrementalPlan,
    panoramaResult: null,
    callGraphResult: null,
    existingRecipes: view.existingRecipes ?? null,
    evolutionPrescreen: view.evolutionPrescreen ?? null,
    rescanExecutionDecisions: view.rescanExecutionDecisions,
    targetFileMap: view.targetFileMap,
    taskManager,
    sessionId: view.bootstrapSession?.id ?? '',
    sessionAbortSignal: taskManager?.getSessionAbortSignal?.() ?? null,
    isIncremental,
    emitter,
    allFiles: projectContextFacts.allFiles as GenerateFileEntry[] | null,
    projectScopeSourceIdentities,
    onDimensionResult: view.onDimensionResult,
    agentService,
    systemRunContextFactory,
    aiUnavailable: !aiStatus.ready,
    skipTargetDelivery: view.skipTargetDelivery === true,
  };
}

export function emitAiDimensionAiUnavailable(preparation: AiDimensionPreparation): void {
  logger.error('[generate] AI Provider not available — bootstrap requires AI');
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

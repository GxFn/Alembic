import type { AgentService, SystemRunContextFactory } from '@alembic/agent/service';
import { type SourceGraphLifecycleResult, SourceGraphLifecycleService } from '@alembic/core';
import { getOrCreateSessionManager } from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import type { DimensionDef, IncrementalPlan } from '@alembic/core/types';
import { resolveDataRoot } from '@alembic/core/workspace';
import { getAiRuntimeStatus } from '#inject/AiRuntimeStatus.js';
import { GenerateEventEmitter } from '#recipe-pipeline/generate/runtime/GenerateEventEmitter.js';
import {
  dependencyGraphFromCertifiedFacts,
  MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS,
  persistMainCertifiedProjectFactsCarrier,
  readMainCertifiedCarrierFromProjectContext,
  reopenMainCertifiedProjectFactsConsumer,
  sameMainCertifiedProjectFactsBinding,
} from '../../../project-facts/CertifiedProjectFactsRuntime.js';
import {
  type ProjectContextDependencyGraph,
  projectContextDependencyGraph,
} from '../../../project-facts/ProjectContextConsumerFacts.js';
import type { ProjectContextFillView } from '../../../project-facts/ProjectContextWorkflowFacts.js';
import {
  type ProjectScopeSourceIdentity,
  resolveProjectScopeSourceIdentitiesFromCarrier,
  resolveSourceIndexOptions,
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
   * SourceGraph 是按当前真实 ProjectScope 读取的 live 辅助观测，不绑定或改写
   * 上面的 certified closure。JS/TS 使用 Core CodeGraph，其他语言沿用 Core 策略；
   * prompt 计数消费仍由既有 eval 开关控制。普通失败降级 null，取消必须停止准备。
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

  // 绑定本次准备已有的session；abortSession会清空manager中的controller，不能在
  // 异步索引结束后再取signal。更早的pre-plan尚无session时仍保持null，不制造取消令牌。
  const sessionAbortSignal = taskManager?.getSessionAbortSignal?.() ?? null;

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

  // strict-v2 必须从同一 reopened artifact 的命名 projection 取图，缺失或绑定漂移
  // 直接失败；仅未迁移的 legacy/rescan carrier 保留历史 ProjectContext 降级路径。
  let depGraphData: ProjectContextDependencyGraph | null = null;
  if (projectContextFacts.certifiedProjectFacts) {
    const workflowSession = getOrCreateSessionManager(ctx.container).getAnySession(undefined, {
      projectRoot,
    });
    const sessionCarrier = readMainCertifiedCarrierFromProjectContext(
      workflowSession?.toSnapshot().projectContext
    );
    if (
      !workflowSession ||
      !sessionCarrier ||
      !sameMainCertifiedProjectFactsBinding(
        sessionCarrier,
        projectContextFacts.certifiedProjectFacts
      )
    ) {
      throw new TypeError(
        'Certified dependency graph requires the same persisted Generate session binding.'
      );
    }
    const dependencyConsumer = await reopenMainCertifiedProjectFactsConsumer({
      carrier: sessionCarrier,
      consumer: 'dependency-graph',
      dataRoot,
      entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS['dependency-graph'],
    });
    const workflowSessionId = persistMainCertifiedProjectFactsCarrier({
      carrier: sessionCarrier,
      projectRoot,
      session: workflowSession,
    });
    projectContextFacts.certifiedProjectFacts = sessionCarrier;
    depGraphData = dependencyGraphFromCertifiedFacts(
      projectContextFacts,
      dependencyConsumer.projection
    );
    logger.info(
      `[AiDimension] certified dependency graph loaded: nodes=${depGraphData.nodes.length} edges=${depGraphData.edges.length} source=${String(depGraphData.dependencySummary?.declaredEdgeSource ?? 'certified-project-facts')} workflowSessionId=${workflowSessionId}`
    );
  } else {
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
  }

  // 独立live索引保持全量/增量/noop语义；空descriptor交给Core拒绝，不能扩成controlRoot扫描。
  let sourceGraphResult: SourceGraphLifecycleResult | null = null;
  try {
    const { getCoreRepositoryBundle } = await import('../../../injection/modules/InfraModule.js');
    // GenerateWorkflowContainer 是 ServiceContainer 的窄化视图,运行时同一实例;
    // repository bundle 缓存挂在 singletons,经 unknown 桥接取全量容器形态。
    const repositories = getCoreRepositoryBundle(
      ctx.container as unknown as Parameters<typeof getCoreRepositoryBundle>[0]
    );
    const lifecycle = new SourceGraphLifecycleService(repositories.sourceGraphRepository);
    const startedAtMs = Date.now();
    sourceGraphResult = await lifecycle.catchUpOnStartup({
      // workflow仍保留当前folder身份；仅整份live图使用真实controlRoot作为相对路径锚点。
      // 选项与图工具共用一份：之后 Agent 的 graph 查询读的就是这里建好的这一代索引。
      ...resolveSourceIndexOptions(ctx.container, { projectRoot, dataRoot }),
      signal: sessionAbortSignal ?? undefined,
    });
    logger.info(
      `[AiDimension] source graph ${sourceGraphResult.action} (${sourceGraphResult.reason}): ` +
        `files=${sourceGraphResult.durableTables.source_graph_files} ` +
        `symbols=${sourceGraphResult.durableTables.source_graph_symbols} ` +
        `edges=${sourceGraphResult.durableTables.source_graph_edges} ` +
        `durationMs=${Date.now() - startedAtMs}`
    );
  } catch (err: unknown) {
    if (sessionAbortSignal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      const reason = sessionAbortSignal?.reason ?? err;
      logger.info(
        `[AiDimension] source graph catch-up cancelled — mining stops: ${reason instanceof Error ? reason.message : String(reason)}`,
        { projectRoot }
      );
      throw err instanceof Error ? err : new Error(String(err), { cause: err });
    }
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
    sessionAbortSignal,
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

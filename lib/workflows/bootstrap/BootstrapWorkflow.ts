import type { AgentService, SystemRunContextFactory } from '#agent/service/index.js';
import type { IncrementalPlan } from '#external/mcp/handlers/types.js';
import Logger from '#infra/logging/Logger.js';
import { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import { resolveDataRoot } from '#shared/resolveProjectRoot.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
import type { BootstrapFileEntry } from '#workflows/bootstrap/agent-runs/BootstrapDimensionInputBuilder.js';
import { resolveBootstrapTerminalToolset } from '#workflows/bootstrap/config/BootstrapTerminalToolset.js';
import {
  type BootstrapProjectGraphLike,
  initializeBootstrapRuntime,
} from '#workflows/bootstrap/context/BootstrapRuntimeInitializer.js';
import { fillDimensionsMock } from '#workflows/bootstrap/mock/MockBootstrapPipeline.js';
import { completeBootstrapPipeline } from '#workflows/bootstrap/pipeline/BootstrapCompletionPipeline.js';
import { runBootstrapDimensionSession } from '#workflows/bootstrap/pipeline/BootstrapDimensionSessionPipeline.js';

const logger = Logger.getInstance();

interface BootstrapWorkflowSingletons {
  aiProvider?: {
    name?: string;
    model?: string;
    supportsEmbedding?: () => boolean;
    [key: string]: unknown;
  } | null;
  _embedProvider?: { embed?: (text: string) => Promise<number[]>; [key: string]: unknown } | null;
  _fileCache?: BootstrapFileEntry[] | null;
  _projectRoot?: string;
  _config?: Record<string, unknown>;
  _lang?: string | null;
  [key: string]: unknown;
}

interface BootstrapWorkflowServiceKeys {
  agentService: AgentService;
  systemRunContextFactory: SystemRunContextFactory;
  bootstrapTaskManager: BootstrapTaskManagerLike;
  database: unknown;
}

export interface BootstrapWorkflowContainer {
  get<K extends keyof BootstrapWorkflowServiceKeys>(name: K): BootstrapWorkflowServiceKeys[K];
  get(name: string): unknown;
  singletons: BootstrapWorkflowSingletons;
  buildProjectGraph?(
    projectRoot: string,
    options?: Record<string, unknown>
  ): Promise<BootstrapProjectGraphLike | null>;
  [key: string]: unknown;
}

export interface BootstrapWorkflowContext {
  container: BootstrapWorkflowContainer;
  [key: string]: unknown;
}

interface BootstrapTaskManagerLike {
  isSessionValid(sessionId: string): boolean;
  getSessionAbortSignal?(): AbortSignal | null;
  emitProgress?(event: string, data: Record<string, unknown>): void;
  [key: string]: unknown;
}

export type BootstrapDimensionFillStatus = 'completed' | 'mock' | 'ai-unavailable';

export interface BootstrapDimensionFillResult {
  status: BootstrapDimensionFillStatus;
  summary: Record<string, unknown>;
}

export async function fillDimensionsV3(
  view: PipelineFillView,
  dimensions: DimensionDef[]
): Promise<BootstrapDimensionFillResult> {
  const { snapshot, projectRoot } = view;
  const ctx = view.ctx as BootstrapWorkflowContext;
  const dataRoot =
    resolveDataRoot(ctx.container as { singletons?: Record<string, unknown> }) || projectRoot;

  const depGraphData = snapshot.dependencyGraph;
  const guardAudit = snapshot.guardAudit;
  const primaryLang = snapshot.language.primaryLang ?? 'unknown';
  const astProjectSummary = snapshot.ast;
  const incrementalPlan = snapshot.incrementalPlan as IncrementalPlan | null;
  const panoramaResult = snapshot.panorama as Record<string, unknown> | null;
  const callGraphResult = snapshot.callGraph;
  const existingRecipes = view.existingRecipes ?? null;
  const evolutionPrescreen = view.evolutionPrescreen ?? null;
  const targetFileMap = view.targetFileMap;

  let taskManager: BootstrapTaskManagerLike | null = null;
  try {
    taskManager = ctx.container.get('bootstrapTaskManager') as BootstrapTaskManagerLike;
  } catch {
    /* not available */
  }
  const sessionId = view.bootstrapSession?.id ?? '';
  const sessionAbortSignal = taskManager?.getSessionAbortSignal?.() ?? null;
  const terminalToolsetConfig = resolveBootstrapTerminalToolset({
    terminalTest: view.terminalTest,
    terminalToolset: view.terminalToolset,
    allowedTerminalModes: view.allowedTerminalModes,
  });
  const scanPlan = view.scanPlan ?? null;
  const scanEvidencePack = view.scanEvidencePack ?? null;

  const isIncremental = incrementalPlan?.canIncremental && incrementalPlan?.mode === 'incremental';
  const emitter = new BootstrapEventEmitter(ctx.container);
  logger.info(
    `[Insight-v3] ═══ fillDimensionsV3 entered — ${isIncremental ? 'INCREMENTAL' : 'FULL'} pipeline`
  );

  const allFiles: BootstrapFileEntry[] | null = snapshot.allFiles as unknown as
    | BootstrapFileEntry[]
    | null;

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

  if ((!agentService || !systemRunContextFactory) && !isMockMode) {
    logger.error('[Insight-v3] AI Provider not available — bootstrap requires AI');
    emitter.emitProgress('bootstrap:ai-unavailable', {
      message:
        'AI Provider 不可用，Bootstrap 需要 AI 才能运行。请先配置 AI Provider（如 OpenAI、Anthropic 等）后重试。',
    });
    for (const dim of dimensions) {
      emitter.emitDimensionComplete(dim.id, { type: 'skipped', reason: 'ai-unavailable' });
    }
    return {
      status: 'ai-unavailable',
      summary: { stage: 'bootstrap-ai-provider', dimensions: dimensions.length },
    };
  }

  if (isMockMode) {
    logger.info('[Insight-v3] Mock AI detected — routing to mock-pipeline');
    await fillDimensionsMock(view, dimensions);
    return { status: 'mock', summary: { mock: true, dimensions: dimensions.length } };
  }

  if (!agentService || !systemRunContextFactory) {
    return {
      status: 'ai-unavailable',
      summary: { stage: 'bootstrap-ai-provider', dimensions: dimensions.length },
    };
  }

  const runtime = await initializeBootstrapRuntime({
    container: ctx.container,
    projectRoot,
    dataRoot,
    primaryLang,
    allFiles,
    targetFileMap,
    depGraphData,
    astProjectSummary: astProjectSummary as Record<string, unknown> | null,
    guardAudit: guardAudit as Record<string, unknown> | null,
    isIncremental,
    incrementalPlan,
  });
  const dimensionSession = await runBootstrapDimensionSession({
    ctx,
    dataRoot,
    dimensions,
    runtime,
    agentService,
    systemRunContextFactory,
    emitter,
    sessionId,
    sessionAbortSignal,
    taskManager,
    terminalToolsetConfig,
    primaryLang,
    allFiles,
    scanPlan,
    scanEvidencePack,
    targetFileMap,
    depGraphData,
    astProjectSummary,
    guardAudit,
    panoramaResult,
    callGraphResult,
    isIncremental,
    incrementalPlan,
    existingRecipes,
    evolutionPrescreen,
  });

  const completion = await completeBootstrapPipeline({
    ctx,
    projectRoot,
    dataRoot,
    dimensions,
    runtime,
    dimensionSession,
    emitter,
    sessionId,
    taskManager,
    allFiles,
    isIncremental,
    incrementalPlan,
  });

  return { status: 'completed', summary: completion.summary };
}

export async function clearSnapshots(
  projectRoot: string,
  ctx: {
    container: BootstrapWorkflowContainer;
    logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  }
) {
  try {
    const db = ctx.container.get('database');
    if (db) {
      const { BootstrapSnapshot } = await import(
        '#workflows/bootstrap/incremental/BootstrapSnapshot.js'
      );
      const snap = new BootstrapSnapshot(db, { logger: ctx.logger });
      snap.clearProject(projectRoot);
      ctx.logger.info('[Bootstrap] Cleared incremental snapshots — forcing full rebuild');
    }
  } catch (err: unknown) {
    ctx.logger.warn(
      `[Bootstrap] clearSnapshots failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export { clearCheckpoints } from '#workflows/bootstrap/checkpoint/BootstrapCheckpointStore.js';
export default fillDimensionsV3;

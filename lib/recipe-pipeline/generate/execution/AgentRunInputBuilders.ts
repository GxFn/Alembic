/**
 * BootstrapInputBuilders — AgentRunInput 构建器
 *
 * 构建内部 Agent Bootstrap 会话和单维度运行所需的 AgentRunInput，
 * 包括消息、上下文、执行参数和子任务编排。
 */

import type { MemoryCoordinator } from '@alembic/agent/memory';
import type { SystemRunContext } from '@alembic/agent/runtime';
import type {
  AgentRunContext,
  AgentRunExecutionOptions,
  AgentRunInput,
  AgentRunMessage,
  AgentRunPresentationOptions,
} from '@alembic/agent/service';
import type {
  ProjectScopeSourceIdentity,
  ProjectScopeSourceIdentityMap,
} from '../../../project-scope/ProjectScopeAnalysis.js';
import { buildGeneratePcvStageNodeContext } from './PcvStageNodeMap.js';

// ── Dimension input builder ──────────────────────────────

export interface GenerateFileEntry {
  name: string;
  path: string;
  relativePath: string;
  content: string;
  sourceIdentity?: ProjectScopeSourceIdentity;
  targetName?: string;
}

export interface BuildGenerateDimensionRunInputOptions {
  dimId: string;
  dimConfig: { label?: string };
  needsCandidates: boolean;
  hasExistingRecipes: boolean;
  prescreenDone: boolean;
  sessionId: string;
  primaryLang?: string | null;
  projectLang?: string | null;
  allFiles: GenerateFileEntry[] | null;
  systemRunContext: SystemRunContext;
  strategyContext: Record<string, unknown>;
  memoryCoordinator: MemoryCoordinator;
  projectScopeSourceIdentityMap?: ProjectScopeSourceIdentityMap | null;
  sessionAbortSignal?: AbortSignal | null;
}

export function buildGenerateDimensionRunInput({
  dimId,
  dimConfig,
  needsCandidates,
  hasExistingRecipes,
  prescreenDone,
  sessionId,
  primaryLang,
  projectLang,
  allFiles,
  systemRunContext,
  strategyContext,
  memoryCoordinator,
  projectScopeSourceIdentityMap,
  sessionAbortSignal,
}: BuildGenerateDimensionRunInputOptions): AgentRunInput {
  const analystScopeId = systemRunContext.scopeId || `${dimId}:analyst`;
  const pcvStageNodeContext = buildGeneratePcvStageNodeContext();
  const compactSystemRunContext = compactBootstrapSystemRunContext(systemRunContext);
  const sharedState = {
    ...asRecord(compactSystemRunContext.sharedState),
    ...(projectScopeSourceIdentityMap
      ? { _projectScopeSourceIdentityMap: projectScopeSourceIdentityMap }
      : {}),
    _pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
    _pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
    pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
    pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
  };
  const enrichedStrategyContext = {
    ...strategyContext,
    ...(projectScopeSourceIdentityMap ? { projectScopeSourceIdentityMap } : {}),
    pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
    pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
    pcvStageNodeMapContract: {
      contract: pcvStageNodeContext.contract,
      contractVersion: pcvStageNodeContext.contractVersion,
    },
    sharedState: {
      ...asRecord(strategyContext.sharedState),
      ...(projectScopeSourceIdentityMap
        ? { _projectScopeSourceIdentityMap: projectScopeSourceIdentityMap }
        : {}),
      _pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
      _pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
      pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
      pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
    },
  };
  return {
    profile: { id: 'generate-dimension' },
    params: {
      dimId,
      needsCandidates,
      hasExistingRecipes,
      prescreenDone,
    },
    message: {
      role: 'internal',
      content: `Bootstrap dimension: ${dimConfig.label || dimId}`,
      sessionId,
      metadata: {
        sessionId,
        dimension: dimId,
        phase: 'bootstrap',
        context: {
          ...(projectScopeSourceIdentityMap ? { projectScopeSourceIdentityMap } : {}),
          pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
          pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
        },
      },
    },
    context: {
      source: 'bootstrap',
      runtimeSource: 'system',
      lang: primaryLang || projectLang || null,
      fileCache: allFiles,
      systemRunContext: compactSystemRunContext,
      pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
      pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
      strategyContext: enrichedStrategyContext,
      contextWindow: compactSystemRunContext.contextWindow,
      trace: compactSystemRunContext.trace,
      memoryCoordinator,
      sharedState,
      promptContext: {
        dimensionScopeId: analystScopeId,
        dimId,
        dimensionId: dimId,
        ...(projectScopeSourceIdentityMap ? { projectScopeSourceIdentityMap } : {}),
        pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
        pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
      },
    } as unknown as AgentRunContext,
    execution: {
      abortSignal: sessionAbortSignal || undefined,
    },
    presentation: { responseShape: 'system-task-result' },
  };
}

function compactBootstrapSystemRunContext(systemRunContext: SystemRunContext): SystemRunContext {
  return {
    scopeId: systemRunContext.scopeId,
    contextWindow: systemRunContext.contextWindow || null,
    tracker: systemRunContext.tracker || null,
    trace: systemRunContext.trace,
    activeContext: systemRunContext.activeContext,
    memoryCoordinator: systemRunContext.memoryCoordinator,
    sharedState: systemRunContext.sharedState,
    source: systemRunContext.source,
    outputType: systemRunContext.outputType,
    dimId: systemRunContext.dimId,
    dimensionId: systemRunContext.dimensionId,
    dimensionLabel: systemRunContext.dimensionLabel,
    projectLanguage: systemRunContext.projectLanguage,
    submitToolName: systemRunContext.submitToolName,
    pipelineType: systemRunContext.pipelineType,
    _computedBudget: systemRunContext._computedBudget,
    pcvStageNodeMap: systemRunContext.pcvStageNodeMap,
    pcvChainNodes: systemRunContext.pcvChainNodes,
    pcvStageNodeMapContract: systemRunContext.pcvStageNodeMapContract,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

// ── Session input builder ────────────────────────────────

export interface GenerateSessionChildRunPlan {
  id: string;
  label?: string;
  tier?: number;
  input: AgentRunInput;
  lazyInputFactory?: (event: {
    plannedInput: AgentRunInput;
    parentInput: AgentRunInput;
  }) => AgentRunInput | Promise<AgentRunInput>;
}

export interface BuildGenerateSessionRunInputOptions {
  sessionId: string;
  children: GenerateSessionChildRunPlan[];
  params?: Record<string, unknown>;
  message?: Partial<AgentRunMessage>;
  context?: Partial<AgentRunContext>;
  execution?: AgentRunExecutionOptions;
  presentation?: AgentRunPresentationOptions;
}

export function buildGenerateSessionRunInput({
  sessionId,
  children,
  params,
  message,
  context,
  execution,
  presentation,
}: BuildGenerateSessionRunInputOptions): AgentRunInput {
  return {
    profile: { id: 'generate-session' },
    params: {
      ...(params || {}),
      dimensions: children.map((child) => ({
        id: child.id,
        label: child.label || child.id,
        ...(child.tier !== undefined ? { tier: child.tier } : {}),
        params: child.input.params || {},
        message: child.input.message,
        metadata: child.input.message.metadata || {},
        promptContext: child.input.context.promptContext || {},
      })),
    },
    message: {
      role: message?.role || 'internal',
      content: message?.content || 'Bootstrap session',
      history: message?.history,
      metadata: {
        sessionId,
        // wire:process-event metadata.phase 持久化值,与 profile id 同拼写不同义,冻结(wire-contract)
        phase: 'bootstrap-session',
        ...(message?.metadata || {}),
      },
      sessionId: message?.sessionId || sessionId,
    },
    context: {
      source: 'bootstrap',
      runtimeSource: 'system',
      lang: context?.lang || firstChildLang(children),
      ...(context || {}),
      childContexts: {
        ...(context?.childContexts || {}),
        ...Object.fromEntries(children.map((child) => [child.id, child.input.context])),
      },
      childInputFactories: {
        ...(context?.childInputFactories || {}),
        ...Object.fromEntries(
          children.flatMap((child) =>
            child.lazyInputFactory ? [[child.id, child.lazyInputFactory]] : []
          )
        ),
      },
    },
    execution: execution || children[0]?.input.execution,
    presentation: presentation ||
      children[0]?.input.presentation || { responseShape: 'system-task-result' },
  };
}

function firstChildLang(children: GenerateSessionChildRunPlan[]) {
  return (
    children.find((child) => child.input.context.lang !== undefined)?.input.context.lang || null
  );
}

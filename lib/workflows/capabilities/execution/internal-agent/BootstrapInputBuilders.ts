/**
 * BootstrapInputBuilders — AgentRunInput 构建器
 *
 * 构建内部 Agent Bootstrap 会话和单维度运行所需的 AgentRunInput，
 * 包括消息、上下文、执行参数和子任务编排。
 */

import type { MemoryCoordinator } from '#agent/memory/MemoryCoordinator.js';
import type { SystemRunContext } from '#agent/runtime/SystemRunContext.js';
import type {
  AgentRunContext,
  AgentRunExecutionOptions,
  AgentRunInput,
  AgentRunMessage,
  AgentRunPresentationOptions,
} from '#agent/service/index.js';

// ── Dimension input builder ──────────────────────────────

export interface BootstrapFileEntry {
  name: string;
  path: string;
  relativePath: string;
  content: string;
  targetName?: string;
}

export interface BuildBootstrapDimensionRunInputOptions {
  dimId: string;
  dimConfig: { label?: string };
  needsCandidates: boolean;
  hasExistingRecipes: boolean;
  prescreenDone: boolean;
  sessionId: string;
  primaryLang?: string | null;
  projectLang?: string | null;
  allFiles: BootstrapFileEntry[] | null;
  systemRunContext: SystemRunContext;
  strategyContext: Record<string, unknown>;
  memoryCoordinator: MemoryCoordinator;
  sessionAbortSignal?: AbortSignal | null;
}

export function buildBootstrapDimensionRunInput({
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
  sessionAbortSignal,
}: BuildBootstrapDimensionRunInputOptions): AgentRunInput {
  const analystScopeId = systemRunContext.scopeId || `${dimId}:analyst`;
  return {
    profile: { id: 'bootstrap-dimension' },
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
      },
    },
    context: {
      source: 'bootstrap',
      runtimeSource: 'system',
      lang: primaryLang || projectLang || null,
      fileCache: allFiles,
      systemRunContext,
      strategyContext,
      contextWindow: systemRunContext.contextWindow,
      trace: systemRunContext.trace,
      memoryCoordinator,
      sharedState: systemRunContext.sharedState,
      promptContext: {
        dimensionScopeId: analystScopeId,
        dimId,
        dimensionId: dimId,
      },
    },
    execution: {
      abortSignal: sessionAbortSignal || undefined,
    },
    presentation: { responseShape: 'system-task-result' },
  };
}

// ── Session input builder ────────────────────────────────

export interface BootstrapSessionChildRunPlan {
  id: string;
  label?: string;
  tier?: number;
  input: AgentRunInput;
  lazyInputFactory?: (event: {
    plannedInput: AgentRunInput;
    parentInput: AgentRunInput;
  }) => AgentRunInput | Promise<AgentRunInput>;
}

export interface BuildBootstrapSessionRunInputOptions {
  sessionId: string;
  children: BootstrapSessionChildRunPlan[];
  params?: Record<string, unknown>;
  message?: Partial<AgentRunMessage>;
  context?: Partial<AgentRunContext>;
  execution?: AgentRunExecutionOptions;
  presentation?: AgentRunPresentationOptions;
}

export function buildBootstrapSessionRunInput({
  sessionId,
  children,
  params,
  message,
  context,
  execution,
  presentation,
}: BuildBootstrapSessionRunInputOptions): AgentRunInput {
  return {
    profile: { id: 'bootstrap-session' },
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

function firstChildLang(children: BootstrapSessionChildRunPlan[]) {
  return (
    children.find((child) => child.input.context.lang !== undefined)?.input.context.lang || null
  );
}

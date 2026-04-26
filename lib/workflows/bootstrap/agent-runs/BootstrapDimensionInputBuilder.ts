import type { MemoryCoordinator } from '#agent/memory/MemoryCoordinator.js';
import type { SystemRunContext } from '#agent/runtime/SystemRunContext.js';
import type { AgentRunInput } from '#agent/service/index.js';

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

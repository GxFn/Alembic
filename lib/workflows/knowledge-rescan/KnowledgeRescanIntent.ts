import type { RescanInput } from '#shared/schemas/mcp-tools.js';
import { normalizeDimensionIds, type WorkflowExecutor } from '#workflows/shared/WorkflowTypes.js';

export type KnowledgeRescanExecutor = WorkflowExecutor;

export interface InternalKnowledgeRescanArgs extends RescanInput {
  skipAsyncFill?: boolean;
}

export interface KnowledgeRescanProjectAnalysisIntent {
  maxFiles: number;
  contentMaxLines: number;
  sourceTag: 'rescan-internal' | 'rescan-external';
  summaryPrefix: string;
  generateAstContext: boolean;
}

export interface InternalKnowledgeRescanExecutionIntent {
  skipAsyncFill: boolean;
}

export interface KnowledgeRescanWorkflowIntent {
  kind: 'knowledge-rescan';
  executor: KnowledgeRescanExecutor;
  analysisMode: 'incremental' | 'full';
  cleanupPolicy: 'none' | 'force-rescan' | 'rescan-clean';
  completionPolicy: 'auto-fill' | 'external-dimension-complete';
  projectAnalysis: KnowledgeRescanProjectAnalysisIntent;
  dimensionIds?: string[];
  reason?: string | null;
  internalExecution?: InternalKnowledgeRescanExecutionIntent;
}

export function createInternalKnowledgeRescanIntent(
  args: InternalKnowledgeRescanArgs
): KnowledgeRescanWorkflowIntent {
  const forceMode = args.force ?? false;
  return {
    kind: 'knowledge-rescan',
    executor: 'internal-agent',
    analysisMode: forceMode ? 'full' : 'incremental',
    cleanupPolicy: forceMode ? 'force-rescan' : 'none',
    completionPolicy: 'auto-fill',
    projectAnalysis: {
      maxFiles: 500,
      contentMaxLines: 120,
      sourceTag: 'rescan-internal',
      summaryPrefix: 'Rescan-Internal scan',
      generateAstContext: true,
    },
    dimensionIds: normalizeDimensionIds(args.dimensions),
    reason: args.reason || null,
    internalExecution: {
      skipAsyncFill: args.skipAsyncFill ?? false,
    },
  };
}

export function createExternalKnowledgeRescanIntent(
  args: RescanInput
): KnowledgeRescanWorkflowIntent {
  const forceMode = args.force ?? false;
  return {
    kind: 'knowledge-rescan',
    executor: 'external-agent',
    analysisMode: forceMode ? 'full' : 'incremental',
    cleanupPolicy: forceMode ? 'force-rescan' : 'none',
    completionPolicy: 'external-dimension-complete',
    projectAnalysis: {
      maxFiles: 500,
      contentMaxLines: 120,
      sourceTag: 'rescan-external',
      summaryPrefix: 'Rescan scan',
      generateAstContext: false,
    },
    dimensionIds: normalizeDimensionIds(args.dimensions),
    reason: args.reason || null,
  };
}

// normalizeDimensionIds → imported from WorkflowTypes

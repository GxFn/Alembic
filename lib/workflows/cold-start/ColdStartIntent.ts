import {
  normalizeDimensionIds,
  normalizeStringArray,
  type WorkflowExecutor,
} from '#workflows/shared/WorkflowTypes.js';

export type ColdStartExecutor = WorkflowExecutor;

export interface InternalColdStartArgs {
  maxFiles?: number;
  skipGuard?: boolean;
  contentMaxLines?: number;
  incremental?: boolean;
  skipAsyncFill?: boolean;
  terminalTest?: boolean;
  terminalToolset?: string;
  allowedTerminalModes?: string[];
  loadSkills?: boolean;
  dimensions?: string[];
  [key: string]: unknown;
}

export interface ColdStartProjectAnalysisIntent {
  maxFiles: number;
  contentMaxLines: number;
  skipGuard: boolean;
  sourceTag: 'bootstrap' | 'bootstrap-external';
  summaryPrefix?: string;
  generateAstContext: boolean;
}

export interface InternalColdStartExecutionIntent {
  skipAsyncFill: boolean;
  terminalTest: boolean;
  terminalToolset?: string;
  allowedTerminalModes?: string[];
}

export interface ColdStartWorkflowIntent {
  kind: 'cold-start';
  executor: ColdStartExecutor;
  analysisMode: 'full';
  cleanupPolicy: 'full-reset';
  completionPolicy: 'auto-fill' | 'external-dimension-complete';
  projectAnalysis: ColdStartProjectAnalysisIntent;
  dimensionIds?: string[];
  internalExecution?: InternalColdStartExecutionIntent;
  ignoredFileDiffIncremental: boolean;
}

export function createInternalColdStartIntent(
  args: InternalColdStartArgs = {}
): ColdStartWorkflowIntent {
  return {
    kind: 'cold-start',
    executor: 'internal-agent',
    analysisMode: 'full',
    cleanupPolicy: 'full-reset',
    completionPolicy: 'auto-fill',
    projectAnalysis: {
      maxFiles: args.maxFiles ?? 500,
      contentMaxLines: args.contentMaxLines ?? 120,
      skipGuard: args.skipGuard ?? false,
      sourceTag: 'bootstrap',
      generateAstContext: true,
    },
    dimensionIds: normalizeDimensionIds(args.dimensions),
    internalExecution: {
      skipAsyncFill: args.skipAsyncFill ?? false,
      terminalTest: args.terminalTest === true,
      terminalToolset: typeof args.terminalToolset === 'string' ? args.terminalToolset : undefined,
      allowedTerminalModes: normalizeStringArray(args.allowedTerminalModes),
    },
    ignoredFileDiffIncremental: args.incremental === true,
  };
}

export function createExternalColdStartIntent(): ColdStartWorkflowIntent {
  return {
    kind: 'cold-start',
    executor: 'external-agent',
    analysisMode: 'full',
    cleanupPolicy: 'full-reset',
    completionPolicy: 'external-dimension-complete',
    projectAnalysis: {
      maxFiles: 500,
      contentMaxLines: 120,
      skipGuard: false,
      sourceTag: 'bootstrap-external',
      summaryPrefix: 'Bootstrap-external scan',
      generateAstContext: false,
    },
    ignoredFileDiffIncremental: false,
  };
}

// normalizeDimensionIds, normalizeStringArray → imported from WorkflowTypes

import type { ContextWindow } from '../context/ContextWindow.js';
import type { ExplorationTracker } from '../context/ExplorationTracker.js';
import type { PipelineType } from '../context/exploration/ExplorationStrategies.js';
import type { ActiveContext } from '../memory/ActiveContext.js';
import type { MemoryCoordinator } from '../memory/MemoryCoordinator.js';

export interface SystemRunDimensionMeta extends Record<string, unknown> {
  id: string;
  outputType?: string;
  allowedKnowledgeTypes?: unknown[];
}

export interface SystemRunSharedState extends Record<string, unknown> {
  submittedTitles?: Set<unknown>;
  submittedPatterns?: Set<unknown>;
  submittedTriggers?: Set<unknown>;
  _bootstrapDedup?: unknown;
  _dimensionMeta?: SystemRunDimensionMeta;
  _projectLanguage?: string | null;
  _dimensionScopeId: string;
}

export interface SystemRunContext extends Record<string, unknown> {
  scopeId: string;
  contextWindow?: ContextWindow | null;
  tracker?: ExplorationTracker | null;
  trace: ActiveContext | null;
  activeContext: ActiveContext | null;
  memoryCoordinator: MemoryCoordinator;
  sharedState: SystemRunSharedState;
  source: string;
  outputType?: string;
  dimId?: string;
  dimensionId?: string;
  dimensionLabel?: string;
  projectLanguage?: string | null;
  submitToolName?: string;
  pipelineType?: PipelineType;
}

export interface BuildSystemRunContextOptions {
  memoryCoordinator: MemoryCoordinator;
  scopeId: string;
  contextWindow?: ContextWindow | null;
  tracker?: ExplorationTracker | null;
  trace?: ActiveContext | null;
  activeContext?: ActiveContext | null;
  sharedState?: Record<string, unknown>;
  source?: string;
  outputType?: string;
  dimId?: string;
  dimensionId?: string;
  dimensionLabel?: string;
  projectLanguage?: string | null;
  submitToolName?: string;
  pipelineType?: PipelineType;
  dimensionMeta?: SystemRunDimensionMeta;
  allowDistinctActiveContext?: boolean;
  extraFields?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function stripUndefined(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function createSystemRunContext(options: BuildSystemRunContextOptions): SystemRunContext {
  const activeContext =
    options.activeContext ?? options.memoryCoordinator.getActiveContext(options.scopeId);
  if (!activeContext) {
    throw new Error(`SystemRunContext requires an ActiveContext for scope "${options.scopeId}"`);
  }

  const trace = options.trace ?? activeContext;
  if (trace !== activeContext && !options.allowDistinctActiveContext) {
    throw new Error('SystemRunContext trace and activeContext must refer to the same scope');
  }

  const sharedState = {
    ...(options.sharedState || {}),
    ...(options.projectLanguage !== undefined ? { _projectLanguage: options.projectLanguage } : {}),
    ...(options.dimensionMeta ? { _dimensionMeta: options.dimensionMeta } : {}),
    _dimensionScopeId: options.scopeId,
  } as SystemRunSharedState;

  return stripUndefined({
    ...(options.extraFields || {}),
    scopeId: options.scopeId,
    contextWindow: options.contextWindow || null,
    tracker: options.tracker || null,
    trace,
    activeContext,
    memoryCoordinator: options.memoryCoordinator,
    sharedState,
    source: options.source || 'system',
    outputType: options.outputType,
    dimId: options.dimId,
    dimensionId: options.dimensionId,
    dimensionLabel: options.dimensionLabel,
    projectLanguage: options.projectLanguage,
    submitToolName: options.submitToolName,
    pipelineType: options.pipelineType,
  }) as SystemRunContext;
}

export function isSystemRunContext(value: unknown): value is SystemRunContext {
  return (
    isRecord(value) &&
    typeof value.scopeId === 'string' &&
    isRecord(value.sharedState) &&
    !!value.memoryCoordinator
  );
}

export function projectSystemRunContext(context: SystemRunContext): Record<string, unknown> {
  return stripUndefined({
    ...context,
    systemRunContext: context,
    contextWindow: context.contextWindow || null,
    tracker: context.tracker || null,
    trace: context.trace,
    activeContext: context.activeContext,
    memoryCoordinator: context.memoryCoordinator,
    sharedState: context.sharedState,
    source: context.source,
    outputType: context.outputType,
    dimId: context.dimId,
    dimensionId: context.dimensionId,
    dimensionLabel: context.dimensionLabel,
    scopeId: context.scopeId,
    submitToolName: context.submitToolName,
    pipelineType: context.pipelineType,
  });
}

export function expandSystemRunContext(input: Record<string, unknown>): Record<string, unknown> {
  const systemRunContext = input.systemRunContext;
  if (!isSystemRunContext(systemRunContext)) {
    return input;
  }

  const sharedState = isRecord(input.sharedState)
    ? { ...systemRunContext.sharedState, ...input.sharedState }
    : systemRunContext.sharedState;

  return {
    ...projectSystemRunContext(systemRunContext),
    ...input,
    systemRunContext,
    sharedState,
  };
}

import type {
  ToolCallContext,
  ToolServiceContracts,
  ToolServiceLocator,
} from '#tools/core/ToolCallContext.js';

export interface InternalToolLogger {
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error?(msg: string, ...args: unknown[]): void;
}

export interface InternalToolSharedState {
  _searchCache?: unknown;
  _readCache?: unknown;
  _searchCallCount?: number;
}

export interface InternalToolHandlerContext {
  container: ToolServiceLocator;
  serviceContracts?: ToolServiceContracts;
  projectRoot: string;
  dataRoot?: string;
  logger?: InternalToolLogger;
  abortSignal?: AbortSignal | null;
  source?: string;
  toolCallContext?: ToolCallContext;
  aiProvider?: unknown;
  safetyPolicy?: unknown;
  fileCache?: unknown;
  _sharedState?: InternalToolSharedState;
  _dimensionMeta?: unknown;
  _projectLanguage?: string;
  _validator?: unknown;
  _submittedTitles?: Set<string>;
  _submittedPatterns?: Set<string>;
  _sessionToolCalls?: Array<{ tool: string; params?: Record<string, unknown> }>;
  _bootstrapDedup?: unknown;
  _memoryCoordinator?: unknown;
  _currentRound?: number;
  _dimensionScopeId?: string;
}

export type InternalToolHandler = (
  params: Record<string, unknown>,
  context: InternalToolHandlerContext
) => Promise<unknown> | unknown;

export interface InternalToolHandlerEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  metadata: Record<string, unknown>;
  handler: InternalToolHandler;
}

export interface InternalToolHandlerStore {
  getInternalTool(name: string): InternalToolHandlerEntry | null;
}

export interface ForgedInternalToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  forgeMode: 'generate';
  handler: InternalToolHandler;
}

export interface ForgedInternalToolStore {
  hasInternalTool(name: string): boolean;
  projectForgedTool(tool: ForgedInternalToolDefinition): void;
  revokeForgedTool(name: string): boolean;
}

export function contextFromToolCall(requestContext: ToolCallContext): InternalToolHandlerContext {
  const runtime = requestContext.runtime;
  return {
    container: toServiceLocator(requestContext.services),
    serviceContracts: requestContext.serviceContracts,
    projectRoot: requestContext.projectRoot || process.cwd(),
    dataRoot: requestContext.dataRoot || requestContext.projectRoot || process.cwd(),
    ...(runtime && isLogger(runtime.logger) ? { logger: runtime.logger } : {}),
    ...(requestContext.abortSignal ? { abortSignal: requestContext.abortSignal } : {}),
    ...(requestContext.source?.name ? { source: requestContext.source.name } : {}),
    toolCallContext: requestContext,
    ...(runtime?.aiProvider ? { aiProvider: runtime.aiProvider } : {}),
    ...(runtime?.safetyPolicy ? { safetyPolicy: runtime.safetyPolicy } : {}),
    ...(runtime?.fileCache ? { fileCache: runtime.fileCache } : {}),
    ...(typeof runtime?.dataRoot === 'string' ? { dataRoot: runtime.dataRoot } : {}),
    ...(isSharedState(runtime?.sharedState) ? { _sharedState: runtime.sharedState } : {}),
    ...(runtime?.dimensionMeta ? { _dimensionMeta: runtime.dimensionMeta } : {}),
    ...(typeof runtime?.projectLanguage === 'string'
      ? { _projectLanguage: runtime.projectLanguage }
      : {}),
    ...(runtime?.validator ? { _validator: runtime.validator } : {}),
    ...(runtime?.submittedTitles instanceof Set
      ? { _submittedTitles: runtime.submittedTitles }
      : {}),
    ...(runtime?.submittedPatterns instanceof Set
      ? { _submittedPatterns: runtime.submittedPatterns }
      : {}),
    ...(Array.isArray(runtime?.sessionToolCalls)
      ? { _sessionToolCalls: runtime.sessionToolCalls }
      : {}),
    ...(runtime?.bootstrapDedup ? { _bootstrapDedup: runtime.bootstrapDedup } : {}),
    ...(runtime?.memoryCoordinator ? { _memoryCoordinator: runtime.memoryCoordinator } : {}),
    ...(typeof runtime?.currentRound === 'number' ? { _currentRound: runtime.currentRound } : {}),
    ...(typeof runtime?.dimensionScopeId === 'string'
      ? { _dimensionScopeId: runtime.dimensionScopeId }
      : {}),
  };
}

function toServiceLocator(container: unknown): ToolServiceLocator {
  if (
    container &&
    typeof container === 'object' &&
    typeof (container as ToolServiceLocator).get === 'function'
  ) {
    return container as ToolServiceLocator;
  }
  return {
    get(name: string) {
      throw new Error(`Service '${name}' is not available in internal tool context`);
    },
  };
}

function isLogger(value: unknown): value is InternalToolLogger {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as InternalToolLogger).info === 'function' &&
    typeof (value as InternalToolLogger).debug === 'function' &&
    typeof (value as InternalToolLogger).warn === 'function'
  );
}

function isSharedState(value: unknown): value is InternalToolSharedState {
  return !!value && typeof value === 'object';
}

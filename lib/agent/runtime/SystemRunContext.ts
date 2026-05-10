export interface SystemRunDimensionMeta extends Record<string, unknown> {
  readonly id: string;
  readonly outputType?: string;
  readonly allowedKnowledgeTypes?: readonly unknown[];
}

export interface SystemRunSharedState extends Record<string, unknown> {
  readonly submittedTitles?: Set<unknown>;
  readonly submittedPatterns?: Set<unknown>;
  readonly submittedTriggers?: Set<unknown>;
  readonly _bootstrapDedup?: unknown;
  readonly _dimensionMeta?: SystemRunDimensionMeta;
  readonly _projectLanguage?: string | null;
  readonly _dimensionScopeId: string;
}

export interface SystemRunContext extends Record<string, unknown> {
  readonly scopeId: string;
  readonly contextWindow?: unknown;
  readonly tracker?: unknown;
  readonly trace: unknown;
  readonly activeContext: unknown;
  readonly memoryCoordinator: MemoryCoordinatorLike;
  readonly sharedState: SystemRunSharedState;
  readonly source: string;
  readonly outputType?: string;
  readonly dimId?: string;
  readonly dimensionId?: string;
  readonly dimensionLabel?: string;
  readonly projectLanguage?: string | null;
  readonly submitToolName?: string;
  readonly pipelineType?: string;
}

export interface MemoryCoordinatorLike {
  getActiveContext(scopeId: string): unknown;
}

export interface BuildSystemRunContextOptions {
  readonly memoryCoordinator: MemoryCoordinatorLike;
  readonly scopeId: string;
  readonly contextWindow?: unknown;
  readonly tracker?: unknown;
  readonly trace?: unknown;
  readonly activeContext?: unknown;
  readonly sharedState?: Record<string, unknown>;
  readonly source?: string;
  readonly outputType?: string;
  readonly dimId?: string;
  readonly dimensionId?: string;
  readonly dimensionLabel?: string;
  readonly projectLanguage?: string | null;
  readonly submitToolName?: string;
  readonly pipelineType?: string;
  readonly dimensionMeta?: SystemRunDimensionMeta;
  readonly allowDistinctActiveContext?: boolean;
  readonly extraFields?: Record<string, unknown>;
}

export function createSystemRunContext(options: BuildSystemRunContextOptions): SystemRunContext {
  const activeContext =
    options.activeContext ?? options.memoryCoordinator.getActiveContext(options.scopeId);
  if (!activeContext) {
    throw new Error(`SystemRunContext requires an ActiveContext for scope "${options.scopeId}"`);
  }
  const trace = options.trace ?? activeContext;
  if (trace !== activeContext && !options.allowDistinctActiveContext) {
    throw new Error("SystemRunContext trace and activeContext must refer to the same scope");
  }
  const sharedState = {
    ...(options.sharedState ?? {}),
    ...(options.projectLanguage !== undefined ? { _projectLanguage: options.projectLanguage } : {}),
    ...(options.dimensionMeta ? { _dimensionMeta: options.dimensionMeta } : {}),
    _dimensionScopeId: options.scopeId,
  } as SystemRunSharedState;

  return stripUndefined({
    ...(options.extraFields ?? {}),
    scopeId: options.scopeId,
    contextWindow: options.contextWindow ?? null,
    tracker: options.tracker ?? null,
    trace,
    activeContext,
    memoryCoordinator: options.memoryCoordinator,
    sharedState,
    source: options.source ?? "system",
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
    typeof value.scopeId === "string" &&
    isRecord(value.sharedState) &&
    !!value.memoryCoordinator
  );
}

export function projectSystemRunContext(context: SystemRunContext): Record<string, unknown> {
  return stripUndefined({
    ...context,
    systemRunContext: context,
    contextWindow: context.contextWindow ?? null,
    tracker: context.tracker ?? null,
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

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

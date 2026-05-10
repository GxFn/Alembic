import type {
  MainlineGuardRule,
  MainlineGuardRuleLoadResult,
  MainlineGuardRuleProvider,
} from "../../guard/index.js";
import type { MainlineAstParser } from "../../mainline/code/index.js";
import type { ContextIndexReader } from "../../mainline/data/index.js";
import type {
  MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceQueries,
} from "../../mainline/graph/index.js";
import type { RecipeLifecycleStorePort } from "../../mainline/knowledge/index.js";
import type { MainlineSearchIndex } from "../../mainline/search/index.js";

// 内部 Agent Tool 模块不兼容 legacy V1/V2；这里只描述新的 resource.action 契约。
export type ToolResource = "code" | "terminal" | "knowledge" | "graph" | "memory" | "meta";

export type ToolName =
  | "code.search"
  | "code.read"
  | "code.outline"
  | "code.structure"
  | "code.write"
  | "code.guard"
  | "terminal.execute"
  | "knowledge.search"
  | "knowledge.detail"
  | "knowledge.submit"
  | "knowledge.manage"
  | "graph.overview"
  | "graph.query"
  | "memory.save"
  | "memory.recall"
  | "memory.note_finding"
  | "memory.get_previous_evidence"
  | "meta.capabilities"
  | "meta.plan"
  | "meta.review";

export type ToolAvailabilityStatus = "available" | "unavailable" | "policy_required";

export type ToolResultStatus = "ok" | "error" | "unavailable" | "policy_required";

export interface ToolIdentity {
  readonly name: string;
  readonly resource: string;
  readonly action: string;
}

export interface ToolAvailability {
  readonly status: ToolAvailabilityStatus;
  readonly reason?: string;
}

export type ToolSchemaPrimitiveType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"
  | "null";

export interface ToolSchema {
  readonly type: ToolSchemaPrimitiveType | readonly ToolSchemaPrimitiveType[];
  readonly description?: string;
  readonly properties?: Readonly<Record<string, ToolSchema>>;
  readonly required?: readonly string[];
  readonly items?: ToolSchema;
  readonly enum?: readonly string[];
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly additionalProperties?: boolean;
}

export interface ToolDefinition extends ToolIdentity {
  readonly name: ToolName;
  readonly resource: ToolResource;
  readonly action: string;
  readonly title: string;
  readonly description: string;
  readonly availability: ToolAvailability;
  readonly risk?: "read-only" | "write" | "side-effect";
  readonly concurrency?: "parallel" | "single" | "exclusive";
  readonly maxOutputTokens?: number;
  readonly inputSchema: ToolSchema;
  readonly outputSchema: ToolSchema;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolRegistryReader {
  list(): ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
}

export interface ToolInvocation {
  readonly name?: string;
  readonly tool?: string;
  readonly resource?: string;
  readonly action?: string;
  readonly input?: unknown;
  readonly requestId?: string;
  readonly compression?: false | ToolCompressionOptions;
}

export interface ToolCompressionOptions {
  readonly maxDepth?: number;
  readonly maxArrayItems?: number;
  readonly maxStringLength?: number;
}

export interface ToolCompressionMeta extends Required<ToolCompressionOptions> {
  readonly applied: boolean;
  readonly truncatedArrays: number;
  readonly truncatedStrings: number;
  readonly truncatedObjects: number;
}

export interface ToolResultMeta {
  readonly requestId?: string;
  readonly compression?: ToolCompressionMeta;
  readonly warnings?: readonly string[];
}

export interface ToolError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface ToolSuccessEnvelope<TData = unknown> extends ToolIdentity {
  readonly ok: true;
  readonly status: "ok";
  readonly data: TData;
  readonly meta?: ToolResultMeta;
}

export interface ToolFailureEnvelope extends ToolIdentity {
  readonly ok: false;
  readonly status: Exclude<ToolResultStatus, "ok">;
  readonly error: ToolError;
  readonly meta?: ToolResultMeta;
}

export type ToolResultEnvelope<TData = unknown> = ToolSuccessEnvelope<TData> | ToolFailureEnvelope;

export interface ProjectIntelligenceArtifactProvider {
  load(): Promise<MainlineProjectIntelligenceArtifact | null>;
}

export interface ToolMemoryRecord {
  readonly key: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly category?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolMemoryRecallOptions {
  readonly query?: string;
  readonly tags?: readonly string[];
  readonly limit?: number;
}

export interface ToolMemoryStore {
  save(record: Omit<ToolMemoryRecord, "createdAt" | "updatedAt">): Promise<ToolMemoryRecord>;
  recall(options?: ToolMemoryRecallOptions): Promise<ToolMemoryRecord[]>;
}

export interface ToolMemoryCoordinator {
  noteFinding(
    finding: string,
    evidence: string,
    importance: number,
    round: number,
    scopeId?: string,
  ): string;
  searchEvidence?(
    query: string,
    dimId?: string,
  ): Array<{
    filePath: string;
    evidence: { dimId?: string; importance?: number; finding: string };
  }>;
}

export interface ToolDeltaCacheCheck {
  readonly mode: "unchanged" | "delta" | "full";
  readonly content: string;
  readonly lineCount: number;
}

export interface ToolDeltaCache {
  get(path: string): { readonly hash: string; readonly content: string } | undefined;
  set(path: string, hash: string, content: string): void;
  check(path: string, currentContent: string): ToolDeltaCacheCheck;
}

export interface ToolSearchCache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
}

export interface ToolTerminalExecutionRequest {
  readonly command: string;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly timeoutMs: number;
  readonly abortSignal?: AbortSignal;
}

export interface ToolTerminalExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut?: boolean;
}

export interface ToolTerminalExecutor {
  execute(request: ToolTerminalExecutionRequest): Promise<ToolTerminalExecutionResult>;
}

export interface ToolTerminalOutputCompressor {
  compress(
    raw: string,
    options: { readonly command: string; readonly tokenBudget?: number },
  ): string | Promise<string>;
}

export interface ToolKnowledgeGateway {
  create(request: {
    readonly source: string;
    readonly items: readonly Record<string, unknown>[];
    readonly options?: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface ToolKnowledgeRepository {
  getById(id: string): Promise<Record<string, unknown> | null>;
  approve?(id: string, reason?: string): Promise<unknown>;
  reject?(id: string, reason?: string): Promise<unknown>;
  publish?(id: string): Promise<unknown>;
  update?(id: string, data: Record<string, unknown>): Promise<unknown>;
  score?(id: string, score: number): Promise<unknown>;
  validate?(id: string): Promise<unknown>;
}

export interface ToolEvolutionGateway {
  submit(decision: {
    readonly recipeId: string;
    readonly action: "update" | "deprecate" | "valid";
    readonly source: string;
    readonly confidence: number;
    readonly description?: string;
    readonly evidence?: readonly Record<string, unknown>[];
    readonly reason?: string;
    readonly replacedByRecipeId?: string;
  }): Promise<unknown>;
}

export interface ToolRuntimeDependencies {
  readonly projectRoot?: string;
  readonly tokenBudget?: number;
  readonly abortSignal?: AbortSignal;
  readonly astParser?: MainlineAstParser;
  readonly deltaCache?: ToolDeltaCache;
  readonly searchCache?: ToolSearchCache;
  readonly searchIndex?: MainlineSearchIndex;
  readonly contextIndex?: ContextIndexReader;
  readonly guardRules?: readonly MainlineGuardRule[];
  readonly guardRuleProvider?:
    | MainlineGuardRuleProvider
    | (() => Promise<readonly MainlineGuardRule[] | MainlineGuardRuleLoadResult>);
  readonly projectIntelligenceQueries?: MainlineProjectIntelligenceQueries;
  readonly projectIntelligenceArtifactProvider?:
    | ProjectIntelligenceArtifactProvider
    | (() => Promise<MainlineProjectIntelligenceArtifact | null>);
  readonly memoryStore?: ToolMemoryStore;
  readonly memoryCoordinator?: ToolMemoryCoordinator;
  readonly knowledgeLifecycleStore?: RecipeLifecycleStorePort;
  readonly knowledgeGateway?: ToolKnowledgeGateway;
  readonly knowledgeRepository?: ToolKnowledgeRepository;
  readonly evolutionGateway?: ToolEvolutionGateway;
  readonly projectGraph?: unknown;
  readonly codeEntityGraph?: unknown;
  readonly terminalExecutor?: ToolTerminalExecutor;
  readonly terminalCompressor?: ToolTerminalOutputCompressor;
  readonly now?: () => number;
}

export interface ToolHandlerContext {
  readonly descriptor: ToolDefinition;
  readonly registry: ToolRegistryReader;
  readonly dependencies: ToolRuntimeDependencies;
}

export type ToolHandler = (
  invocation: ToolInvocation,
  context: ToolHandlerContext,
) => ToolResultEnvelope | Promise<ToolResultEnvelope>;

export function toolSuccess<TData>(
  identity: ToolIdentity,
  data: TData,
  meta?: ToolResultMeta,
): ToolSuccessEnvelope<TData> {
  return {
    ok: true,
    status: "ok",
    name: identity.name,
    resource: identity.resource,
    action: identity.action,
    data,
    ...(meta ? { meta } : {}),
  };
}

export function toolFailure(
  identity: ToolIdentity,
  status: Exclude<ToolResultStatus, "ok">,
  error: ToolError,
  meta?: ToolResultMeta,
): ToolFailureEnvelope {
  return {
    ok: false,
    status,
    name: identity.name,
    resource: identity.resource,
    action: identity.action,
    error,
    ...(meta ? { meta } : {}),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

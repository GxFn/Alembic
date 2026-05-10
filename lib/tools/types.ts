import type {
  MainlineGuardRule,
  MainlineGuardRuleLoadResult,
  MainlineGuardRuleProvider,
} from "../guard/index.js";
import type { ContextIndexReader } from "../mainline/data/index.js";
import type {
  MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceQueries,
} from "../mainline/graph/index.js";
import type { MainlineSearchIndex } from "../mainline/search/index.js";

// 新 Tool 模块不兼容 legacy V1/V2；这里只描述全新的 resource.action 契约。
export type ToolResource = "code" | "terminal" | "knowledge" | "graph" | "memory" | "meta";

export type ToolName =
  | "code.query"
  | "code.guard"
  | "terminal.execute"
  | "knowledge.search"
  | "graph.query"
  | "memory.query"
  | "meta.capabilities";

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

export interface ToolRuntimeDependencies {
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

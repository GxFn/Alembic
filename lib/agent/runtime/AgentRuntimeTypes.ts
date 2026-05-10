import type { ToolInvocation, ToolResultEnvelope } from "../tools/index.js";

export interface ToolCallEntry {
  readonly tool: string;
  readonly name?: string;
  readonly args: Record<string, unknown>;
  readonly result: unknown;
  readonly envelope?: ToolResultEnvelope;
  readonly durationMs: number;
}

export interface FunctionCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** Gemini 3+ thought signature 需要由上层原样回传。 */
  readonly thoughtSignature?: string;
}

export interface LLMResult {
  readonly type?: string;
  readonly text?: string | null;
  readonly functionCalls?: readonly FunctionCall[] | null;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
    readonly cacheHitTokens?: number;
  };
  /** DeepSeek 等模型的推理内容，运行时只传递不解析。 */
  readonly reasoningContent?: string | null;
}

export interface AiError extends Error {
  readonly code?: string;
}

export interface ProgressEvent {
  readonly type: string;
  readonly agentId: string;
  readonly preset: string;
  readonly timestamp: number;
  readonly [key: string]: unknown;
}

export interface AgentDiagnosticWarning {
  readonly code: string;
  readonly message: string;
  readonly stage?: string;
  readonly tool?: string;
}

export interface ToolCallDiagnostic {
  readonly tool: string;
  readonly callId: string;
  readonly parentCallId?: string;
  readonly status: string;
  readonly ok: boolean;
  readonly surface?: string;
  readonly source?: string;
  readonly kind?: string;
  readonly startedAt: string;
  readonly durationMs: number;
}

export interface StageToolsetDiagnostic {
  readonly stage: string;
  readonly capabilities: readonly string[];
  readonly allowedToolIds: readonly string[];
  readonly toolSchemaCount: number;
  readonly source?: string;
}

export interface AgentDiagnostics {
  degraded: boolean;
  fallbackUsed: boolean;
  warnings: AgentDiagnosticWarning[];
  timedOutStages: string[];
  blockedTools: Array<{ tool: string; reason: string }>;
  truncatedToolCalls: number;
  emptyResponses: number;
  aiErrorCount: number;
  gateFailures: Array<{ stage: string; action: string; reason?: string }>;
  toolCalls?: ToolCallDiagnostic[];
  stageToolsets?: StageToolsetDiagnostic[];
}

export interface ToolMetadata {
  cacheHit: boolean;
  blocked: boolean;
  isNew: boolean;
  durationMs: number;
  dedupMessage?: string;
  isSubmit?: boolean;
  envelope?: ToolResultEnvelope;
}

export interface FileCacheEntry {
  readonly relativePath: string;
  readonly content?: string;
  readonly name?: string;
  readonly language?: string;
}

export interface ToolRouterContract {
  invoke(invocation: ToolInvocation): Promise<ToolResultEnvelope>;
}

export type ToolCallHook = (
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  iteration: number,
) => void;

export interface RuntimeConfig {
  readonly id?: string;
  readonly presetName?: string;
  readonly toolRouter: ToolRouterContract;
  readonly persona?: Record<string, unknown>;
  readonly memory?: Record<string, unknown>;
  readonly onProgress?: ((event: ProgressEvent) => void) | null;
  readonly onToolCall?: ToolCallHook | null;
  readonly lang?: string | null;
  readonly projectRoot?: string;
  readonly dataRoot?: string;
  readonly additionalTools?: readonly string[];
}

export interface AgentResult {
  readonly reply: string;
  readonly toolCalls: readonly ToolCallEntry[];
  readonly tokenUsage: { input: number; output: number; reasoning?: number; cacheHit?: number };
  readonly iterations: number;
  readonly durationMs: number;
  readonly phases?: Record<string, unknown>;
  readonly diagnostics?: AgentDiagnostics;
  readonly state: Record<string, unknown>;
  readonly qualityWarning?: string;
  readonly [key: string]: unknown;
}

export interface ReactLoopOpts {
  readonly history?: ReadonlyArray<{ role: string; content: string }>;
  readonly context?: Record<string, unknown>;
  readonly capabilityOverride?: readonly string[];
  readonly additionalToolsOverride?: readonly string[];
  readonly budgetOverride?: Record<string, unknown>;
  readonly systemPromptOverride?: string;
  readonly onToolCall?: ToolCallHook | null;
  readonly sharedState?: Record<string, unknown>;
  readonly source?: string;
  readonly toolChoiceOverride?: string | null;
  readonly abortSignal?: AbortSignal;
  readonly diagnostics?: unknown;
  readonly [key: string]: unknown;
}

/** 单轮最多消费的工具调用数，避免模型一次性展开过大的 fan-out。 */
export const MAX_TOOL_CALLS_PER_ITER = 8;

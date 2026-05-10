import type { ToolInvocation, ToolResultEnvelope } from "../tools/index.js";

export type RuntimeChatRole = "system" | "user" | "assistant" | "tool";

export interface RuntimeToolCallRecord {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** Gemini 3+ thought signature 需要由上层原样回传。 */
  readonly thoughtSignature?: string;
}

export interface RuntimeChatMessage {
  readonly role: RuntimeChatRole;
  readonly content: string | null;
  readonly reasoningContent?: string | null;
  readonly toolCalls?: readonly RuntimeToolCallRecord[];
  readonly toolCallId?: string;
  readonly name?: string;
}

export interface RuntimeToolSchema {
  readonly name: string;
  readonly description?: string;
  readonly parameters: Record<string, unknown>;
  readonly [key: string]: unknown;
}

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

export interface RuntimeChatWithToolsOptions {
  readonly messages?: readonly RuntimeChatMessage[];
  readonly toolSchemas?: readonly RuntimeToolSchema[];
  readonly tools?: readonly RuntimeToolSchema[];
  readonly toolChoice?: string | null;
  readonly systemPrompt?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly abortSignal?: AbortSignal | null;
  readonly modelRef?: string;
}

export interface RuntimeAiProvider {
  readonly name?: string;
  readonly _circuitState?: string;
  chatWithTools(prompt: string, options?: RuntimeChatWithToolsOptions): Promise<LLMResult | null>;
}

export interface RuntimePolicyStepState {
  readonly iteration: number;
  readonly startTime: number;
  readonly totalTokens: number;
  readonly totalInputTokens: number;
}

export interface RuntimePolicyEngine {
  validateDuring(stepState: RuntimePolicyStepState): {
    readonly ok: boolean;
    readonly action?: string;
    readonly reason?: string;
  };
}

export interface RuntimePromptCapability {
  readonly promptFragment: string;
  buildContext?(context: Record<string, unknown>): string | null | undefined;
}

export interface RuntimeStrategyConfig extends Record<string, unknown> {
  readonly budget?: Record<string, unknown>;
  readonly defaultBudget?: Record<string, unknown>;
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

export interface AgentMessageSession {
  readonly id: string;
  readonly history?: ReadonlyArray<{ readonly role: string; readonly content: string }>;
}

export interface AgentMessageSender {
  readonly id: string;
  readonly name?: string;
  readonly type: "user" | "system" | "agent";
}

export interface AgentMessageLike {
  readonly content: string;
  readonly channel?: string;
  readonly session?: AgentMessageSession;
  readonly sender?: AgentMessageSender;
  readonly metadata?: Record<string, unknown>;
  reply?(text: string): void | Promise<void>;
  readonly replyFn?: ((text: string) => void | Promise<void>) | null;
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
  readonly aiProvider?: RuntimeAiProvider | null;
  readonly toolRouter: ToolRouterContract;
  readonly strategy?: RuntimeStrategyConfig | null;
  readonly policies?: RuntimePolicyEngine | null;
  readonly capabilities?: readonly RuntimePromptCapability[];
  readonly persona?: Record<string, unknown>;
  readonly memory?: Record<string, unknown>;
  readonly onProgress?: ((event: ProgressEvent) => void) | null;
  readonly onToolCall?: ToolCallHook | null;
  readonly lang?: string | null;
  readonly projectRoot?: string;
  readonly dataRoot?: string;
  readonly additionalTools?: readonly string[];
  readonly defaultBudget?: Record<string, unknown>;
  /** 可选 LLM Gateway。新仓库里它遵循 RuntimeAiProvider 的 chatWithTools 契约。 */
  readonly gateway?: RuntimeAiProvider | null;
  /** Gateway 使用的模型引用，例如 provider:model。 */
  readonly modelRef?: string;
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
  readonly contextWindow?: unknown;
  readonly tracker?: unknown;
  readonly trace?: unknown;
  readonly memoryCoordinator?: unknown;
  readonly [key: string]: unknown;
}

/** 单轮最多消费的工具调用数，避免模型一次性展开过大的 fan-out。 */
export const MAX_TOOL_CALLS_PER_ITER = 8;

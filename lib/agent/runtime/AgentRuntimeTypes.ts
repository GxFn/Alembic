/**
 * AgentRuntimeTypes — AgentRuntime 共享类型定义
 *
 * 从 AgentRuntime.ts 提取的接口和类型，
 * 供 AgentRuntime、ToolExecutionPipeline、LarkTransport 及测试文件独立消费。
 *
 * @module AgentRuntimeTypes
 */

/** Tool call entry recorded during execution */
export interface ToolCallEntry {
  tool: string;
  name?: string;
  args: Record<string, unknown>;
  result: unknown;
  envelope?: import('#tools/core/ToolResultEnvelope.js').ToolResultEnvelope;
  durationMs: number;
}

/** LLM function call descriptor */
export interface FunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** chatWithTools result from the AI provider */
export interface LLMResult {
  type?: string;
  text?: string | null;
  functionCalls?: FunctionCall[] | null;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** DeepSeek V4 thinking 推理内容，需原样回传 */
  reasoningContent?: string | null;
}

/** AI error with optional circuit breaker code */
export interface AiError extends Error {
  code?: string;
}

/** Progress event emitted to listeners */
export interface ProgressEvent {
  type: string;
  agentId: string;
  preset: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface AgentDiagnosticWarning {
  code: string;
  message: string;
  stage?: string;
  tool?: string;
}

export interface ToolCallDiagnostic {
  tool: string;
  callId: string;
  parentCallId?: string;
  status: string;
  ok: boolean;
  surface?: string;
  source?: string;
  kind?: string;
  startedAt: string;
  durationMs: number;
}

export interface StageToolsetDiagnostic {
  stage: string;
  capabilities: string[];
  allowedToolIds: string[];
  toolSchemaCount: number;
  source?: string;
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

/** Tool execution pipeline metadata */
export interface ToolMetadata {
  cacheHit: boolean;
  blocked: boolean;
  isNew: boolean;
  durationMs: number;
  dedupMessage?: string;
  isSubmit?: boolean;
  envelope?: import('#tools/core/ToolResultEnvelope.js').ToolResultEnvelope;
}

/** File cache entry */
export interface FileCacheEntry {
  relativePath: string;
  content?: string;
  name?: string;
}

export interface RuntimeConfig {
  id?: string;
  presetName?: string;
  aiProvider: import('#external/ai/AiProvider.js').AiProvider;
  toolRegistry: import('#tools/catalog/ToolRegistry.js').ToolRegistry;
  toolRouter?: import('#tools/core/ToolContracts.js').ToolRouterContract | null;
  container?: Record<string, unknown> | null;
  capabilities?: import('../capabilities/index.js').Capability[];
  strategy: import('../strategies/index.js').Strategy;
  policies?: import('../policies/index.js').PolicyEngine;
  persona?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  onProgress?: ((event: ProgressEvent) => void) | null;
  onToolCall?: ToolCallHook | null;
  lang?: string | null;
  projectRoot?: string;
  dataRoot?: string;
  additionalTools?: string[];
}

export type ToolCallHook = (
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  iteration: number
) => void;

export interface AgentResult {
  reply: string;
  toolCalls: ToolCallEntry[];
  tokenUsage: { input: number; output: number };
  iterations: number;
  durationMs: number;
  phases?: Record<string, unknown>;
  diagnostics?: AgentDiagnostics;
  state: Record<string, unknown>;
  qualityWarning?: string;
  [key: string]: unknown;
}

export interface ReactLoopOpts {
  history?: Array<{ role: string; content: string }>;
  context?: Record<string, unknown>;
  capabilityOverride?: string[];
  additionalToolsOverride?: string[];
  budgetOverride?: Record<string, unknown>;
  systemPromptOverride?: string;
  onToolCall?: ToolCallHook | null;
  contextWindow?: import('../context/ContextWindow.js').ContextWindow;
  tracker?: Record<string, unknown>;
  trace?: Record<string, unknown>;
  memoryCoordinator?: Record<string, unknown>;
  sharedState?: Record<string, unknown>;
  source?: string;
  toolChoiceOverride?: string | null;
  /** 外部中止信号 — PipelineStrategy hard timeout 时取消进行中的 LLM 调用 */
  abortSignal?: AbortSignal;
  diagnostics?: unknown;
  [key: string]: unknown;
}

/** 单次迭代允许的最大工具调用数 */
export const MAX_TOOL_CALLS_PER_ITER = 8;

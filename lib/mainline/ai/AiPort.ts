import type { ContextBundle, EvidencePackage } from "../knowledge/index.js";

export type AiCapabilityKind =
  | "summarize-evidence"
  | "propose-recipes"
  | "propose-recipe-edges"
  | "compress-context-bundle"
  | "explain-guard-finding"
  | "draft-capture";

export type AiTaskOrigin = "content-mining" | "knowledge-injection";

export interface AiProviderStatus {
  provider: string;
  model?: string | undefined;
  ready: boolean;
  mock: boolean;
  reason?: string | undefined;
}

export interface AiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** 部分模型要求多轮工具调用原样回传 thought signature。 */
  thoughtSignature?: string | undefined;
}

export interface AiChatMessage {
  role: "user" | "assistant" | "tool";
  content?: string | null | undefined;
  /** DeepSeek/Gemini 等模型的推理内容需要在运行期消息里原样保留。 */
  reasoningContent?: string | null | undefined;
  toolCalls?: AiToolCall[] | undefined;
  toolCallId?: string | undefined;
  name?: string | undefined;
}

export interface AiToolSchema {
  name: string;
  description?: string | undefined;
  parameters?: Record<string, unknown> | undefined;
}

export interface AiTask {
  id: string;
  origin: AiTaskOrigin;
  kind: AiCapabilityKind;
  title: string;
  prompt: string;
  evidencePackage?: EvidencePackage | undefined;
  contextBundle?: ContextBundle | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface AiTextRequest {
  task: AiTask;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  abortSignal?: AbortSignal | undefined;
}

export interface AiJsonRequest extends AiTextRequest {
  schema?: Record<string, unknown> | undefined;
}

export interface AiTextResult {
  text: string;
  provider: string;
  model?: string | undefined;
  usage?: AiUsage | undefined;
}

export interface AiJsonResult {
  value: unknown;
  provider: string;
  model?: string | undefined;
  usage?: AiUsage | undefined;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number | undefined;
  cacheHitTokens?: number | undefined;
}

export interface AiTextChatOptions {
  history?: Array<{ role: "user" | "assistant"; content: string }> | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  systemPrompt?: string | undefined;
  abortSignal?: AbortSignal | undefined;
}

export interface AiStructuredOutputOptions {
  schema?: Record<string, unknown> | undefined;
  openChar?: string | undefined;
  closeChar?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  systemPrompt?: string | undefined;
  abortSignal?: AbortSignal | undefined;
}

export interface AiToolChatOptions {
  messages?: AiChatMessage[] | undefined;
  toolSchemas?: AiToolSchema[] | undefined;
  toolChoice?: string | undefined;
  systemPrompt?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  abortSignal?: AbortSignal | undefined;
}

export interface AiToolChatResult {
  type?: string | undefined;
  text?: string | null | undefined;
  functionCalls?: AiToolCall[] | null | undefined;
  usage?: AiUsage | null | undefined;
  reasoningContent?: string | null | undefined;
}

export interface AiGatewayChatRequest {
  modelRef: string;
  prompt: string;
  systemPrompt?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  responseFormat?: "text" | "json" | undefined;
  abortSignal?: AbortSignal | undefined;
}

export interface AiGatewayToolChatRequest {
  modelRef: string;
  messages: AiChatMessage[];
  tools?: AiToolSchema[] | undefined;
  toolChoice?: string | undefined;
  systemPrompt?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  responseFormat?: "text" | "json" | undefined;
  abortSignal?: AbortSignal | undefined;
}

/**
 * MainlineAiPort 是新主线唯一允许依赖的 AI 能力端口。
 * 它只表达真实 provider 能力；mock provider 不实现这个端口，也不进入主线。
 */
export interface MainlineAiPort {
  status(): AiProviderStatus;
  generateText(request: AiTextRequest): Promise<AiTextResult>;
  generateJson(request: AiJsonRequest): Promise<AiJsonResult>;
}

/**
 * MainlineAgentAiPort 是 AgentRuntime 直接需要的 AI 端口。
 * 它保留 provider 的 tool-calling 语义，但类型归属主线，避免 agent 继续认识 external/ai。
 */
export interface MainlineAgentAiPort {
  name: string;
  model: string;
  _circuitState?: string | undefined;
  chat(prompt: string, context?: AiTextChatOptions): Promise<string>;
  chatWithTools(prompt: string, opts?: AiToolChatOptions): Promise<AiToolChatResult>;
  chatWithStructuredOutput?(prompt: string, opts?: AiStructuredOutputOptions): Promise<unknown>;
  embed?(text: string | string[]): Promise<number[] | number[][]>;
  supportsEmbedding?(): boolean;
}

/**
 * MainlineLLMGatewayPort 描述 Gateway 形态的 AI 调用。
 * Gateway 仍可作为具体实现，但 agent/runtime 只面向这个主线端口。
 */
export interface MainlineLLMGatewayPort {
  chat(request: AiGatewayChatRequest): Promise<string>;
  chatStructured?(request: AiGatewayChatRequest): Promise<unknown>;
  chatWithTools(request: AiGatewayToolChatRequest): Promise<AiToolChatResult>;
  embed?(request: {
    modelRef: string;
    text: string | string[];
    abortSignal?: AbortSignal | undefined;
  }): Promise<number[] | number[][]>;
}

/**
 * MainlineEmbeddingPort 是所有语义存储、搜索和冷启动可依赖的唯一 embedding 入口。
 */
export interface MainlineEmbeddingPort {
  status(): AiProviderStatus;
  embedText(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

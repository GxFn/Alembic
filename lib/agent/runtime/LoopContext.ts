import type {
  LLMResult,
  RuntimeToolSchema,
  ToolCallEntry,
  ToolCallHook,
} from "./AgentRuntimeTypes.js";
import type { BudgetController } from "./BudgetController.js";
import type { DiagnosticsCollector } from "./DiagnosticsCollector.js";
import type { ExitController } from "./ExitController.js";
import type { MessageAdapter } from "./MessageAdapter.js";
import type { RuntimeCapability } from "./SystemPromptBuilder.js";

export interface LoopBudgetConfig {
  readonly maxIterations?: number;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly maxSessionInputTokens?: number;
  readonly maxSessionTokens?: number;
  readonly [key: string]: unknown;
}

export interface LoopContextConfig {
  readonly messages: MessageAdapter;
  readonly tracker?: unknown;
  readonly trace?: unknown;
  readonly memoryCoordinator?: unknown;
  readonly sharedState?: Record<string, unknown> | null;
  readonly source?: string;
  readonly budget: LoopBudgetConfig;
  readonly capabilities: readonly RuntimeCapability[];
  readonly baseSystemPrompt: string;
  readonly allowedToolIds: readonly string[];
  readonly toolSchemas: readonly RuntimeToolSchema[];
  readonly prompt: string;
  readonly onToolCall?: ToolCallHook | null;
  readonly context?: Record<string, unknown>;
  readonly contextWindow?: unknown;
  readonly toolChoiceOverride?: string | null;
  readonly abortSignal?: AbortSignal | null;
  readonly diagnostics?: DiagnosticsCollector | null;
  readonly exitController?: ExitController | null;
}

export class LoopContext {
  readonly messages: MessageAdapter;
  readonly tracker: unknown;
  readonly trace: unknown;
  readonly memoryCoordinator: unknown;
  readonly sharedState: Record<string, unknown> | null;
  readonly source: string;
  readonly budget: LoopBudgetConfig;
  readonly capabilities: readonly RuntimeCapability[];
  readonly baseSystemPrompt: string;
  readonly allowedToolIds: readonly string[];
  readonly toolSchemas: readonly RuntimeToolSchema[];
  readonly prompt: string;
  readonly onToolCall: ToolCallHook | null;
  readonly context: Record<string, unknown>;
  readonly contextWindow: unknown;
  readonly toolChoiceOverride: string | null;
  readonly abortSignal: AbortSignal | null;
  readonly diagnostics: DiagnosticsCollector | null;
  exitController: ExitController | null;
  budgetController: BudgetController | null = null;
  iteration = 0;
  lastReply = "";
  toolCalls: ToolCallEntry[] = [];
  tokenUsage = { input: 0, output: 0, reasoning: 0, cacheHit: 0 };
  loopStartTime = Date.now();
  consecutiveAiErrors = 0;
  consecutiveEmptyResponses = 0;

  constructor(config: LoopContextConfig) {
    this.messages = config.messages;
    this.tracker = config.tracker ?? null;
    this.trace = config.trace ?? null;
    this.memoryCoordinator = config.memoryCoordinator ?? null;
    this.sharedState = config.sharedState ?? null;
    this.source = config.source ?? "user";
    this.budget = config.budget;
    this.capabilities = config.capabilities;
    this.baseSystemPrompt = config.baseSystemPrompt;
    this.allowedToolIds = [...config.allowedToolIds];
    this.toolSchemas = [...config.toolSchemas];
    this.prompt = config.prompt;
    this.onToolCall = config.onToolCall ?? null;
    this.context = config.context ?? {};
    this.contextWindow = config.contextWindow ?? null;
    this.toolChoiceOverride = config.toolChoiceOverride ?? null;
    this.abortSignal = config.abortSignal ?? null;
    this.diagnostics = config.diagnostics ?? null;
    this.exitController = config.exitController ?? null;
  }

  get isSystem(): boolean {
    return this.source === "system";
  }

  get maxIterations(): number {
    return numberOrDefault(this.budget.maxIterations, 20);
  }

  addTokenUsage(usage: LLMResult["usage"] | null | undefined): void {
    if (!usage) {
      return;
    }
    this.tokenUsage.input += usage.inputTokens ?? 0;
    this.tokenUsage.output += usage.outputTokens ?? 0;
    this.tokenUsage.reasoning += usage.reasoningTokens ?? 0;
    this.tokenUsage.cacheHit += usage.cacheHitTokens ?? 0;
  }

  buildResult(): {
    readonly reply: string;
    readonly toolCalls: readonly ToolCallEntry[];
    readonly tokenUsage: {
      readonly input: number;
      readonly output: number;
      readonly reasoning: number;
      readonly cacheHit: number;
    };
    readonly iterations: number;
  } {
    return {
      reply: this.lastReply,
      toolCalls: [...this.toolCalls],
      tokenUsage: { ...this.tokenUsage },
      iterations: this.iteration,
    };
  }
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

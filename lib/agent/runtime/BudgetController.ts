export interface TokenUsageAccumulator {
  input: number;
  output: number;
  reasoning: number;
  cacheHit: number;
}

export interface RuntimeContextWindow {
  compactIfNeeded(): CompactionResult;
  compactL4?(aiProvider: {
    chatWithTools(
      prompt: string,
      opts: Record<string, unknown>,
    ): Promise<{ readonly text?: string; readonly usage?: LLMUsageInput } | null>;
  }): Promise<{ readonly removed: number; readonly usage?: LLMUsageInput }>;
  needsL4Compaction?(): boolean;
  setSessionPressure?(pressure: number): void;
  estimateFullContextTokens?(baseSystemPromptLength: number, toolSchemaCount: number): number;
  getToolResultQuota?(): { maxChars: number; maxMatches: number };
}

export interface BudgetLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface BudgetControllerConfig {
  readonly maxSessionInputTokens: number;
  readonly maxSessionTokens?: number;
  readonly cumulativeUsage: TokenUsageAccumulator;
  readonly contextWindow?: RuntimeContextWindow | null;
  readonly tracker?: { forceTerminal?(reason: string): void } | null;
  readonly baseSystemPromptLength?: number;
  readonly toolSchemaCount?: number;
  readonly logger?: BudgetLogger;
}

export interface PreLLMCheckResult {
  readonly action: "normal" | "compress";
  readonly estimatedNextCallTokens: number;
  readonly sessionUsageRatio: number;
  readonly compaction: CompactionResult;
}

export interface CompactionResult {
  readonly level: number;
  readonly removed: number;
}

export interface ToolBudget {
  readonly roundMaxChars: number;
  readonly perToolMaxChars: number;
  readonly perToolMaxMatches: number;
}

export interface LLMUsageInput {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheHitTokens?: number;
}

export interface SessionBudgetSummary {
  readonly totalIterations: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalReasoningTokens: number;
  readonly avgCacheHitRate: number;
  readonly peakSessionUsageRatio: number;
  readonly maxCompactionLevel: number;
  readonly totalCompactedItems: number;
  readonly forcedSummarize: boolean;
}

const COMPRESS_THRESHOLD = 0.75;
const AGGRESSIVE_COMPRESS_THRESHOLD = 0.9;
const DEFAULT_ESTIMATE = 8000;
const MIN_TOOL_CHARS = 400;

const nullLogger: BudgetLogger = {
  info() {},
  warn() {},
};

export class BudgetController {
  readonly #maxSessionInputTokens: number;
  readonly #cumulativeUsage: TokenUsageAccumulator;
  readonly #contextWindow: RuntimeContextWindow | null;
  readonly #baseSystemPromptLength: number;
  readonly #toolSchemaCount: number;
  readonly #logger: BudgetLogger;

  #lastRoundInputTokens = 0;
  #pendingL4 = false;
  #consecutiveZeroCacheHits = 0;
  #iterationCount = 0;
  #peakSessionUsageRatio = 0;
  #maxCompactionLevel = 0;
  #totalCompactedItems = 0;
  #forcedSummarize = false;
  #roundMaxChars = 0;
  #roundCharsUsed = 0;
  #roundPerToolMaxMatches = 0;

  constructor(config: BudgetControllerConfig) {
    this.#maxSessionInputTokens = config.maxSessionInputTokens;
    this.#cumulativeUsage = config.cumulativeUsage;
    this.#contextWindow = config.contextWindow ?? null;
    this.#baseSystemPromptLength = config.baseSystemPromptLength ?? 0;
    this.#toolSchemaCount = config.toolSchemaCount ?? 0;
    this.#logger = config.logger ?? nullLogger;
  }

  get hasSessionBudget(): boolean {
    return this.#maxSessionInputTokens > 0;
  }

  get pendingL4(): boolean {
    return this.#pendingL4;
  }

  get sessionUsageRatio(): number {
    return this.hasSessionBudget ? this.#cumulativeUsage.input / this.#maxSessionInputTokens : 0;
  }

  get cumulativeUsage(): Readonly<TokenUsageAccumulator> {
    return this.#cumulativeUsage;
  }

  checkBeforeLLMCall(iteration: number): PreLLMCheckResult {
    if (!this.hasSessionBudget) {
      return {
        action: "normal",
        estimatedNextCallTokens: 0,
        sessionUsageRatio: 0,
        compaction: { level: 0, removed: 0 },
      };
    }

    const estimated = this.#estimateNextCallTokens(iteration);
    const ratio = (this.#cumulativeUsage.input + estimated) / this.#maxSessionInputTokens;
    this.#contextWindow?.setSessionPressure?.(this.sessionUsageRatio);
    if (ratio <= COMPRESS_THRESHOLD) {
      return {
        action: "normal",
        estimatedNextCallTokens: estimated,
        sessionUsageRatio: ratio,
        compaction: { level: 0, removed: 0 },
      };
    }

    // 超过阈值时只触发压缩，不在预算层直接终止运行。
    const compaction = this.runCompactionCycle();
    if (ratio > AGGRESSIVE_COMPRESS_THRESHOLD && this.#contextWindow?.needsL4Compaction?.()) {
      this.#pendingL4 = true;
    }
    this.#logger.info(
      `[BudgetController] session pressure ${(ratio * 100).toFixed(1)}% -> compact L${compaction.level}`,
    );
    return {
      action: "compress",
      estimatedNextCallTokens: estimated,
      sessionUsageRatio: ratio,
      compaction,
    };
  }

  runCompactionCycle(): CompactionResult {
    const result = this.#contextWindow?.compactIfNeeded() ?? { level: 0, removed: 0 };
    this.#trackCompaction(result);
    return result;
  }

  requestL4Compaction(): void {
    this.#pendingL4 = true;
  }

  async executeL4IfPending(
    aiProvider: {
      chatWithTools(
        prompt: string,
        opts: Record<string, unknown>,
      ): Promise<{ readonly text?: string; readonly usage?: LLMUsageInput } | null>;
    },
    addLoopTokenUsage?: (usage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
    }) => void,
  ): Promise<CompactionResult> {
    if (!this.#pendingL4 || !this.#contextWindow?.compactL4) {
      return { level: 0, removed: 0 };
    }
    this.#pendingL4 = false;
    try {
      const l4Result = await this.#contextWindow.compactL4(aiProvider);
      if (l4Result.removed > 0) {
        this.#logger.info(
          `[BudgetController] L4 compaction executed: removed ${l4Result.removed} messages`,
        );
      }
      if (l4Result.usage) {
        const inputTokens = l4Result.usage.inputTokens ?? 0;
        const outputTokens = l4Result.usage.outputTokens ?? 0;
        this.#cumulativeUsage.input += inputTokens;
        this.#cumulativeUsage.output += outputTokens;
        this.#cumulativeUsage.reasoning += l4Result.usage.reasoningTokens ?? 0;
        this.#cumulativeUsage.cacheHit += l4Result.usage.cacheHitTokens ?? 0;
        addLoopTokenUsage?.({ inputTokens, outputTokens });
      }
      const result = { level: 4, removed: l4Result.removed };
      this.#trackCompaction(result);
      return result;
    } catch (error) {
      this.#logger.warn(`[BudgetController] L4 compaction failed: ${String(error)}`);
      return { level: 0, removed: 0 };
    }
  }

  recordLLMUsage(usage: LLMUsageInput): void {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const reasoning = usage.reasoningTokens ?? 0;
    const cacheHit = usage.cacheHitTokens ?? 0;
    this.#cumulativeUsage.input += input;
    this.#cumulativeUsage.output += output;
    this.#cumulativeUsage.reasoning += reasoning;
    this.#cumulativeUsage.cacheHit += cacheHit;
    this.#lastRoundInputTokens = input;
    this.#iterationCount += 1;
    this.#peakSessionUsageRatio = Math.max(this.#peakSessionUsageRatio, this.sessionUsageRatio);
  }

  getToolBudget(parallelCount: number): ToolBudget {
    const safeCount = Math.max(1, parallelCount);
    const quota = this.#contextWindow?.getToolResultQuota?.() ?? { maxChars: 6000, maxMatches: 15 };
    const scaleFactor = Math.ceil(safeCount / 2);
    const roundMaxChars = quota.maxChars * scaleFactor;
    const perToolMaxChars = Math.max(MIN_TOOL_CHARS, Math.floor(roundMaxChars / safeCount));
    const perToolMaxMatches = Math.max(2, Math.floor((quota.maxMatches * scaleFactor) / safeCount));
    this.#roundMaxChars = roundMaxChars;
    this.#roundCharsUsed = 0;
    this.#roundPerToolMaxMatches = perToolMaxMatches;
    return { roundMaxChars, perToolMaxChars, perToolMaxMatches };
  }

  recordToolCharsUsed(chars: number): void {
    this.#roundCharsUsed += Math.max(0, chars);
  }

  getRemainingToolBudget(): { maxChars: number; maxMatches: number } {
    return {
      maxChars: Math.max(MIN_TOOL_CHARS, this.#roundMaxChars - this.#roundCharsUsed),
      maxMatches: this.#roundPerToolMaxMatches,
    };
  }

  emitTurnTelemetry(params: {
    readonly iteration: number;
    readonly currentUsage: LLMUsageInput;
    readonly compaction: CompactionResult;
  }): void {
    const input = params.currentUsage.inputTokens ?? 0;
    const cache = params.currentUsage.cacheHitTokens ?? 0;
    const cacheRate = input > 0 ? (cache / input) * 100 : 0;
    this.#logger.info(
      `[TurnTelemetry] iter=${params.iteration} in=${input} out=${params.currentUsage.outputTokens ?? 0} cache=${cacheRate.toFixed(0)}% compact=L${params.compaction.level}`,
    );
    if (cache === 0 && input > 1024) {
      this.#consecutiveZeroCacheHits += 1;
      if (this.#consecutiveZeroCacheHits >= 3) {
        this.#logger.warn("[TurnTelemetry] 3 consecutive turns with 0 cache hits.");
      }
    } else {
      this.#consecutiveZeroCacheHits = 0;
    }
  }

  getSessionSummary(): SessionBudgetSummary {
    const totalInput = this.#cumulativeUsage.input;
    return {
      totalIterations: this.#iterationCount,
      totalInputTokens: totalInput,
      totalOutputTokens: this.#cumulativeUsage.output,
      totalReasoningTokens: this.#cumulativeUsage.reasoning,
      avgCacheHitRate: totalInput > 0 ? this.#cumulativeUsage.cacheHit / totalInput : 0,
      peakSessionUsageRatio: this.#peakSessionUsageRatio,
      maxCompactionLevel: this.#maxCompactionLevel,
      totalCompactedItems: this.#totalCompactedItems,
      forcedSummarize: this.#forcedSummarize,
    };
  }

  #estimateNextCallTokens(iteration: number): number {
    if (this.#lastRoundInputTokens > 0) {
      return this.#lastRoundInputTokens;
    }
    const contextEstimate = this.#contextWindow?.estimateFullContextTokens?.(
      this.#baseSystemPromptLength,
      this.#toolSchemaCount,
    );
    if (contextEstimate !== undefined) {
      return contextEstimate;
    }
    if (iteration > 1 && this.#cumulativeUsage.input > 0) {
      return Math.ceil(this.#cumulativeUsage.input / (iteration - 1));
    }
    return DEFAULT_ESTIMATE;
  }

  #trackCompaction(result: CompactionResult): void {
    this.#maxCompactionLevel = Math.max(this.#maxCompactionLevel, result.level);
    this.#totalCompactedItems += result.removed;
  }
}

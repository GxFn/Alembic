import type { ToolResultEnvelope } from "../tools/index.js";
import type {
  AgentDiagnostics,
  AgentDiagnosticWarning,
  StageToolsetDiagnostic,
  ToolCallDiagnostic,
} from "./AgentRuntimeTypes.js";

function emptyDiagnostics(): AgentDiagnostics {
  return {
    degraded: false,
    fallbackUsed: false,
    warnings: [],
    timedOutStages: [],
    blockedTools: [],
    truncatedToolCalls: 0,
    emptyResponses: 0,
    aiErrorCount: 0,
    gateFailures: [],
  };
}

function isDiagnostics(value: unknown): value is Partial<AgentDiagnostics> {
  return typeof value === "object" && value !== null;
}

export class DiagnosticsCollector {
  #diagnostics: AgentDiagnostics = emptyDiagnostics();

  constructor(seed?: Partial<AgentDiagnostics>) {
    if (seed) {
      this.merge(seed);
    }
  }

  static from(value: unknown): DiagnosticsCollector {
    if (value instanceof DiagnosticsCollector) {
      return value;
    }
    return new DiagnosticsCollector(isDiagnostics(value) ? value : undefined);
  }

  markDegraded(): void {
    this.#diagnostics.degraded = true;
  }

  markFallbackUsed(): void {
    this.#diagnostics.fallbackUsed = true;
  }

  warn(warning: AgentDiagnosticWarning): void {
    this.#diagnostics.warnings.push(warning);
  }

  recordTimedOutStage(stage: string): void {
    if (!this.#diagnostics.timedOutStages.includes(stage)) {
      this.#diagnostics.timedOutStages.push(stage);
    }
  }

  recordBlockedTool(tool: string, reason: string): void {
    this.#diagnostics.blockedTools.push({ tool, reason });
  }

  recordTruncatedToolCalls(count: number): void {
    if (count > 0) {
      this.#diagnostics.truncatedToolCalls += count;
    }
  }

  recordEmptyResponse(): void {
    this.#diagnostics.emptyResponses += 1;
  }

  recordAiError(message: string): void {
    this.#diagnostics.aiErrorCount += 1;
    this.warn({ code: "ai_error", message });
  }

  recordGateFailure(stage: string, action: string, reason?: string): void {
    this.#diagnostics.gateFailures.push({ stage, action, ...(reason ? { reason } : {}) });
    if (action === "degrade") {
      this.markDegraded();
    }
  }

  recordStageToolset(toolset: StageToolsetDiagnostic): void {
    if (!this.#diagnostics.stageToolsets) {
      this.#diagnostics.stageToolsets = [];
    }
    const entries = this.#diagnostics.stageToolsets;
    entries.push({
      stage: toolset.stage,
      capabilities: [...toolset.capabilities],
      allowedToolIds: [...toolset.allowedToolIds],
      toolSchemaCount: toolset.toolSchemaCount,
      ...(toolset.source ? { source: toolset.source } : {}),
    });
  }

  recordToolCallEnvelope(
    envelope: ToolResultEnvelope,
    context: { kind?: string; surface?: string; source?: string } = {},
  ): void {
    if (!this.#diagnostics.toolCalls) {
      this.#diagnostics.toolCalls = [];
    }
    const calls = this.#diagnostics.toolCalls;
    const now = new Date().toISOString();
    const callId = envelope.meta?.requestId ?? `${envelope.name}:${calls.length + 1}`;
    const entry: ToolCallDiagnostic = {
      tool: envelope.name,
      callId,
      status: envelope.status,
      ok: envelope.ok,
      ...(context.surface ? { surface: context.surface } : {}),
      ...(context.source ? { source: context.source } : {}),
      ...(context.kind ? { kind: context.kind } : {}),
      startedAt: now,
      durationMs: 0,
    };
    const existingIndex = calls.findIndex((call) => call.callId === callId);
    if (existingIndex >= 0) {
      calls[existingIndex] = entry;
    } else {
      calls.push(entry);
    }
  }

  merge(input: unknown): void {
    if (!isDiagnostics(input)) {
      return;
    }
    if (input.degraded) {
      this.markDegraded();
    }
    if (input.fallbackUsed) {
      this.markFallbackUsed();
    }
    for (const warning of input.warnings ?? []) {
      this.warn(warning);
    }
    for (const stage of input.timedOutStages ?? []) {
      this.recordTimedOutStage(stage);
    }
    for (const blockedTool of input.blockedTools ?? []) {
      this.recordBlockedTool(blockedTool.tool, blockedTool.reason);
    }
    this.recordTruncatedToolCalls(input.truncatedToolCalls ?? 0);
    for (let index = 0; index < (input.emptyResponses ?? 0); index += 1) {
      this.recordEmptyResponse();
    }
    this.#diagnostics.aiErrorCount += input.aiErrorCount ?? 0;
    for (const gateFailure of input.gateFailures ?? []) {
      this.recordGateFailure(gateFailure.stage, gateFailure.action, gateFailure.reason);
    }
    if (input.toolCalls?.length && !this.#diagnostics.toolCalls) {
      this.#diagnostics.toolCalls = [];
    }
    for (const toolCall of input.toolCalls ?? []) {
      const calls = this.#diagnostics.toolCalls ?? [];
      if (!calls.some((call) => call.callId === toolCall.callId)) {
        calls.push({ ...toolCall });
      }
    }
    for (const toolset of input.stageToolsets ?? []) {
      this.recordStageToolset(toolset);
    }
  }

  isEmpty(): boolean {
    return (
      !this.#diagnostics.degraded &&
      !this.#diagnostics.fallbackUsed &&
      this.#diagnostics.warnings.length === 0 &&
      this.#diagnostics.timedOutStages.length === 0 &&
      this.#diagnostics.blockedTools.length === 0 &&
      this.#diagnostics.truncatedToolCalls === 0 &&
      this.#diagnostics.emptyResponses === 0 &&
      this.#diagnostics.aiErrorCount === 0 &&
      this.#diagnostics.gateFailures.length === 0 &&
      (this.#diagnostics.toolCalls?.length ?? 0) === 0 &&
      (this.#diagnostics.stageToolsets?.length ?? 0) === 0
    );
  }

  toJSON(): AgentDiagnostics {
    return {
      degraded: this.#diagnostics.degraded,
      fallbackUsed: this.#diagnostics.fallbackUsed,
      warnings: [...this.#diagnostics.warnings],
      timedOutStages: [...this.#diagnostics.timedOutStages],
      blockedTools: [...this.#diagnostics.blockedTools],
      truncatedToolCalls: this.#diagnostics.truncatedToolCalls,
      emptyResponses: this.#diagnostics.emptyResponses,
      aiErrorCount: this.#diagnostics.aiErrorCount,
      gateFailures: [...this.#diagnostics.gateFailures],
      ...(this.#diagnostics.toolCalls
        ? { toolCalls: this.#diagnostics.toolCalls.map((call) => ({ ...call })) }
        : {}),
      ...(this.#diagnostics.stageToolsets
        ? {
            stageToolsets: this.#diagnostics.stageToolsets.map((toolset) => ({
              ...toolset,
              capabilities: [...toolset.capabilities],
              allowedToolIds: [...toolset.allowedToolIds],
            })),
          }
        : {}),
    };
  }
}

import type { ToolDiagnosticsRecorder } from '#tools/core/ToolCallContext.js';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
import type {
  AgentDiagnostics,
  AgentDiagnosticWarning,
  StageToolsetDiagnostic,
  ToolCallDiagnostic,
} from './AgentRuntimeTypes.js';

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
  return !!value && typeof value === 'object';
}

export class DiagnosticsCollector implements ToolDiagnosticsRecorder {
  #diagnostics: AgentDiagnostics;

  constructor(seed?: Partial<AgentDiagnostics>) {
    this.#diagnostics = emptyDiagnostics();
    if (seed) {
      this.merge(seed);
    }
  }

  static from(value: unknown) {
    if (value instanceof DiagnosticsCollector) {
      return value;
    }
    return new DiagnosticsCollector(isDiagnostics(value) ? value : undefined);
  }

  markDegraded() {
    this.#diagnostics.degraded = true;
  }

  markFallbackUsed() {
    this.#diagnostics.fallbackUsed = true;
  }

  warn(warning: AgentDiagnosticWarning) {
    this.#diagnostics.warnings.push(warning);
  }

  recordTimedOutStage(stage: string) {
    if (!this.#diagnostics.timedOutStages.includes(stage)) {
      this.#diagnostics.timedOutStages.push(stage);
    }
  }

  recordBlockedTool(tool: string, reason: string) {
    this.#diagnostics.blockedTools.push({ tool, reason });
  }

  recordTruncatedToolCalls(count: number) {
    if (count > 0) {
      this.#diagnostics.truncatedToolCalls += count;
    }
  }

  recordEmptyResponse() {
    this.#diagnostics.emptyResponses++;
  }

  recordAiError(message: string) {
    this.#diagnostics.aiErrorCount++;
    this.warn({ code: 'ai_error', message });
  }

  recordGateFailure(stage: string, action: string, reason?: string) {
    this.#diagnostics.gateFailures.push({ stage, action, ...(reason ? { reason } : {}) });
    if (action === 'degrade') {
      this.markDegraded();
    }
  }

  recordStageToolset(toolset: StageToolsetDiagnostic) {
    const entries = (this.#diagnostics.stageToolsets ??= []);
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
    context: {
      kind?: string;
      surface?: string;
      source?: string;
    } = {}
  ) {
    const calls = (this.#diagnostics.toolCalls ??= []);
    const entry: ToolCallDiagnostic = {
      tool: envelope.toolId,
      callId: envelope.callId,
      ...(envelope.parentCallId ? { parentCallId: envelope.parentCallId } : {}),
      status: envelope.status,
      ok: envelope.ok,
      ...(context.surface ? { surface: context.surface } : {}),
      ...(context.source ? { source: context.source } : {}),
      ...(context.kind ? { kind: context.kind } : {}),
      startedAt: envelope.startedAt,
      durationMs: envelope.durationMs,
    };
    const existingIndex = calls.findIndex((call) => call.callId === envelope.callId);
    if (existingIndex >= 0) {
      calls[existingIndex] = entry;
    } else {
      calls.push(entry);
    }
  }

  merge(input: unknown) {
    if (!isDiagnostics(input)) {
      return;
    }

    if (input.degraded) {
      this.markDegraded();
    }
    if (input.fallbackUsed) {
      this.markFallbackUsed();
    }
    for (const warning of input.warnings || []) {
      this.warn(warning);
    }
    for (const stage of input.timedOutStages || []) {
      this.recordTimedOutStage(stage);
    }
    for (const blockedTool of input.blockedTools || []) {
      this.recordBlockedTool(blockedTool.tool, blockedTool.reason);
    }
    this.recordTruncatedToolCalls(input.truncatedToolCalls || 0);
    for (let index = 0; index < (input.emptyResponses || 0); index++) {
      this.recordEmptyResponse();
    }
    for (let index = 0; index < (input.aiErrorCount || 0); index++) {
      this.#diagnostics.aiErrorCount++;
    }
    for (const gateFailure of input.gateFailures || []) {
      this.recordGateFailure(gateFailure.stage, gateFailure.action, gateFailure.reason);
    }
    for (const toolCall of input.toolCalls || []) {
      const calls = (this.#diagnostics.toolCalls ??= []);
      if (!calls.some((call) => call.callId === toolCall.callId)) {
        calls.push({ ...toolCall });
      }
    }
    for (const toolset of input.stageToolsets || []) {
      this.recordStageToolset(toolset);
    }
  }

  isEmpty() {
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
      (this.#diagnostics.toolCalls?.length || 0) === 0 &&
      (this.#diagnostics.stageToolsets?.length || 0) === 0
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

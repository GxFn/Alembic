import type { TerminalSessionRecord } from '#tools/adapters/TerminalSessionManager.js';
import type { ToolExecutionRequest } from '#tools/core/ToolContracts.js';
import type {
  ToolArtifactRef,
  ToolResultEnvelope,
  ToolResultStatus,
} from '#tools/core/ToolResultEnvelope.js';

type TerminalPolicyLike = {
  reason?: string;
};

export function envelopeForPolicyBlock(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number,
  policy: TerminalPolicyLike
): ToolResultEnvelope {
  const message = policy.reason || 'Terminal operation blocked by policy';
  return {
    ok: false,
    toolId: request.manifest.id,
    callId: request.context.callId,
    parentCallId: request.context.parentCallId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    status: 'blocked',
    text: message,
    structuredContent: {
      error: message,
      policy,
    },
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [{ code: 'terminal_policy_blocked', message, tool: request.manifest.id }],
      timedOutStages: [],
      blockedTools: [{ tool: request.manifest.id, reason: message }],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [{ stage: 'execute', action: 'terminal-policy', reason: message }],
    },
    trust: {
      source: 'terminal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

export function envelopeForTerminalResult(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number,
  status: ToolResultStatus,
  structuredContent: Record<string, unknown>,
  artifacts: ToolArtifactRef[] = []
): ToolResultEnvelope {
  const ok = status === 'success';
  const text = ok
    ? `Terminal command completed: ${String(structuredContent.bin)}`
    : `Terminal command failed: ${String(structuredContent.bin)}`;
  return {
    ok,
    toolId: request.manifest.id,
    callId: request.context.callId,
    parentCallId: request.context.parentCallId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    status,
    text,
    structuredContent,
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: ok
        ? []
        : [{ code: 'terminal_command_failed', message: text, tool: request.manifest.id }],
      timedOutStages: status === 'timeout' ? [request.manifest.id] : [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'terminal',
      sanitized: true,
      containsUntrustedText: true,
      containsSecrets: false,
    },
  };
}

export function envelopeForSessionResult(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number,
  structuredContent: Record<string, unknown> & {
    action: string;
    sessionRecord?: TerminalSessionRecord | null;
  }
): ToolResultEnvelope {
  return {
    ok: true,
    toolId: request.manifest.id,
    callId: request.context.callId,
    parentCallId: request.context.parentCallId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    status: 'success',
    text: `Terminal session ${structuredContent.action} completed`,
    structuredContent,
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'terminal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

export function envelopeForError(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number,
  message: string,
  structuredContent: Record<string, unknown>
): ToolResultEnvelope {
  return {
    ok: false,
    toolId: request.manifest.id,
    callId: request.context.callId,
    parentCallId: request.context.parentCallId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    status: 'error',
    text: message,
    structuredContent,
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [{ code: 'terminal_input_error', message, tool: request.manifest.id }],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'terminal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

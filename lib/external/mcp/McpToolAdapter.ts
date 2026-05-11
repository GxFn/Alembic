import type { ToolExecutionAdapter, ToolExecutionRequest } from '#tools/core/ToolContracts.js';
import type { ToolResultEnvelope, ToolResultStatus } from '#tools/core/ToolResultEnvelope.js';

export type McpToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
  request: ToolExecutionRequest
) => Promise<unknown>;

export class McpToolAdapter implements ToolExecutionAdapter {
  readonly kind = 'mcp-tool' as const;
  #executeTool: McpToolExecutor;

  constructor(executeTool: McpToolExecutor) {
    this.#executeTool = executeTool;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolResultEnvelope> {
    const startedAt = new Date();
    const startedMs = Date.now();
    const trustDecision = request.manifest.externalTrust;
    if (!trustDecision || !trustDecision.trusted) {
      return blockedTrustEnvelope(
        request,
        startedAt,
        startedMs,
        trustDecision
          ? `MCP tool "${request.manifest.id}" is not trusted: ${trustDecision.reason}`
          : `MCP tool "${request.manifest.id}" is missing a manifest trust decision`,
        trustDecision ? 'MCP_UNTRUSTED_SERVER' : 'MCP_TRUST_DECISION_MISSING'
      );
    }
    try {
      const rawResult = await this.#executeTool(request.manifest.id, request.args, request);
      const structuredContent = unwrapMcpWireResult(rawResult);
      const errorMessage = extractMcpErrorMessage(structuredContent);
      const ok = !errorMessage;
      return {
        ok,
        toolId: request.manifest.id,
        callId: request.context.callId,
        parentCallId: request.context.parentCallId,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedMs,
        status: ok ? 'success' : statusForMcpError(structuredContent),
        text: errorMessage || summarizeMcpResult(structuredContent),
        structuredContent,
        diagnostics: {
          degraded: false,
          fallbackUsed: false,
          warnings: ok
            ? []
            : [
                {
                  code: 'mcp_tool_error',
                  message: errorMessage || 'MCP tool failed',
                  tool: request.manifest.id,
                },
              ],
          timedOutStages: [],
          blockedTools: [],
          truncatedToolCalls: 0,
          emptyResponses: 0,
          aiErrorCount: 0,
          gateFailures: [],
        },
        trust: {
          source: 'mcp',
          sanitized: true,
          containsUntrustedText: trustDecision.outputContainsUntrustedText,
          containsSecrets: false,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        toolId: request.manifest.id,
        callId: request.context.callId,
        parentCallId: request.context.parentCallId,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedMs,
        status: 'error',
        text: message,
        structuredContent: { success: false, message, errorCode: 'MCP_TOOL_ERROR' },
        diagnostics: {
          degraded: false,
          fallbackUsed: false,
          warnings: [{ code: 'mcp_tool_error', message, tool: request.manifest.id }],
          timedOutStages: [],
          blockedTools: [],
          truncatedToolCalls: 0,
          emptyResponses: 0,
          aiErrorCount: 0,
          gateFailures: [],
        },
        trust: {
          source: 'mcp',
          sanitized: true,
          containsUntrustedText: trustDecision.outputContainsUntrustedText,
          containsSecrets: false,
        },
      };
    }
  }
}

function blockedTrustEnvelope(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number,
  message: string,
  errorCode: string
): ToolResultEnvelope {
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
      success: false,
      message,
      errorCode,
      trust: request.manifest.externalTrust ?? null,
    },
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [{ code: 'mcp_trust_blocked', message, tool: request.manifest.id }],
      timedOutStages: [],
      blockedTools: [{ tool: request.manifest.id, reason: message }],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [
        {
          stage: 'execute',
          action: 'mcp-trust',
          reason: message,
        },
      ],
    },
    trust: {
      source: 'mcp',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

function unwrapMcpWireResult(result: unknown) {
  if (!result || typeof result !== 'object') {
    return result;
  }
  const resultObj = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  const firstText = resultObj.content?.find(
    (item) => item.type === 'text' && typeof item.text === 'string'
  )?.text;
  if (!firstText) {
    return result;
  }
  try {
    return JSON.parse(firstText);
  } catch {
    return {
      success: !resultObj.isError,
      message: firstText,
      data: firstText,
    };
  }
}

function extractMcpErrorMessage(result: unknown) {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const resultObj = result as {
    success?: unknown;
    isError?: unknown;
    message?: unknown;
    errorCode?: unknown;
  };
  if (resultObj.success === false || resultObj.isError === true) {
    return String(resultObj.message || resultObj.errorCode || 'MCP tool failed');
  }
  return null;
}

function statusForMcpError(result: unknown): ToolResultStatus {
  if (!result || typeof result !== 'object') {
    return 'error';
  }
  const errorCode = String((result as { errorCode?: unknown }).errorCode || '');
  if (errorCode === 'VALIDATION_ERROR') {
    return 'blocked';
  }
  if (errorCode === 'TIMEOUT') {
    return 'timeout';
  }
  return 'error';
}

function summarizeMcpResult(result: unknown) {
  if (result === undefined) {
    return 'MCP tool completed with no structured result.';
  }
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result === 'object') {
    const resultObj = result as { message?: unknown; data?: unknown };
    if (typeof resultObj.message === 'string' && resultObj.message) {
      return resultObj.message;
    }
    if (resultObj.data !== undefined) {
      return stringifyResult(resultObj.data);
    }
  }
  return stringifyResult(result);
}

function stringifyResult(result: unknown) {
  try {
    return JSON.stringify(result);
  } catch {
    return 'MCP tool completed.';
  }
}

export default McpToolAdapter;

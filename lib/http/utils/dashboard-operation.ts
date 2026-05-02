import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type {
  ToolResultDiagnostics,
  ToolResultEnvelope,
  ToolResultTrust,
} from '#tools/core/ToolResultEnvelope.js';
import { sendToolEnvelopeResponse } from './tool-envelope-response.js';

export interface DashboardOperationContainer {
  get(name: string): unknown;
}

const EMPTY_DIAGNOSTICS: ToolResultDiagnostics = {
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

const DEFAULT_TRUST: ToolResultTrust = {
  source: 'internal',
  sanitized: true,
  containsUntrustedText: false,
  containsSecrets: false,
};

/**
 * Dashboard Operations 直接分派到 DASHBOARD_OPERATION_HANDLERS，
 * 不经过 V2 ToolRouter（dashboard 操作不是 LLM 工具）。
 */
export async function executeDashboardOperation(
  container: DashboardOperationContainer,
  req: Request,
  toolId: string,
  args: Record<string, unknown>
): Promise<ToolResultEnvelope> {
  const callId = randomUUID();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  try {
    const { DASHBOARD_OPERATION_HANDLERS, DASHBOARD_OPERATION_MANIFESTS } = await import(
      '#tools/adapters/DashboardOperations.js'
    );
    const handler = DASHBOARD_OPERATION_HANDLERS[toolId];
    if (!handler) {
      return errorEnvelope(toolId, callId, startedAt, `Unknown dashboard operation: ${toolId}`);
    }

    const manifest = DASHBOARD_OPERATION_MANIFESTS.find((m: { id: string }) => m.id === toolId);
    const executionRequest = {
      manifest: manifest ?? { id: toolId, kind: 'dashboard-operation' },
      args,
      context: {
        services: container,
        projectRoot: '',
        actor: {
          role: req.resolvedRole || 'dashboard',
          user: req.resolvedUser || undefined,
          sessionId: req.headers['x-session-id'] as string | undefined,
        },
        surface: 'dashboard',
      },
      decision: { allowed: true, stage: 'execute' },
    };

    const data = await (handler as (req: unknown) => Promise<unknown>)(executionRequest);
    const durationMs = Date.now() - t0;

    return {
      ok: true,
      toolId,
      callId,
      startedAt,
      durationMs,
      status: 'success',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      structuredContent: data ?? null,
      diagnostics: EMPTY_DIAGNOSTICS,
      trust: DEFAULT_TRUST,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - t0;
    return errorEnvelope(
      toolId,
      callId,
      startedAt,
      err instanceof Error ? err.message : String(err),
      durationMs
    );
  }
}

export function sendDashboardOperationResponse(res: Response, envelope: ToolResultEnvelope) {
  if (!envelope.ok) {
    sendToolEnvelopeResponse(res, envelope);
    return;
  }
  res.json({
    success: true,
    data: envelope.structuredContent ?? envelope,
    toolResult: envelope,
  });
}

function errorEnvelope(
  toolId: string,
  callId: string,
  startedAt: string,
  error: string,
  durationMs = 0
): ToolResultEnvelope {
  return {
    ok: false,
    toolId,
    callId,
    startedAt,
    durationMs,
    status: 'error',
    text: error,
    diagnostics: EMPTY_DIAGNOSTICS,
    trust: DEFAULT_TRUST,
  };
}

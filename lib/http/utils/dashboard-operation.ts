import type { Request, Response } from 'express';
import type { ToolRouterContract } from '#tools/core/ToolContracts.js';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
import { sendToolEnvelopeResponse } from './tool-envelope-response.js';

export interface DashboardOperationContainer {
  get(name: string): unknown;
}

export function executeDashboardOperation(
  container: DashboardOperationContainer,
  req: Request,
  toolId: string,
  args: Record<string, unknown>
): Promise<ToolResultEnvelope> {
  const toolRouter = container.get('toolRouter') as ToolRouterContract;
  return toolRouter.execute({
    toolId,
    args,
    surface: 'dashboard',
    actor: {
      role: req.resolvedRole || 'dashboard',
      user: req.resolvedUser || undefined,
      sessionId: req.headers['x-session-id'] as string | undefined,
    },
    source: { kind: 'dashboard', name: req.originalUrl || req.path },
  });
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

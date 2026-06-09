import type { ToolResultEnvelope, ToolResultStatus } from '@alembic/agent/tools';
import type { Response } from 'express';

export function httpStatusForToolEnvelope(status: ToolResultStatus): number {
  switch (status) {
    case 'blocked':
      return 403;
    case 'needs-confirmation':
      return 409;
    case 'timeout':
      return 504;
    case 'aborted':
      return 499;
    case 'error':
      return 500;
    case 'partial':
      // partial 是 Agent 公开的部分成功分支，HTTP 层用 206 暴露但保留 envelope 原文。
      return 206;
    case 'success':
      return 200;
    default:
      return assertNeverToolResultStatus(status);
  }
}

export function sendToolEnvelopeResponse(res: Response, envelope: ToolResultEnvelope) {
  const httpStatus = httpStatusForToolEnvelope(envelope.status);

  if (envelope.ok) {
    if (httpStatus !== 200) {
      res.status(httpStatus);
    }
    res.json({ success: true, data: envelope });
    return;
  }

  res.status(httpStatus).json({
    success: false,
    error: {
      code: `TOOL_${envelope.status.toUpperCase().replaceAll('-', '_')}`,
      message: envelope.text,
      toolId: envelope.toolId,
      callId: envelope.callId,
      status: envelope.status,
      diagnostics: envelope.diagnostics,
    },
    data: envelope,
  });
}

function assertNeverToolResultStatus(status: never): never {
  throw new Error(`Unhandled tool result status: ${String(status)}`);
}

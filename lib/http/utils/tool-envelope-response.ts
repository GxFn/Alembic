import type { Response } from 'express';
import type { ToolResultEnvelope, ToolResultStatus } from '../../agent/core/ToolResultEnvelope.js';

export function httpStatusForToolEnvelope(status: ToolResultStatus) {
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
    case 'success':
      return 200;
  }
}

export function sendToolEnvelopeResponse(res: Response, envelope: ToolResultEnvelope) {
  if (envelope.ok) {
    res.json({ success: true, data: envelope });
    return;
  }

  res.status(httpStatusForToolEnvelope(envelope.status)).json({
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

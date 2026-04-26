import type { ToolResultEnvelope } from './ToolResultEnvelope.js';

export function presentToolResult(envelope: ToolResultEnvelope) {
  return envelope.text;
}

export function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
  return (
    !!value &&
    typeof value === 'object' &&
    'toolId' in value &&
    'callId' in value &&
    'status' in value &&
    'text' in value &&
    'trust' in value
  );
}

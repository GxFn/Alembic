import type { CapabilityKind, ToolCapabilityManifest } from '../tools/CapabilityManifest.js';
import type {
  ToolActor,
  ToolCallContext,
  ToolCallSource,
  ToolRuntimeCallContext,
  ToolSurface,
} from './ToolCallContext.js';
import type { ToolDecision, ToolExecutionPreview } from './ToolDecision.js';
import type { ToolResultEnvelope } from './ToolResultEnvelope.js';

export interface ToolCallRequest {
  toolId: string;
  args: Record<string, unknown>;
  surface: ToolSurface;
  actor: ToolActor;
  source: ToolCallSource;
  parentCallId?: string;
  abortSignal?: AbortSignal | null;
  runtime?: ToolRuntimeCallContext;
  governance?: {
    gatewayAction?: string | null;
    gatewayResource?: string;
    gatewayData?: Record<string, unknown>;
  };
}

export interface ToolExecutionRequest {
  manifest: ToolCapabilityManifest;
  args: Record<string, unknown>;
  context: ToolCallContext;
  decision: ToolDecision;
}

export interface ToolExecutionPreviewRequest {
  manifest: ToolCapabilityManifest;
  args: Record<string, unknown>;
  projectRoot: string;
}

export interface ToolExecutionAdapter {
  readonly kind: CapabilityKind;
  preview?(request: ToolExecutionPreviewRequest): ToolExecutionPreview | null;
  execute(request: ToolExecutionRequest): Promise<ToolResultEnvelope>;
}

export interface ToolRouterContract {
  execute(request: ToolCallRequest): Promise<ToolResultEnvelope>;
  executeChildCall(
    request: ToolCallRequest & { parentCallId: string }
  ): Promise<ToolResultEnvelope>;
  explain(request: ToolCallRequest): Promise<ToolDecision>;
}

export type ToolResultStatus =
  | 'success'
  | 'error'
  | 'blocked'
  | 'aborted'
  | 'timeout'
  | 'needs-confirmation';

export interface ToolResultTrust {
  source: 'internal' | 'terminal' | 'mcp' | 'skill' | 'macos' | 'user';
  sanitized: boolean;
  containsUntrustedText: boolean;
  containsSecrets: boolean;
}

export interface ToolArtifactRef {
  id: string;
  kind: 'file' | 'log' | 'stdout' | 'stderr' | 'image' | 'resource';
  uri: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface ToolResourceRef {
  uri: string;
  title?: string;
  mimeType?: string;
}

export interface ToolResultCacheInfo {
  hit: boolean;
  policy: 'none' | 'session' | 'scope' | 'persistent';
}

export interface ToolResultDiagnostics {
  degraded: boolean;
  fallbackUsed: boolean;
  warnings: Array<{
    code: string;
    message: string;
    stage?: string;
    tool?: string;
  }>;
  timedOutStages: string[];
  blockedTools: Array<{ tool: string; reason: string }>;
  truncatedToolCalls: number;
  emptyResponses: number;
  aiErrorCount: number;
  gateFailures: Array<{ stage: string; action: string; reason?: string }>;
  toolCalls?: Array<{
    tool: string;
    callId: string;
    parentCallId?: string;
    status: string;
    ok: boolean;
    surface?: string;
    source?: string;
    kind?: string;
    startedAt: string;
    durationMs: number;
  }>;
}

export interface ToolResultEnvelope<T = unknown> {
  ok: boolean;
  toolId: string;
  callId: string;
  parentCallId?: string;
  startedAt: string;
  durationMs: number;
  status: ToolResultStatus;
  text: string;
  structuredContent?: T;
  artifacts?: ToolArtifactRef[];
  resources?: ToolResourceRef[];
  cache?: ToolResultCacheInfo;
  diagnostics: ToolResultDiagnostics;
  trust: ToolResultTrust;
  nextActionHint?: string;
}

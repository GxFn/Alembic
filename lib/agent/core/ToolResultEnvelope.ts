import type { AgentDiagnostics } from '../AgentRuntimeTypes.js';

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
  diagnostics: AgentDiagnostics;
  trust: ToolResultTrust;
  nextActionHint?: string;
}

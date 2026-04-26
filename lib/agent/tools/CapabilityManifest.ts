export type CapabilityKind =
  | 'internal-tool'
  | 'dashboard-operation'
  | 'workflow'
  | 'terminal-profile'
  | 'skill'
  | 'mcp-tool'
  | 'macos-adapter';

export type CapabilityLifecycle = 'experimental' | 'active' | 'deprecated' | 'disabled';

export type CapabilitySurface = 'runtime' | 'http' | 'mcp' | 'dashboard' | 'skill' | 'internal';

export type CapabilityPolicyProfile = 'read' | 'analysis' | 'write' | 'system' | 'admin';

export type CapabilityAuditLevel = 'none' | 'checkOnly' | 'full';

export type CapabilityAbortMode = 'none' | 'preStart' | 'cooperative' | 'hardTimeout';

export interface ToolExample {
  title: string;
  input: Record<string, unknown>;
  output?: unknown;
}

export interface ToolFailureMode {
  code: string;
  description: string;
  retryable?: boolean;
}

export interface ToolRiskProfile {
  sideEffect: boolean;
  dataAccess: 'none' | 'project' | 'workspace' | 'user-home' | 'network' | 'secrets';
  writeScope: 'none' | 'project' | 'data-root' | 'workspace' | 'system';
  network: 'none' | 'allowlisted' | 'open';
  credentialAccess: 'none' | 'masked' | 'scoped-token' | 'raw-secret';
  requiresHumanConfirmation: 'never' | 'on-risk' | 'always';
  owaspTags: Array<
    | 'prompt-injection'
    | 'sensitive-info'
    | 'supply-chain'
    | 'excessive-agency'
    | 'unbounded-consumption'
  >;
}

export interface ToolExecutionProfile {
  adapter: 'internal' | 'dashboard' | 'terminal' | 'skill' | 'mcp' | 'macos' | 'workflow';
  timeoutMs: number;
  maxOutputBytes: number;
  abortMode: CapabilityAbortMode;
  cachePolicy: 'none' | 'session' | 'scope' | 'persistent';
  concurrency: 'single' | 'parallel-safe' | 'exclusive';
  artifactMode: 'inline' | 'file-ref' | 'resource-link';
}

export interface ToolGovernanceProfile {
  gatewayAction?: string;
  gatewayResource?: string;
  auditLevel: CapabilityAuditLevel;
  policyProfile: CapabilityPolicyProfile;
  approvalPolicy: 'auto' | 'explain-then-run' | 'confirm-once' | 'confirm-every-time';
  allowedRoles: string[];
  allowInComposer: boolean;
  allowInRemoteMcp: boolean;
  allowInNonInteractive: boolean;
}

export interface ToolEvalProfile {
  required: boolean;
  cases: string[];
}

export interface ToolExternalTrustProfile {
  source: 'mcp-server' | 'skill' | 'macos';
  serverId?: string;
  trusted: boolean;
  reason: string;
  outputContainsUntrustedText: boolean;
  allowlisted?: boolean;
  registration?: {
    source: 'bundled' | 'workspace-config' | 'user-config' | 'runtime' | 'unknown';
    configPath?: string;
    declaredBy?: string;
  };
}

export interface ToolCapabilityManifest {
  id: string;
  title: string;
  kind: CapabilityKind;
  description: string;
  owner: string;
  lifecycle: CapabilityLifecycle;
  surfaces: CapabilitySurface[];
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  examples?: ToolExample[];
  failureModes?: ToolFailureMode[];
  risk: ToolRiskProfile;
  execution: ToolExecutionProfile;
  governance: ToolGovernanceProfile;
  externalTrust?: ToolExternalTrustProfile;
  evals: ToolEvalProfile;
}

export interface ToolSchemaProjection {
  [key: string]: unknown;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

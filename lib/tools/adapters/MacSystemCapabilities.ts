import type { ToolCapabilityManifest } from '@alembic/agent';

const MAC_READ_RISK = {
  sideEffect: false,
  dataAccess: 'none',
  writeScope: 'none',
  network: 'none',
  credentialAccess: 'none',
  requiresHumanConfirmation: 'never',
  owaspTags: [],
} satisfies ToolCapabilityManifest['risk'];

const MAC_GOVERNANCE = {
  auditLevel: 'full',
  policyProfile: 'system',
  approvalPolicy: 'auto',
  // Mainline safety is operation-specific; this field stays empty for the Agent contract.
  allowedRoles: [],
  allowInComposer: false,
  allowInRemoteMcp: false,
  allowInNonInteractive: true,
} satisfies ToolCapabilityManifest['governance'];

const MAC_EXECUTION = {
  adapter: 'macos',
  timeoutMs: 10_000,
  maxOutputBytes: 64_000,
  abortMode: 'preStart',
  cachePolicy: 'none',
  concurrency: 'single',
  artifactMode: 'inline',
} satisfies ToolCapabilityManifest['execution'];

export const MAC_SYSTEM_INFO_CAPABILITY: ToolCapabilityManifest = {
  id: 'mac_system_info',
  title: 'macOS System Info',
  kind: 'macos-adapter',
  description: 'Report basic macOS/platform information without requesting TCC permissions.',
  owner: 'agent-platform',
  lifecycle: 'experimental',
  surfaces: ['runtime'],
  inputSchema: { type: 'object', properties: {}, required: [] },
  risk: MAC_READ_RISK,
  execution: MAC_EXECUTION,
  governance: MAC_GOVERNANCE,
  externalTrust: {
    source: 'macos',
    trusted: true,
    reason: 'Local platform information from the current process.',
    outputContainsUntrustedText: false,
  },
  evals: { required: false, cases: [] },
};

export const MAC_PERMISSION_STATUS_CAPABILITY: ToolCapabilityManifest = {
  id: 'mac_permission_status',
  title: 'macOS Permission Status',
  kind: 'macos-adapter',
  description:
    'Report known macOS permission readiness without prompting or bypassing TCC permissions.',
  owner: 'agent-platform',
  lifecycle: 'experimental',
  surfaces: ['runtime'],
  inputSchema: {
    type: 'object',
    properties: {
      permission: {
        type: 'string',
        enum: ['accessibility', 'automation', 'all'],
      },
    },
    required: [],
  },
  risk: MAC_READ_RISK,
  execution: MAC_EXECUTION,
  governance: MAC_GOVERNANCE,
  externalTrust: MAC_SYSTEM_INFO_CAPABILITY.externalTrust,
  evals: { required: false, cases: [] },
};

export const MAC_SYSTEM_CAPABILITY_MANIFESTS = [
  MAC_SYSTEM_INFO_CAPABILITY,
  MAC_PERMISSION_STATUS_CAPABILITY,
];

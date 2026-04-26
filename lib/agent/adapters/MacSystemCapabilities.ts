import type { ToolCapabilityManifest } from '../tools/CapabilityManifest.js';

const MAC_READ_RISK = {
  sideEffect: false,
  dataAccess: 'none',
  writeScope: 'none',
  network: 'none',
  credentialAccess: 'none',
  requiresHumanConfirmation: 'never',
  owaspTags: [],
} satisfies ToolCapabilityManifest['risk'];

const MAC_SENSITIVE_RISK = {
  sideEffect: true,
  dataAccess: 'workspace',
  writeScope: 'project',
  network: 'none',
  credentialAccess: 'none',
  requiresHumanConfirmation: 'on-risk',
  owaspTags: ['sensitive-info'],
} satisfies ToolCapabilityManifest['risk'];

const MAC_GOVERNANCE = {
  auditLevel: 'full',
  policyProfile: 'system',
  approvalPolicy: 'auto',
  allowedRoles: ['owner', 'admin', 'developer'],
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
        enum: ['screen-recording', 'accessibility', 'automation', 'all'],
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

export const MAC_WINDOW_LIST_CAPABILITY: ToolCapabilityManifest = {
  id: 'mac_window_list',
  title: 'macOS Window List',
  kind: 'macos-adapter',
  description:
    'List capturable macOS windows through ScreenCaptureKit. Window titles are sensitive and returned only as an artifact reference.',
  owner: 'agent-platform',
  lifecycle: 'experimental',
  surfaces: ['runtime'],
  inputSchema: { type: 'object', properties: {}, required: [] },
  risk: MAC_SENSITIVE_RISK,
  execution: { ...MAC_EXECUTION, artifactMode: 'file-ref' },
  governance: { ...MAC_GOVERNANCE, approvalPolicy: 'explain-then-run' },
  externalTrust: {
    source: 'macos',
    trusted: true,
    reason: 'Local ScreenCaptureKit window metadata.',
    outputContainsUntrustedText: true,
  },
  evals: { required: false, cases: [] },
};

export const MAC_SCREENSHOT_CAPABILITY: ToolCapabilityManifest = {
  id: 'mac_screenshot',
  title: 'macOS Screenshot',
  kind: 'macos-adapter',
  description:
    'Capture a macOS screenshot through ScreenCaptureKit and return it as a sensitive image artifact.',
  owner: 'agent-platform',
  lifecycle: 'experimental',
  surfaces: ['runtime'],
  inputSchema: {
    type: 'object',
    properties: {
      windowTitle: {
        type: 'string',
        description: 'Optional app/window title substring to capture.',
      },
      format: { type: 'string', enum: ['png', 'jpeg'] },
      scale: { type: 'number', description: 'Optional scale factor, capped by adapter policy.' },
    },
    required: [],
  },
  risk: MAC_SENSITIVE_RISK,
  execution: { ...MAC_EXECUTION, timeoutMs: 20_000, artifactMode: 'file-ref' },
  governance: { ...MAC_GOVERNANCE, approvalPolicy: 'explain-then-run' },
  externalTrust: {
    source: 'macos',
    trusted: true,
    reason: 'Local ScreenCaptureKit screenshot artifact.',
    outputContainsUntrustedText: false,
  },
  evals: { required: false, cases: [] },
};

export const MAC_SYSTEM_CAPABILITY_MANIFESTS = [
  MAC_SYSTEM_INFO_CAPABILITY,
  MAC_PERMISSION_STATUS_CAPABILITY,
  MAC_WINDOW_LIST_CAPABILITY,
  MAC_SCREENSHOT_CAPABILITY,
];

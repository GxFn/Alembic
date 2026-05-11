import type { ToolCapabilityManifest } from '#tools/catalog/CapabilityManifest.js';

export const TERMINAL_KIND = 'terminal-profile' as const;
export const TERMINAL_OWNER = 'agent-platform';
export const TERMINAL_RUNTIME_SURFACES: ToolCapabilityManifest['surfaces'] = ['runtime'];
export const TERMINAL_EVALS = { required: true, cases: [] };

export function terminalSideEffectRisk(
  requiresHumanConfirmation: ToolCapabilityManifest['risk']['requiresHumanConfirmation']
): ToolCapabilityManifest['risk'] {
  return {
    sideEffect: true,
    dataAccess: 'workspace',
    writeScope: 'system',
    network: 'allowlisted',
    credentialAccess: 'none',
    requiresHumanConfirmation,
    owaspTags: ['supply-chain', 'excessive-agency', 'unbounded-consumption'],
  };
}

export function terminalNoDataRisk(sideEffect: boolean): ToolCapabilityManifest['risk'] {
  return {
    sideEffect,
    dataAccess: 'none',
    writeScope: 'none',
    network: 'none',
    credentialAccess: 'none',
    requiresHumanConfirmation: 'never',
    owaspTags: ['excessive-agency'],
  };
}

export function terminalExecution(
  options: Partial<ToolCapabilityManifest['execution']> = {}
): ToolCapabilityManifest['execution'] {
  return {
    adapter: 'terminal',
    timeoutMs: 30_000,
    maxOutputBytes: 16_000,
    abortMode: 'hardTimeout',
    cachePolicy: 'none',
    concurrency: 'single',
    artifactMode: 'file-ref',
    ...options,
  };
}

export function terminalGovernance(
  action: string,
  resource: string,
  options: Partial<ToolCapabilityManifest['governance']> = {}
): ToolCapabilityManifest['governance'] {
  return {
    gatewayAction: action,
    gatewayResource: resource,
    auditLevel: 'full',
    policyProfile: 'system',
    approvalPolicy: 'confirm-every-time',
    allowedRoles: ['owner', 'admin', 'developer'],
    allowInComposer: false,
    allowInRemoteMcp: false,
    allowInNonInteractive: false,
    ...options,
  };
}

export const COMMON_TERMINAL_FIELDS = {
  env: {
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Command-scoped environment variables. Values are passed to the child process but are not included in audit records.',
  },
  cwd: {
    type: 'string',
    description:
      'Working directory relative to project root, or an absolute path inside project root.',
  },
  timeoutMs: {
    type: 'number',
    description: 'Requested timeout in milliseconds, capped by the manifest execution timeout.',
  },
  network: {
    type: 'string',
    enum: ['none', 'allowlisted', 'open'],
    description: 'Declared network intent for policy and audit.',
  },
  filesystem: {
    type: 'string',
    enum: ['read-only', 'project-write', 'workspace-write'],
    description: 'Declared filesystem intent for policy and audit.',
  },
};

export const SHELL_SELECTOR_FIELD = {
  type: 'string',
  enum: ['sh', '/bin/sh'],
  description: 'Optional shell selector. Only POSIX sh via /bin/sh is accepted.',
};

import type { ToolCapabilityManifest } from '../tools/CapabilityManifest.js';

export const TERMINAL_RUN_CAPABILITY: ToolCapabilityManifest = {
  id: 'terminal_run',
  title: 'Terminal Run',
  kind: 'terminal-profile',
  description:
    'Run one structured terminal command with explicit executable, arguments, cwd, timeout, network, and filesystem intent.',
  owner: 'agent-platform',
  lifecycle: 'experimental',
  surfaces: ['runtime'],
  inputSchema: {
    type: 'object',
    properties: {
      bin: {
        type: 'string',
        description: 'Executable name or absolute executable path. Shell syntax is not accepted.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Argument vector passed directly to execFile.',
      },
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
      interactive: {
        type: 'string',
        enum: ['never', 'allowed'],
        description:
          'Declared interactivity intent. Defaults to "never"; interactive commands are blocked in terminal_run v1.',
      },
      session: {
        type: 'object',
        description:
          'Terminal session declaration. Structured persistent execFile sessions are supported; shell and PTY sessions are not accepted.',
        properties: {
          mode: {
            type: 'string',
            enum: ['ephemeral', 'persistent'],
            description:
              'Session mode. "persistent" reuses terminal session metadata, not a shell process.',
          },
          id: {
            type: 'string',
            description:
              'Optional stable session identifier reserved for future persistent terminal support.',
          },
          envPersistence: {
            type: 'string',
            enum: ['none', 'explicit'],
            description:
              'Environment persistence mode. Defaults to "none"; "explicit" persists only env keys declared on terminal_run calls in persistent sessions.',
          },
        },
      },
    },
    required: ['bin'],
  },
  risk: {
    sideEffect: true,
    dataAccess: 'workspace',
    writeScope: 'system',
    network: 'allowlisted',
    credentialAccess: 'none',
    requiresHumanConfirmation: 'on-risk',
    owaspTags: ['supply-chain', 'excessive-agency', 'unbounded-consumption'],
  },
  execution: {
    adapter: 'terminal',
    timeoutMs: 30_000,
    maxOutputBytes: 16_000,
    abortMode: 'hardTimeout',
    cachePolicy: 'none',
    concurrency: 'single',
    artifactMode: 'file-ref',
  },
  governance: {
    gatewayAction: 'terminal:run',
    gatewayResource: 'terminal',
    auditLevel: 'full',
    policyProfile: 'system',
    approvalPolicy: 'explain-then-run',
    allowedRoles: ['owner', 'admin', 'developer'],
    allowInComposer: false,
    allowInRemoteMcp: false,
    allowInNonInteractive: false,
  },
  evals: {
    required: true,
    cases: [],
  },
};

export const TERMINAL_SESSION_CLOSE_CAPABILITY: ToolCapabilityManifest = {
  id: 'terminal_session_close',
  title: 'Terminal Session Close',
  kind: 'terminal-profile',
  description: 'Close a persistent terminal session metadata record by id.',
  owner: 'agent-platform',
  lifecycle: 'experimental',
  surfaces: ['runtime'],
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Persistent terminal session id to close.',
      },
    },
    required: ['id'],
  },
  risk: {
    sideEffect: true,
    dataAccess: 'none',
    writeScope: 'none',
    network: 'none',
    credentialAccess: 'none',
    requiresHumanConfirmation: 'never',
    owaspTags: ['excessive-agency'],
  },
  execution: {
    adapter: 'terminal',
    timeoutMs: 5_000,
    maxOutputBytes: 4_000,
    abortMode: 'preStart',
    cachePolicy: 'none',
    concurrency: 'single',
    artifactMode: 'inline',
  },
  governance: {
    gatewayAction: 'terminal:session:close',
    gatewayResource: 'terminal-session',
    auditLevel: 'full',
    policyProfile: 'system',
    approvalPolicy: 'auto',
    allowedRoles: ['owner', 'admin', 'developer'],
    allowInComposer: false,
    allowInRemoteMcp: false,
    allowInNonInteractive: true,
  },
  evals: {
    required: true,
    cases: [],
  },
};

export const TERMINAL_SESSION_CLEANUP_CAPABILITY: ToolCapabilityManifest = {
  id: 'terminal_session_cleanup',
  title: 'Terminal Session Cleanup',
  kind: 'terminal-profile',
  description: 'Remove closed or expired persistent terminal session metadata records.',
  owner: 'agent-platform',
  lifecycle: 'experimental',
  surfaces: ['runtime'],
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  risk: {
    sideEffect: true,
    dataAccess: 'none',
    writeScope: 'none',
    network: 'none',
    credentialAccess: 'none',
    requiresHumanConfirmation: 'never',
    owaspTags: ['excessive-agency'],
  },
  execution: {
    adapter: 'terminal',
    timeoutMs: 5_000,
    maxOutputBytes: 4_000,
    abortMode: 'preStart',
    cachePolicy: 'none',
    concurrency: 'single',
    artifactMode: 'inline',
  },
  governance: {
    gatewayAction: 'terminal:session:cleanup',
    gatewayResource: 'terminal-session',
    auditLevel: 'full',
    policyProfile: 'system',
    approvalPolicy: 'auto',
    allowedRoles: ['owner', 'admin', 'developer'],
    allowInComposer: false,
    allowInRemoteMcp: false,
    allowInNonInteractive: true,
  },
  evals: {
    required: true,
    cases: [],
  },
};

export const TERMINAL_CAPABILITY_MANIFESTS = [
  TERMINAL_RUN_CAPABILITY,
  TERMINAL_SESSION_CLOSE_CAPABILITY,
  TERMINAL_SESSION_CLEANUP_CAPABILITY,
];

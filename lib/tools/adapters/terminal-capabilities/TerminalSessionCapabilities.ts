import type { ToolCapabilityManifest } from '#tools/catalog/CapabilityManifest.js';
import {
  TERMINAL_EVALS,
  TERMINAL_KIND,
  TERMINAL_OWNER,
  TERMINAL_RUNTIME_SURFACES,
  terminalExecution,
  terminalGovernance,
  terminalNoDataRisk,
} from './TerminalCapabilityHelpers.js';

export const TERMINAL_SESSION_CLOSE_CAPABILITY: ToolCapabilityManifest = {
  id: 'terminal_session_close',
  title: 'Terminal Session Close',
  kind: TERMINAL_KIND,
  description: 'Close a persistent terminal session metadata record by id.',
  owner: TERMINAL_OWNER,
  lifecycle: 'experimental',
  surfaces: TERMINAL_RUNTIME_SURFACES,
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
  risk: terminalNoDataRisk(true),
  execution: terminalExecution({
    timeoutMs: 5_000,
    maxOutputBytes: 4_000,
    abortMode: 'preStart',
    artifactMode: 'inline',
  }),
  governance: terminalGovernance('terminal:session:close', 'terminal-session', {
    approvalPolicy: 'auto',
    allowInNonInteractive: true,
  }),
  evals: TERMINAL_EVALS,
};

export const TERMINAL_SESSION_STATUS_CAPABILITY: ToolCapabilityManifest = {
  id: 'terminal_session_status',
  title: 'Terminal Session Status',
  kind: TERMINAL_KIND,
  description:
    'Inspect one persistent terminal session metadata record, or list all session records.',
  owner: TERMINAL_OWNER,
  lifecycle: 'experimental',
  surfaces: TERMINAL_RUNTIME_SURFACES,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Optional persistent terminal session id. Omit to list all sessions.',
      },
    },
    required: [],
  },
  risk: terminalNoDataRisk(false),
  execution: terminalExecution({
    timeoutMs: 5_000,
    maxOutputBytes: 8_000,
    abortMode: 'preStart',
    concurrency: 'parallel-safe',
    artifactMode: 'inline',
  }),
  governance: terminalGovernance('terminal:session:status', 'terminal-session', {
    auditLevel: 'checkOnly',
    policyProfile: 'read',
    approvalPolicy: 'auto',
    allowInNonInteractive: true,
  }),
  evals: TERMINAL_EVALS,
};

export const TERMINAL_SESSION_CLEANUP_CAPABILITY: ToolCapabilityManifest = {
  id: 'terminal_session_cleanup',
  title: 'Terminal Session Cleanup',
  kind: TERMINAL_KIND,
  description: 'Remove closed or expired persistent terminal session metadata records.',
  owner: TERMINAL_OWNER,
  lifecycle: 'experimental',
  surfaces: TERMINAL_RUNTIME_SURFACES,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  risk: terminalNoDataRisk(true),
  execution: terminalExecution({
    timeoutMs: 5_000,
    maxOutputBytes: 4_000,
    abortMode: 'preStart',
    artifactMode: 'inline',
  }),
  governance: terminalGovernance('terminal:session:cleanup', 'terminal-session', {
    approvalPolicy: 'auto',
    allowInNonInteractive: true,
  }),
  evals: TERMINAL_EVALS,
};

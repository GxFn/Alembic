import type { ToolCapabilityManifest } from '#tools/catalog/CapabilityManifest.js';
import {
  COMMON_TERMINAL_FIELDS,
  SHELL_SELECTOR_FIELD,
  TERMINAL_EVALS,
  TERMINAL_KIND,
  TERMINAL_OWNER,
  TERMINAL_RUNTIME_SURFACES,
  terminalExecution,
  terminalGovernance,
  terminalSideEffectRisk,
} from './TerminalCapabilityHelpers.js';

export const TERMINAL_RUN_CAPABILITY: ToolCapabilityManifest = {
  id: 'terminal_run',
  title: 'Terminal Run',
  kind: TERMINAL_KIND,
  description:
    'Run one structured terminal command with explicit executable, arguments, cwd, timeout, network, and filesystem intent.',
  owner: TERMINAL_OWNER,
  lifecycle: 'experimental',
  surfaces: TERMINAL_RUNTIME_SURFACES,
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
      ...COMMON_TERMINAL_FIELDS,
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
  risk: terminalSideEffectRisk('on-risk'),
  execution: terminalExecution(),
  governance: terminalGovernance('terminal:run', 'terminal', {
    approvalPolicy: 'explain-then-run',
  }),
  evals: TERMINAL_EVALS,
};

export const TERMINAL_SCRIPT_CAPABILITY: ToolCapabilityManifest = {
  id: 'terminal_script',
  title: 'Terminal Script',
  kind: TERMINAL_KIND,
  description:
    'Run one non-interactive /bin/sh script after materializing the script as an execution artifact.',
  owner: TERMINAL_OWNER,
  lifecycle: 'experimental',
  surfaces: TERMINAL_RUNTIME_SURFACES,
  inputSchema: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description:
          'Shell script content. It is written to an artifact and executed as /bin/sh <artifact>; PTY and interactive input are not available.',
      },
      shell: SHELL_SELECTOR_FIELD,
      ...COMMON_TERMINAL_FIELDS,
      interactive: {
        type: 'string',
        enum: ['never', 'allowed'],
        description:
          'Declared interactivity intent. Defaults to "never"; interactive scripts are blocked.',
      },
    },
    required: ['script'],
  },
  risk: terminalSideEffectRisk('always'),
  execution: terminalExecution(),
  governance: terminalGovernance('terminal:script', 'terminal-script'),
  evals: TERMINAL_EVALS,
};

export const TERMINAL_SHELL_CAPABILITY: ToolCapabilityManifest = {
  id: 'terminal_shell',
  title: 'Terminal Shell',
  kind: TERMINAL_KIND,
  description:
    'Run one governed non-interactive /bin/sh -lc command string. Use terminal_run for structured execFile calls when possible.',
  owner: TERMINAL_OWNER,
  lifecycle: 'experimental',
  surfaces: TERMINAL_RUNTIME_SURFACES,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'Shell command string passed to /bin/sh -lc after governance checks. Prefer terminal_run for simple executable + args.',
      },
      shell: SHELL_SELECTOR_FIELD,
      ...COMMON_TERMINAL_FIELDS,
      interactive: {
        type: 'string',
        enum: ['never', 'allowed'],
        description:
          'Declared interactivity intent. terminal_shell requires "never"; use terminal_pty for PTY observation.',
      },
    },
    required: ['command'],
  },
  risk: terminalSideEffectRisk('always'),
  execution: terminalExecution(),
  governance: terminalGovernance('terminal:shell', 'terminal-shell'),
  evals: TERMINAL_EVALS,
};

export const TERMINAL_PTY_CAPABILITY: ToolCapabilityManifest = {
  id: 'terminal_pty',
  title: 'Terminal PTY',
  kind: TERMINAL_KIND,
  description:
    'Run one governed shell command under a Python pty.fork wrapper and return the observed transcript. Optional stdin is bounded and sent once.',
  owner: TERMINAL_OWNER,
  lifecycle: 'experimental',
  surfaces: TERMINAL_RUNTIME_SURFACES,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'Shell command string observed through a PTY transcript. The command must complete after optional bounded stdin is sent.',
      },
      stdin: {
        type: 'string',
        description:
          'Optional bounded stdin payload written once to the PTY and then closed. Values are never included in previews or audit records.',
      },
      shell: SHELL_SELECTOR_FIELD,
      rows: {
        type: 'integer',
        description: 'PTY row count for the command environment. Defaults to 24.',
      },
      cols: {
        type: 'integer',
        description: 'PTY column count for the command environment. Defaults to 80.',
      },
      ...COMMON_TERMINAL_FIELDS,
      interactive: {
        type: 'string',
        enum: ['never', 'allowed'],
        description:
          'Declared interactivity intent. Defaults to "allowed" for PTY observation; only bounded one-shot stdin is supported.',
      },
    },
    required: ['command'],
  },
  risk: terminalSideEffectRisk('always'),
  execution: terminalExecution(),
  governance: terminalGovernance('terminal:pty', 'terminal-pty'),
  evals: TERMINAL_EVALS,
};

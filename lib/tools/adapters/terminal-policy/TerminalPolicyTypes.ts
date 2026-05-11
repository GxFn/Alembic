import type { TerminalSessionPlan } from '#tools/adapters/TerminalSession.js';

export type TerminalNetworkIntent = 'none' | 'allowlisted' | 'open';
export type TerminalFilesystemIntent = 'read-only' | 'project-write' | 'workspace-write';
export type TerminalInteractivityIntent = 'never' | 'allowed';

export interface TerminalCommandPolicyInput {
  bin: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  projectRoot: string;
  timeoutMs: number;
  network: TerminalNetworkIntent;
  filesystem: TerminalFilesystemIntent;
  interactive: TerminalInteractivityIntent;
  session: TerminalSessionPlan;
}

export interface TerminalCommandPolicyDecision {
  allowed: boolean;
  reason?: string;
  matchedRule?: string;
  risk: 'low' | 'medium' | 'high';
  preview: {
    command: string;
    cwd: string;
    env: {
      keys: string[];
      persistence: TerminalSessionPlan['envPersistence'];
    };
    network: TerminalNetworkIntent;
    filesystem: TerminalFilesystemIntent;
    interactive: TerminalInteractivityIntent;
    timeoutMs: number;
    session: TerminalSessionPlan;
  };
}

export interface TerminalScriptPolicyInput {
  script: string;
  scriptHash: string;
  lineCount: number;
  byteLength: number;
  shell: '/bin/sh';
  env: Record<string, string>;
  cwd: string;
  projectRoot: string;
  timeoutMs: number;
  network: TerminalNetworkIntent;
  filesystem: TerminalFilesystemIntent;
  interactive: TerminalInteractivityIntent;
}

export interface TerminalScriptPolicyDecision {
  allowed: boolean;
  reason?: string;
  matchedRule?: string;
  risk: 'low' | 'medium' | 'high';
  preview: {
    shell: '/bin/sh';
    scriptHash: string;
    lineCount: number;
    byteLength: number;
    cwd: string;
    env: {
      keys: string[];
      persistence: 'none';
    };
    network: TerminalNetworkIntent;
    filesystem: TerminalFilesystemIntent;
    interactive: TerminalInteractivityIntent;
    timeoutMs: number;
  };
}

export interface TerminalShellPolicyInput {
  command: string;
  commandHash: string;
  lineCount: number;
  byteLength: number;
  shell: '/bin/sh';
  env: Record<string, string>;
  cwd: string;
  projectRoot: string;
  timeoutMs: number;
  network: TerminalNetworkIntent;
  filesystem: TerminalFilesystemIntent;
  interactive: TerminalInteractivityIntent;
}

export interface TerminalShellPolicyDecision {
  allowed: boolean;
  reason?: string;
  matchedRule?: string;
  risk: 'low' | 'medium' | 'high';
  preview: {
    shell: '/bin/sh';
    commandHash: string;
    lineCount: number;
    byteLength: number;
    cwd: string;
    env: {
      keys: string[];
      persistence: 'none';
    };
    network: TerminalNetworkIntent;
    filesystem: TerminalFilesystemIntent;
    interactive: TerminalInteractivityIntent;
    timeoutMs: number;
  };
}

export interface TerminalPtyPolicyInput extends TerminalShellPolicyInput {
  stdin: string;
  pty: {
    rows: number;
    cols: number;
    stdin: 'disabled' | 'provided';
    stdinHash?: string;
    stdinLineCount?: number;
    stdinByteLength?: number;
    wrapper: 'python-pty';
  };
}

export interface TerminalPtyPolicyDecision {
  allowed: boolean;
  reason?: string;
  matchedRule?: string;
  risk: 'low' | 'medium' | 'high';
  preview: TerminalShellPolicyDecision['preview'] & {
    pty: TerminalPtyPolicyInput['pty'];
  };
}

import { buildTerminalSessionPlan } from '#tools/adapters/TerminalSession.js';
import {
  basename,
  containsShellMeta,
  DENIED_BINS,
  envKeys,
  formatCommandPreview,
  isFilesystemMode,
  isInteractivityMode,
  isNetworkMode,
  isRecursiveForceRemove,
  isStringArray,
  normalizeEnv,
  normalizeTimeout,
  resolveCwd,
  SHELL_BINS,
  sensitiveEnvKeys,
} from './TerminalPolicyShared.js';
import type {
  TerminalCommandPolicyDecision,
  TerminalCommandPolicyInput,
} from './TerminalPolicyTypes.js';

export function buildTerminalCommandPolicyInput(
  args: Record<string, unknown>,
  projectRoot: string,
  manifestTimeoutMs = 30_000
): { ok: true; input: TerminalCommandPolicyInput } | { ok: false; error: string } {
  if (typeof args.bin !== 'string' || args.bin.trim().length === 0) {
    return { ok: false, error: 'terminal_run requires a non-empty string "bin"' };
  }
  if (containsShellMeta(args.bin)) {
    return { ok: false, error: 'terminal_run bin must be a single executable, not shell syntax' };
  }
  if (args.args !== undefined && !isStringArray(args.args)) {
    return { ok: false, error: 'terminal_run args must be an array of strings' };
  }
  const env = normalizeEnv(args.env);
  if (!env.ok) {
    return { ok: false, error: env.error };
  }

  const cwd = resolveCwd(typeof args.cwd === 'string' ? args.cwd : undefined, projectRoot);
  if (!cwd.ok) {
    return { ok: false, error: cwd.error };
  }
  const session = buildTerminalSessionPlan(args.session);
  if (!session.ok) {
    return { ok: false, error: session.error };
  }
  if (args.interactive !== undefined && !isInteractivityMode(args.interactive)) {
    return { ok: false, error: 'terminal_run interactive must be "never" or "allowed"' };
  }

  return {
    ok: true,
    input: {
      bin: args.bin.trim(),
      args: Array.isArray(args.args) ? args.args : [],
      env: env.env,
      cwd: cwd.path,
      projectRoot,
      timeoutMs: normalizeTimeout(
        typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        manifestTimeoutMs
      ),
      network: isNetworkMode(args.network) ? args.network : 'none',
      filesystem: isFilesystemMode(args.filesystem) ? args.filesystem : 'read-only',
      interactive: isInteractivityMode(args.interactive) ? args.interactive : 'never',
      session: session.session,
    },
  };
}

export function evaluateTerminalCommandPolicy(
  input: TerminalCommandPolicyInput
): TerminalCommandPolicyDecision {
  const preview = {
    command: formatCommandPreview(input.bin, input.args),
    cwd: input.cwd,
    env: {
      keys: envKeys(input.env),
      persistence: input.session.envPersistence,
    },
    network: input.network,
    filesystem: input.filesystem,
    interactive: input.interactive,
    timeoutMs: input.timeoutMs,
    session: input.session,
  };
  const binName = basename(input.bin);
  const risk = inferRisk(input);

  if (DENIED_BINS.has(binName)) {
    return deny(`Executable "${binName}" is blocked`, 'denied-bin', risk, preview);
  }
  if (SHELL_BINS.has(binName)) {
    return deny(
      `Executable "${binName}" would reintroduce shell execution`,
      'shell-bin',
      risk,
      preview
    );
  }
  if (binName === 'rm' && isRecursiveForceRemove(input.args)) {
    return deny('Recursive force remove is blocked', 'rm-recursive-force', 'high', preview);
  }
  if (input.network === 'open') {
    return deny(
      'Open network access is not available for terminal_run v1',
      'network-open',
      risk,
      preview
    );
  }
  if (input.filesystem === 'workspace-write') {
    return deny(
      'Workspace-wide writes are not available for terminal_run v1',
      'workspace-write',
      risk,
      preview
    );
  }
  if (input.interactive === 'allowed') {
    return deny(
      'Interactive terminal commands are not available for terminal_run',
      'interactive-command',
      'high',
      preview
    );
  }
  if (input.session.envPersistence === 'explicit' && sensitiveEnvKeys(input.env).length > 0) {
    return deny(
      'Sensitive-looking environment variables cannot be persisted in terminal sessions',
      'env-persistence-sensitive-key',
      'high',
      preview
    );
  }

  return { allowed: true, risk, preview };
}

function deny(
  reason: string,
  matchedRule: string,
  risk: TerminalCommandPolicyDecision['risk'],
  preview: TerminalCommandPolicyDecision['preview']
): TerminalCommandPolicyDecision {
  return { allowed: false, reason, matchedRule, risk, preview };
}

function inferRisk(input: TerminalCommandPolicyInput): TerminalCommandPolicyDecision['risk'] {
  if (input.interactive === 'allowed') {
    return 'high';
  }
  if (input.session.mode === 'persistent') {
    return 'high';
  }
  if (input.session.envPersistence === 'explicit') {
    return 'high';
  }
  if (envKeys(input.env).length > 0) {
    return 'medium';
  }
  if (input.filesystem !== 'read-only' || input.network !== 'none') {
    return 'medium';
  }
  const binName = basename(input.bin);
  if (['npm', 'pnpm', 'yarn', 'node', 'python', 'python3'].includes(binName)) {
    return 'medium';
  }
  return 'low';
}

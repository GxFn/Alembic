import path from 'node:path';
import {
  buildTerminalSessionPlan,
  type TerminalSessionPlan,
} from '#tools/adapters/TerminalSession.js';

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

const DENIED_BINS = new Set([
  'sudo',
  'su',
  'shutdown',
  'reboot',
  'halt',
  'mkfs',
  'dd',
  'passwd',
  'killall',
]);

const SHELL_BINS = new Set(['sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'osascript']);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ENV_KEYS = 32;
const MAX_ENV_VALUE_LENGTH = 4096;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PROTECTED_ENV_KEYS = new Set(['CI', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'LESS', 'PAGER']);
const SENSITIVE_ENV_NAME_PATTERN =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE_KEY)/i;

export function buildTerminalCommandPolicyInput(
  args: Record<string, unknown>,
  projectRoot: string,
  manifestTimeoutMs = DEFAULT_TIMEOUT_MS
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

function isRecursiveForceRemove(args: string[]) {
  return args.some((arg) => /^-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*$/.test(arg));
}

function basename(bin: string) {
  return bin.split('/').filter(Boolean).at(-1) || bin;
}

function formatCommandPreview(bin: string, args: string[]) {
  return [bin, ...args].map(quotePreviewArg).join(' ');
}

function quotePreviewArg(value: string) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function resolveCwd(
  requested: string | undefined,
  projectRoot: string
): { ok: true; path: string } | { ok: false; error: string } {
  const root = path.resolve(projectRoot);
  const resolved = requested
    ? path.resolve(path.isAbsolute(requested) ? requested : path.join(root, requested))
    : root;
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, error: `terminal cwd "${requested}" is outside project root` };
  }
  return { ok: true, path: resolved };
}

function normalizeTimeout(requested: number | undefined, manifestTimeout: number) {
  const base =
    Number.isFinite(manifestTimeout) && manifestTimeout > 0 ? manifestTimeout : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(requested) || !requested || requested <= 0) {
    return base;
  }
  return Math.min(requested, base);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function containsShellMeta(value: string) {
  return /[;&|<>`]|\$\(/.test(value);
}

function normalizeEnv(
  value: unknown
): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, env: {} };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'terminal_run env must be an object of string values' };
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length > MAX_ENV_KEYS) {
    return { ok: false, error: `terminal_run env can include at most ${MAX_ENV_KEYS} keys` };
  }
  const env: Record<string, string> = {};
  for (const key of keys) {
    if (!ENV_NAME_PATTERN.test(key)) {
      return { ok: false, error: `terminal_run env key "${key}" is invalid` };
    }
    if (PROTECTED_ENV_KEYS.has(key)) {
      return { ok: false, error: `terminal_run env key "${key}" is controlled by policy` };
    }
    const envValue = input[key];
    if (typeof envValue !== 'string') {
      return { ok: false, error: `terminal_run env value for "${key}" must be a string` };
    }
    if (envValue.length > MAX_ENV_VALUE_LENGTH) {
      return { ok: false, error: `terminal_run env value for "${key}" is too large` };
    }
    env[key] = envValue;
  }
  return { ok: true, env };
}

function envKeys(env: Record<string, string>) {
  return Object.keys(env).sort();
}

function sensitiveEnvKeys(env: Record<string, string>) {
  return envKeys(env).filter((key) => SENSITIVE_ENV_NAME_PATTERN.test(key));
}

function isNetworkMode(value: unknown): value is TerminalNetworkIntent {
  return value === 'none' || value === 'allowlisted' || value === 'open';
}

function isFilesystemMode(value: unknown): value is TerminalFilesystemIntent {
  return value === 'read-only' || value === 'project-write' || value === 'workspace-write';
}

function isInteractivityMode(value: unknown): value is TerminalInteractivityIntent {
  return value === 'never' || value === 'allowed';
}

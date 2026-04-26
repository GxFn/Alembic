import {
  countScriptLines,
  detectDangerousShellPayload,
  envKeys,
  isFilesystemMode,
  isInteractivityMode,
  isNetworkMode,
  MAX_SCRIPT_BYTES,
  normalizeEnv,
  normalizeTimeout,
  resolveCwd,
  sensitiveEnvKeys,
  sha256,
} from './TerminalPolicyShared.js';
import type {
  TerminalScriptPolicyDecision,
  TerminalScriptPolicyInput,
} from './TerminalPolicyTypes.js';

export function buildTerminalScriptPolicyInput(
  args: Record<string, unknown>,
  projectRoot: string,
  manifestTimeoutMs = 30_000
): { ok: true; input: TerminalScriptPolicyInput } | { ok: false; error: string } {
  if (typeof args.script !== 'string' || args.script.trim().length === 0) {
    return { ok: false, error: 'terminal_script requires a non-empty string "script"' };
  }
  const byteLength = Buffer.byteLength(args.script, 'utf8');
  if (byteLength > MAX_SCRIPT_BYTES) {
    return {
      ok: false,
      error: `terminal_script script can be at most ${MAX_SCRIPT_BYTES} bytes`,
    };
  }
  if (args.shell !== undefined && args.shell !== 'sh' && args.shell !== '/bin/sh') {
    return { ok: false, error: 'terminal_script shell must be "sh" or "/bin/sh"' };
  }
  const env = normalizeEnv(args.env, 'terminal_script');
  if (!env.ok) {
    return { ok: false, error: env.error };
  }
  const cwd = resolveCwd(typeof args.cwd === 'string' ? args.cwd : undefined, projectRoot);
  if (!cwd.ok) {
    return { ok: false, error: cwd.error };
  }
  if (args.interactive !== undefined && !isInteractivityMode(args.interactive)) {
    return { ok: false, error: 'terminal_script interactive must be "never" or "allowed"' };
  }

  return {
    ok: true,
    input: {
      script: args.script,
      scriptHash: sha256(args.script),
      lineCount: countScriptLines(args.script),
      byteLength,
      shell: '/bin/sh',
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
    },
  };
}

export function evaluateTerminalScriptPolicy(
  input: TerminalScriptPolicyInput
): TerminalScriptPolicyDecision {
  const preview = {
    shell: input.shell,
    scriptHash: input.scriptHash,
    lineCount: input.lineCount,
    byteLength: input.byteLength,
    cwd: input.cwd,
    env: {
      keys: envKeys(input.env),
      persistence: 'none' as const,
    },
    network: input.network,
    filesystem: input.filesystem,
    interactive: input.interactive,
    timeoutMs: input.timeoutMs,
  };
  const risk = inferScriptRisk(input);

  if (input.interactive === 'allowed') {
    return deny(
      'Interactive terminal scripts are not available for terminal_script',
      'interactive-script',
      'high',
      preview
    );
  }
  if (input.network === 'open') {
    return deny(
      'Open network access is not available for terminal_script v1',
      'network-open',
      risk,
      preview
    );
  }
  if (input.filesystem === 'workspace-write') {
    return deny(
      'Workspace-wide writes are not available for terminal_script v1',
      'workspace-write',
      risk,
      preview
    );
  }
  if (sensitiveEnvKeys(input.env).length > 0) {
    return deny(
      'Sensitive-looking environment variables cannot be passed to terminal_script',
      'script-sensitive-env-key',
      'high',
      preview
    );
  }
  const dangerous = detectDangerousShellPayload(input.script, 'script', 'terminal_script');
  if (dangerous) {
    return deny(dangerous.reason, dangerous.rule, 'high', preview);
  }

  return { allowed: true, risk, preview };
}

function deny(
  reason: string,
  matchedRule: string,
  risk: TerminalScriptPolicyDecision['risk'],
  preview: TerminalScriptPolicyDecision['preview']
): TerminalScriptPolicyDecision {
  return { allowed: false, reason, matchedRule, risk, preview };
}

function inferScriptRisk(input: TerminalScriptPolicyInput): TerminalScriptPolicyDecision['risk'] {
  if (
    input.filesystem === 'project-write' ||
    input.network !== 'none' ||
    input.interactive !== 'never' ||
    envKeys(input.env).length > 0
  ) {
    return 'high';
  }
  return 'medium';
}

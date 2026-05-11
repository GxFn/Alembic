import {
  buildShellPayloadPolicyInput,
  countScriptLines,
  detectDangerousShellPayload,
  envKeys,
  MAX_PTY_STDIN_BYTES,
  MAX_SHELL_COMMAND_BYTES,
  normalizePtyDimension,
  sensitiveEnvKeys,
  sha256,
} from './TerminalPolicyShared.js';
import type {
  TerminalPtyPolicyDecision,
  TerminalPtyPolicyInput,
  TerminalShellPolicyDecision,
  TerminalShellPolicyInput,
} from './TerminalPolicyTypes.js';

export function buildTerminalShellPolicyInput(
  args: Record<string, unknown>,
  projectRoot: string,
  manifestTimeoutMs = 30_000
): { ok: true; input: TerminalShellPolicyInput } | { ok: false; error: string } {
  const parsed = buildShellPayloadPolicyInput(args, {
    toolName: 'terminal_shell',
    projectRoot,
    manifestTimeoutMs,
    defaultInteractive: 'never',
    maxBytes: MAX_SHELL_COMMAND_BYTES,
  });
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, input: parsed.input };
}

export function buildTerminalPtyPolicyInput(
  args: Record<string, unknown>,
  projectRoot: string,
  manifestTimeoutMs = 30_000
): { ok: true; input: TerminalPtyPolicyInput } | { ok: false; error: string } {
  const parsed = buildShellPayloadPolicyInput(args, {
    toolName: 'terminal_pty',
    projectRoot,
    manifestTimeoutMs,
    defaultInteractive: 'allowed',
    maxBytes: MAX_SHELL_COMMAND_BYTES,
  });
  if (!parsed.ok) {
    return parsed;
  }
  const rows = normalizePtyDimension(args.rows, 24, 'rows');
  if (!rows.ok) {
    return { ok: false, error: rows.error };
  }
  const cols = normalizePtyDimension(args.cols, 80, 'cols');
  if (!cols.ok) {
    return { ok: false, error: cols.error };
  }
  const stdin = normalizePtyStdin(args.stdin);
  if (!stdin.ok) {
    return { ok: false, error: stdin.error };
  }
  const stdinMetadata =
    stdin.value.length > 0
      ? {
          stdinHash: sha256(stdin.value),
          stdinLineCount: countScriptLines(stdin.value),
          stdinByteLength: Buffer.byteLength(stdin.value, 'utf8'),
        }
      : {};
  return {
    ok: true,
    input: {
      ...parsed.input,
      stdin: stdin.value,
      pty: {
        rows: rows.value,
        cols: cols.value,
        stdin: stdin.value.length > 0 ? 'provided' : 'disabled',
        ...stdinMetadata,
        wrapper: 'python-pty',
      },
    },
  };
}

export function evaluateTerminalShellPolicy(
  input: TerminalShellPolicyInput
): TerminalShellPolicyDecision {
  const preview = shellPayloadPreview(input);
  const risk = inferShellPayloadRisk(input);

  if (input.interactive === 'allowed') {
    return denyShell(
      'Interactive shell commands require terminal_pty',
      'shell-interactive-command',
      'high',
      preview
    );
  }
  const commonBlock = evaluateShellPayloadCommonPolicy(
    input,
    risk,
    preview,
    'shell',
    'terminal_shell'
  );
  if (commonBlock) {
    return commonBlock as TerminalShellPolicyDecision;
  }

  return { allowed: true, risk, preview };
}

export function evaluateTerminalPtyPolicy(
  input: TerminalPtyPolicyInput
): TerminalPtyPolicyDecision {
  const preview = {
    ...shellPayloadPreview(input),
    pty: input.pty,
  };
  const risk = 'high' as const;
  const commonBlock = evaluateShellPayloadCommonPolicy(input, risk, preview, 'pty', 'terminal_pty');
  if (commonBlock) {
    return commonBlock as TerminalPtyPolicyDecision;
  }
  if (input.stdin.length > 0) {
    const dangerousStdin = detectDangerousShellPayload(input.stdin, 'pty', 'terminal_pty');
    if (dangerousStdin) {
      return denyPty(dangerousStdin.reason, `${dangerousStdin.rule}-stdin`, 'high', preview);
    }
  }
  return { allowed: true, risk, preview };
}

function shellPayloadPreview(
  input: TerminalShellPolicyInput
): TerminalShellPolicyDecision['preview'] {
  return {
    shell: input.shell,
    commandHash: input.commandHash,
    lineCount: input.lineCount,
    byteLength: input.byteLength,
    cwd: input.cwd,
    env: {
      keys: envKeys(input.env),
      persistence: 'none',
    },
    network: input.network,
    filesystem: input.filesystem,
    interactive: input.interactive,
    timeoutMs: input.timeoutMs,
  };
}

function evaluateShellPayloadCommonPolicy(
  input: TerminalShellPolicyInput,
  risk: 'low' | 'medium' | 'high',
  preview: TerminalShellPolicyDecision['preview'] | TerminalPtyPolicyDecision['preview'],
  rulePrefix: 'shell' | 'pty',
  toolName: 'terminal_shell' | 'terminal_pty'
): TerminalShellPolicyDecision | TerminalPtyPolicyDecision | null {
  if (input.network === 'open') {
    return denyShellPayload(
      'Open network access is not available for shell terminal capabilities',
      'network-open',
      risk,
      preview
    );
  }
  if (input.filesystem === 'workspace-write') {
    return denyShellPayload(
      'Workspace-wide writes are not available for shell terminal capabilities',
      'workspace-write',
      risk,
      preview
    );
  }
  if (sensitiveEnvKeys(input.env).length > 0) {
    return denyShellPayload(
      `Sensitive-looking environment variables cannot be passed to ${toolName}`,
      `${rulePrefix}-sensitive-env-key`,
      'high',
      preview
    );
  }
  const dangerous = detectDangerousShellPayload(input.command, rulePrefix, toolName);
  if (dangerous) {
    return denyShellPayload(dangerous.reason, dangerous.rule, 'high', preview);
  }
  return null;
}

function denyShellPayload(
  reason: string,
  matchedRule: string,
  risk: 'low' | 'medium' | 'high',
  preview: TerminalShellPolicyDecision['preview'] | TerminalPtyPolicyDecision['preview']
): TerminalShellPolicyDecision | TerminalPtyPolicyDecision {
  if ('pty' in preview) {
    return denyPty(reason, matchedRule, risk, preview);
  }
  return denyShell(reason, matchedRule, risk, preview);
}

function denyShell(
  reason: string,
  matchedRule: string,
  risk: TerminalShellPolicyDecision['risk'],
  preview: TerminalShellPolicyDecision['preview']
): TerminalShellPolicyDecision {
  return { allowed: false, reason, matchedRule, risk, preview };
}

function denyPty(
  reason: string,
  matchedRule: string,
  risk: TerminalPtyPolicyDecision['risk'],
  preview: TerminalPtyPolicyDecision['preview']
): TerminalPtyPolicyDecision {
  return { allowed: false, reason, matchedRule, risk, preview };
}

function inferShellPayloadRisk(
  input: Pick<
    TerminalShellPolicyInput,
    'filesystem' | 'network' | 'interactive' | 'env' | 'lineCount'
  >
): TerminalShellPolicyDecision['risk'] {
  if (
    input.filesystem === 'project-write' ||
    input.network !== 'none' ||
    input.interactive !== 'never' ||
    envKeys(input.env).length > 0 ||
    input.lineCount > 1
  ) {
    return 'high';
  }
  return 'medium';
}

function normalizePtyStdin(
  value: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: '' };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'terminal_pty stdin must be a string when provided' };
  }
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength > MAX_PTY_STDIN_BYTES) {
    return {
      ok: false,
      error: `terminal_pty stdin can be at most ${MAX_PTY_STDIN_BYTES} bytes`,
    };
  }
  return { ok: true, value };
}

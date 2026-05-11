import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolHandler, ToolTerminalExecutionResult } from "../types.js";
import { isRecord, toolFailure, toolSuccess } from "../types.js";

const execAsync = promisify(exec);

const BLOCKED_COMMAND_SUBSTRINGS = [
  "sudo ",
  "su ",
  "rm -rf /",
  "shutdown",
  "reboot",
  "halt",
  "mkfs",
  "dd if=",
  "chmod 777",
  ":(){",
  "fork bomb",
  "eval ",
];

const BLOCKED_BINS = new Set([
  "sudo",
  "su",
  "shutdown",
  "reboot",
  "halt",
  "mkfs",
  "dd",
  "passwd",
  "useradd",
  "userdel",
  "groupadd",
  "chown",
  "killall",
  "eval",
]);

const PIPE_TO_SHELL_RE =
  /\b(curl|wget)\b.*\|\s*(sh|bash|zsh|dash|ksh|csh|tcsh|fish|perl|python|ruby|node)\b/i;
const SHELL_SEGMENT_RE = /[;&|()]+/;
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const MAX_SHELL_COMMAND_BYTES = 16 * 1024;
const MAX_ENV_KEYS = 32;
const MAX_ENV_VALUE_LENGTH = 4096;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PROTECTED_ENV_KEYS = new Set(["CI", "GIT_PAGER", "GIT_TERMINAL_PROMPT", "LESS", "PAGER"]);
const SENSITIVE_ENV_NAME_RE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE_KEY)/i;

type TerminalNetworkIntent = "none" | "allowlisted" | "open";
type TerminalFilesystemIntent = "read-only" | "project-write" | "workspace-write";

interface ParsedTerminalInput {
  readonly command: string;
  readonly cwd?: string;
  readonly timeout: number;
  readonly network?: TerminalNetworkIntent;
  readonly filesystem?: TerminalFilesystemIntent;
  readonly env?: Readonly<Record<string, string>>;
}

export const terminalExecuteHandler: ToolHandler = async (invocation, context) => {
  const root = stringValue(context.dependencies.projectRoot);
  if (!root) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "project_root_unavailable",
      message: "terminal.execute requires ToolRuntimeDependencies.projectRoot.",
    });
  }
  const parsed = parseTerminalInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const cwd = resolveCwd(root, parsed.input.cwd);
  if (!cwd.ok) {
    return toolFailure(context.descriptor, "error", cwd.error);
  }
  const safety = checkCommandSafety(parsed.input.command);
  if (!safety.safe) {
    return toolFailure(context.descriptor, "error", {
      code: "command_blocked",
      message: safety.reason ?? "Command blocked by terminal safety policy.",
    });
  }

  const startedAt = Date.now();
  const result = context.dependencies.terminalExecutor
    ? await context.dependencies.terminalExecutor.execute({
        command: parsed.input.command,
        cwd: cwd.path,
        projectRoot: root,
        timeoutMs: parsed.input.timeout,
        ...(parsed.input.network ? { network: parsed.input.network } : {}),
        ...(parsed.input.filesystem ? { filesystem: parsed.input.filesystem } : {}),
        ...(parsed.input.env ? { env: parsed.input.env } : {}),
        ...(context.dependencies.abortSignal
          ? { abortSignal: context.dependencies.abortSignal }
          : {}),
      })
    : await executeDirect(
        parsed.input.command,
        cwd.path,
        parsed.input.timeout,
        context.dependencies.abortSignal,
        parsed.input.env,
      );

  const rawOutput = combineOutput(result.stdout, result.stderr);
  const output = await compressOutput(rawOutput, parsed.input.command, context.dependencies);
  return toolSuccess(context.descriptor, {
    command: parsed.input.command,
    cwd: cwd.relativePath,
    exitCode: result.exitCode,
    timedOut: result.timedOut === true || result.exitCode === 137,
    durationMs: Date.now() - startedAt,
    stdout: stripAnsi(result.stdout),
    stderr: stripAnsi(result.stderr),
    output: result.exitCode === 0 ? output : `[exit ${result.exitCode}]\n${output}`,
    network: parsed.input.network ?? "none",
    filesystem: parsed.input.filesystem ?? "project-write",
    envKeys: Object.keys(parsed.input.env ?? {}).sort(),
    ...terminalSandboxMeta(result),
  });
};

async function executeDirect(
  command: string,
  cwd: string,
  timeout: number,
  abortSignal: AbortSignal | undefined,
  env: Readonly<Record<string, string>> | undefined,
): Promise<ToolTerminalExecutionResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...env, NO_COLOR: "1", TERM: "dumb" },
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as {
      readonly code?: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly killed?: boolean;
    };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? (error instanceof Error ? error.message : ""),
      exitCode: err.killed || abortSignal?.aborted ? 137 : (err.code ?? 1),
      ...(err.killed || abortSignal?.aborted ? { timedOut: true } : {}),
    };
  }
}

function parseTerminalInput(input: unknown):
  | {
      readonly ok: true;
      readonly input: ParsedTerminalInput;
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "terminal.execute input must be an object." },
    };
  }
  const command = stringValue(input.command);
  if (!command) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "terminal.execute requires command." },
    };
  }
  if (Buffer.byteLength(command, "utf8") > MAX_SHELL_COMMAND_BYTES) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: `terminal.execute command can be at most ${MAX_SHELL_COMMAND_BYTES} bytes.`,
      },
    };
  }
  const timeout = boundedInteger(input.timeout, 30_000, 120_000);
  if (timeout === undefined) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "terminal.execute timeout is invalid." },
    };
  }
  const network = parseNetwork(input.network);
  if (!network.ok) {
    return { ok: false, error: network.error };
  }
  const filesystem = parseFilesystem(input.filesystem);
  if (!filesystem.ok) {
    return { ok: false, error: filesystem.error };
  }
  const env = normalizeTerminalEnv(input.env);
  if (!env.ok) {
    return { ok: false, error: env.error };
  }
  const cwd = stringValue(input.cwd);
  return {
    ok: true,
    input: {
      command,
      ...(cwd ? { cwd } : {}),
      timeout,
      ...(network.value ? { network: network.value } : {}),
      ...(filesystem.value ? { filesystem: filesystem.value } : {}),
      ...(Object.keys(env.value).length > 0 ? { env: env.value } : {}),
    },
  };
}

function resolveCwd(
  projectRoot: string,
  rawCwd: string | undefined,
):
  | { readonly ok: true; readonly path: string; readonly relativePath: string }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  const root = path.resolve(projectRoot);
  const cwd = path.resolve(root, rawCwd ?? ".");
  const relativePath = path.relative(root, cwd);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return {
      ok: false,
      error: { code: "cwd_outside_project", message: "cwd must stay inside projectRoot." },
    };
  }
  return { ok: true, path: cwd, relativePath: relativePath || "." };
}

function checkCommandSafety(command: string): { readonly safe: boolean; readonly reason?: string } {
  const normalized = command.trim().toLowerCase();
  for (const blocked of BLOCKED_COMMAND_SUBSTRINGS) {
    if (normalized.startsWith(blocked) || normalized.includes(blocked)) {
      return { safe: false, reason: `Blocked command pattern: ${blocked.trim()}` };
    }
  }
  if (PIPE_TO_SHELL_RE.test(normalized)) {
    return { safe: false, reason: "Blocked piping download output to a shell." };
  }
  const firstWord = normalized.split(/\s+/)[0];
  if (firstWord && BLOCKED_BINS.has(firstWord)) {
    return { safe: false, reason: `Blocked executable: ${firstWord}` };
  }
  for (const segment of normalized.split(SHELL_SEGMENT_RE)) {
    const executable = segment.trim().split(/\s+/)[0];
    if (executable && BLOCKED_BINS.has(executable)) {
      // 中文注释：Agent terminal 可以执行有界命令，但不能把危险可执行文件藏在
      // 分号、管道或子 shell 后面绕过首词检查。
      return { safe: false, reason: `Blocked executable: ${executable}` };
    }
  }
  return { safe: true };
}

async function compressOutput(
  raw: string,
  command: string,
  dependencies: Parameters<ToolHandler>[1]["dependencies"],
): Promise<string> {
  const stripped = stripAnsi(raw);
  if (!dependencies.terminalCompressor) {
    return stripped;
  }
  try {
    return await dependencies.terminalCompressor.compress(stripped, {
      command,
      ...(dependencies.tokenBudget === undefined ? {} : { tokenBudget: dependencies.tokenBudget }),
    });
  } catch {
    return stripped;
  }
}

function combineOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim()) {
    parts.push(stdout.trim());
  }
  if (stderr.trim()) {
    parts.push(`[stderr]\n${stderr.trim()}`);
  }
  return parts.join("\n\n") || "[no output]";
}

function terminalSandboxMeta(result: ToolTerminalExecutionResult): Record<string, unknown> {
  return {
    ...(result.sandboxed === undefined ? {} : { sandboxed: result.sandboxed }),
    ...(result.degradeReason ? { degradeReason: result.degradeReason } : {}),
    ...(result.sandboxViolations ? { sandboxViolations: result.sandboxViolations } : {}),
  };
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, "");
}

function boundedInteger(value: unknown, fallback: number, max: number): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return Math.min(value, max);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseNetwork(
  value: unknown,
):
  | { readonly ok: true; readonly value?: TerminalNetworkIntent }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (value === undefined) {
    return { ok: true };
  }
  if (value === "none" || value === "allowlisted" || value === "open") {
    return { ok: true, value };
  }
  return {
    ok: false,
    error: {
      code: "invalid_input",
      message: 'terminal.execute network must be "none", "allowlisted", or "open".',
    },
  };
}

function parseFilesystem(
  value: unknown,
):
  | { readonly ok: true; readonly value?: TerminalFilesystemIntent }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (value === undefined) {
    return { ok: true };
  }
  if (value === "read-only" || value === "project-write" || value === "workspace-write") {
    return { ok: true, value };
  }
  return {
    ok: false,
    error: {
      code: "invalid_input",
      message:
        'terminal.execute filesystem must be "read-only", "project-write", or "workspace-write".',
    },
  };
}

function normalizeTerminalEnv(
  value: unknown,
):
  | { readonly ok: true; readonly value: Record<string, string> }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (value === undefined || value === null) {
    return { ok: true, value: {} };
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "terminal.execute env must be an object." },
    };
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ENV_KEYS) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: `terminal.execute env can include at most ${MAX_ENV_KEYS} keys.`,
      },
    };
  }
  const env: Record<string, string> = {};
  for (const [key, envValue] of entries) {
    if (!ENV_NAME_RE.test(key)) {
      return {
        ok: false,
        error: { code: "invalid_input", message: `terminal.execute env key "${key}" is invalid.` },
      };
    }
    if (PROTECTED_ENV_KEYS.has(key)) {
      return {
        ok: false,
        error: {
          code: "invalid_input",
          message: `terminal.execute env key "${key}" is controlled by policy.`,
        },
      };
    }
    if (SENSITIVE_ENV_NAME_RE.test(key)) {
      return {
        ok: false,
        error: {
          code: "invalid_input",
          message: `terminal.execute env key "${key}" looks sensitive and is blocked.`,
        },
      };
    }
    if (typeof envValue !== "string") {
      return {
        ok: false,
        error: {
          code: "invalid_input",
          message: `terminal.execute env value for "${key}" must be a string.`,
        },
      };
    }
    if (envValue.length > MAX_ENV_VALUE_LENGTH) {
      return {
        ok: false,
        error: {
          code: "invalid_input",
          message: `terminal.execute env value for "${key}" is too large.`,
        },
      };
    }
    env[key] = envValue;
  }
  return { ok: true, value: env };
}

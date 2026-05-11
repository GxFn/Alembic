import type { ToolTerminalExecutionRequest, ToolTerminalExecutionResult } from "../types.js";
import { buildTerminalEnvironmentWithSandbox } from "./SandboxEnvironment.js";
import { type SandboxExecResult, sandboxExec } from "./SandboxExecutor.js";
import { buildSandboxProfile, type SandboxInput, type SandboxMode } from "./SandboxPolicy.js";

export interface ToolSandboxTerminalExecutorOptions {
  readonly mode?: SandboxMode;
  readonly network?: SandboxInput["network"];
  readonly filesystem?: SandboxInput["filesystem"];
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
  readonly shell?: string;
  readonly allowedDomains?: readonly string[];
}

const DEFAULT_SHELL = "/bin/sh";

export class ToolSandboxTerminalExecutor {
  readonly #options: ToolSandboxTerminalExecutorOptions;

  constructor(options: ToolSandboxTerminalExecutorOptions = {}) {
    this.#options = options;
  }

  async execute(request: ToolTerminalExecutionRequest): Promise<ToolTerminalExecutionResult> {
    const commandEnv = mergeEnv(this.#options.env, request.env);
    const profile = buildSandboxProfile({
      network: request.network ?? this.#options.network ?? "none",
      filesystem: request.filesystem ?? this.#options.filesystem ?? "project-write",
      cwd: request.cwd,
      projectRoot: request.projectRoot,
      timeoutMs: request.timeoutMs,
      ...(this.#options.mode ? { mode: this.#options.mode } : {}),
      ...(this.#options.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: this.#options.maxOutputBytes }),
      ...(Object.keys(commandEnv).length > 0 ? { env: commandEnv } : {}),
      ...(this.#options.allowedDomains
        ? { allowedDomains: [...this.#options.allowedDomains] }
        : {}),
    });

    const execEnv =
      profile.mode === "disabled"
        ? buildTerminalEnvironmentWithSandbox(process.env, commandEnv, profile)
        : commandEnv;

    const result = await sandboxExec(
      {
        bin: this.#options.shell ?? DEFAULT_SHELL,
        args: ["-lc", request.command],
        cwd: request.cwd,
        env: execEnv as Record<string, string>,
        timeout: request.timeoutMs,
        maxBuffer: profile.limits.maxOutputBytes,
        commandForConflictCheck: request.command,
        ...(request.abortSignal ? { signal: request.abortSignal } : {}),
      },
      profile,
    );

    return normalizeSandboxResult(result);
  }
}

function normalizeSandboxResult(result: SandboxExecResult): ToolTerminalExecutionResult {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    ...(result.exitCode === 137 ? { timedOut: true } : {}),
    sandboxed: result.sandboxed,
    ...(result.degradeReason ? { degradeReason: result.degradeReason } : {}),
    ...(result.violations ? { sandboxViolations: result.violations } : {}),
  };
}

function mergeEnv(
  base: Readonly<Record<string, string>> | undefined,
  override: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return {
    ...normalizeEnv(base),
    ...normalizeEnv(override),
  };
}

function normalizeEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

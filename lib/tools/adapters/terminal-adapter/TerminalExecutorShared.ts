import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { sandboxExec } from '#sandbox/SandboxExecutor.js';
import { buildSandboxProfile } from '#sandbox/SandboxPolicy.js';
import type { TerminalSessionManager } from '#tools/adapters/TerminalSessionManager.js';
import type { ToolExecutionRequest } from '#tools/core/ToolContracts.js';
import type { ToolResultEnvelope, ToolResultStatus } from '#tools/core/ToolResultEnvelope.js';
import { recordTerminalAudit } from './TerminalAudit.js';

export const execFileAsync = promisify(execFile);

export interface ExecFailure extends Error {
  code?: number | string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

export function execFileWithInput(
  bin: string,
  args: string[],
  input: string,
  options: {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
    env: NodeJS.ProcessEnv;
  }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let killed = false;
    let timedOut = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      killed = true;
      child.kill('SIGTERM');
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      killed = true;
      child.kill('SIGTERM');
    }, options.timeout);
    options.signal?.addEventListener('abort', abort, { once: true });

    const capture = (target: Buffer[], chunk: Buffer | string) => {
      target.push(Buffer.from(chunk));
      if (Buffer.concat(target).byteLength > options.maxBuffer) {
        killed = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout?.on('data', (chunk) => capture(stdout, chunk));
    child.stderr?.on('data', (chunk) => capture(stderr, chunk));
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => {
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (code === 0 && !timedOut && !options.signal?.aborted) {
        finish(() => resolve({ stdout: stdoutText, stderr: stderrText }));
        return;
      }
      const error = new Error(stderrText || `Process exited with code ${code}`) as ExecFailure;
      error.code = code ?? 1;
      error.killed = killed;
      error.stdout = stdoutText;
      error.stderr = stderrText;
      finish(() => reject(error));
    });
    child.stdin?.end(input);
  });
}

export function statusForFailure(
  request: ToolExecutionRequest,
  failure: ExecFailure
): ToolResultStatus {
  return request.context.abortSignal?.aborted ? 'aborted' : failure.killed ? 'timeout' : 'error';
}

export async function recordAndReturn(request: ToolExecutionRequest, envelope: ToolResultEnvelope) {
  await recordTerminalAudit(request, envelope);
  return envelope;
}

export function getTerminalSessionManager(
  request: ToolExecutionRequest,
  fallback: TerminalSessionManager
): TerminalSessionManager {
  try {
    const candidate = request.context.services.get('terminalSessionManager');
    if (isTerminalSessionManager(candidate)) {
      return candidate;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export function scriptAuditData(script: {
  script: string;
  scriptHash: string;
  lineCount: number;
  byteLength: number;
  shell: '/bin/sh';
}) {
  return {
    shell: script.shell,
    scriptHash: script.scriptHash,
    verificationHash: createHash('sha256').update(script.script).digest('hex'),
    lineCount: script.lineCount,
    byteLength: script.byteLength,
  };
}

export function shellAuditData(shell: {
  command: string;
  commandHash: string;
  lineCount: number;
  byteLength: number;
  shell: '/bin/sh';
}) {
  return {
    shell: shell.shell,
    commandHash: shell.commandHash,
    verificationHash: createHash('sha256').update(shell.command).digest('hex'),
    lineCount: shell.lineCount,
    byteLength: shell.byteLength,
  };
}

function isTerminalSessionManager(value: unknown): value is TerminalSessionManager {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as TerminalSessionManager).acquire === 'function' &&
    typeof (value as TerminalSessionManager).snapshot === 'function' &&
    typeof (value as TerminalSessionManager).list === 'function' &&
    typeof (value as TerminalSessionManager).close === 'function' &&
    typeof (value as TerminalSessionManager).cleanup === 'function'
  );
}

// ── Sandbox-aware execution wrappers ──

export interface SandboxIntentInput {
  network: 'none' | 'allowlisted' | 'open';
  filesystem: 'read-only' | 'project-write' | 'workspace-write';
  projectRoot: string;
  env?: Record<string, string>;
}

export interface SandboxedExecResult {
  stdout: string;
  stderr: string;
  sandbox?: {
    mode: string;
    sandboxed: boolean;
    degradeReason?: string;
    violations?: { count: number; operations: Record<string, number>; paths: string[] };
    networkDenied: boolean;
    filesystemMode: string;
    envStripped: number;
  };
}

/**
 * sandbox-exec 感知的 execFileAsync 替代。
 * 当提供 sandboxInput 且沙箱未 disabled 时，命令在 macOS Seatbelt 沙箱中运行。
 */
export async function sandboxedExecFile(
  bin: string,
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
    env: NodeJS.ProcessEnv;
  },
  sandboxInput?: SandboxIntentInput
): Promise<SandboxedExecResult> {
  if (!sandboxInput) {
    const r = await execFileAsync(bin, args, options);
    return { stdout: r.stdout, stderr: r.stderr };
  }

  const profile = buildSandboxProfile({
    network: sandboxInput.network,
    filesystem: sandboxInput.filesystem,
    cwd: options.cwd,
    projectRoot: sandboxInput.projectRoot,
    timeoutMs: options.timeout,
    maxOutputBytes: options.maxBuffer,
    env: sandboxInput.env,
  });

  if (profile.mode === 'disabled') {
    const r = await execFileAsync(bin, args, options);
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      sandbox: {
        mode: 'disabled',
        sandboxed: false,
        networkDenied: false,
        filesystemMode: sandboxInput.filesystem,
        envStripped: 0,
      },
    };
  }

  const result = await sandboxExec(
    {
      bin,
      args,
      cwd: options.cwd,
      env: (options.env ?? {}) as Record<string, string>,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      signal: options.signal,
    },
    profile
  );

  const sandboxMeta = {
    mode: profile.mode,
    sandboxed: result.sandboxed,
    degradeReason: result.degradeReason,
    violations: result.violations,
    networkDenied: !profile.network.allow,
    filesystemMode: sandboxInput.filesystem,
    envStripped: profile.environment.strip.length,
  };

  if (result.exitCode !== 0) {
    const error = new Error(
      result.stderr || `Process exited with code ${result.exitCode}`
    ) as ExecFailure;
    error.code = result.exitCode;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw Object.assign(error, { _sandboxMeta: sandboxMeta });
  }

  return { stdout: result.stdout, stderr: result.stderr, sandbox: sandboxMeta };
}

/**
 * sandbox-exec 感知的 execFileWithInput 替代。
 * PTY stdin 模式在沙箱中运行。
 */
export async function sandboxedExecFileWithInput(
  bin: string,
  args: string[],
  input: string,
  options: {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
    env: NodeJS.ProcessEnv;
  },
  sandboxInput?: SandboxIntentInput
): Promise<SandboxedExecResult> {
  if (!sandboxInput) {
    return execFileWithInput(bin, args, input, options);
  }

  const profile = buildSandboxProfile({
    network: sandboxInput.network,
    filesystem: sandboxInput.filesystem,
    cwd: options.cwd,
    projectRoot: sandboxInput.projectRoot,
    timeoutMs: options.timeout,
    maxOutputBytes: options.maxBuffer,
    env: sandboxInput.env,
  });

  if (profile.mode === 'disabled') {
    const r = await execFileWithInput(bin, args, input, options);
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      sandbox: {
        mode: 'disabled',
        sandboxed: false,
        networkDenied: false,
        filesystemMode: sandboxInput.filesystem,
        envStripped: 0,
      },
    };
  }

  const result = await sandboxExec(
    {
      bin,
      args,
      cwd: options.cwd,
      env: (options.env ?? {}) as Record<string, string>,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      signal: options.signal,
      stdin: input,
    },
    profile
  );

  const sandboxMeta = {
    mode: profile.mode,
    sandboxed: result.sandboxed,
    degradeReason: result.degradeReason,
    violations: result.violations,
    networkDenied: !profile.network.allow,
    filesystemMode: sandboxInput.filesystem,
    envStripped: profile.environment.strip.length,
  };

  if (result.exitCode !== 0) {
    const error = new Error(
      result.stderr || `Process exited with code ${result.exitCode}`
    ) as ExecFailure;
    error.code = result.exitCode;
    error.killed = false;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw Object.assign(error, { _sandboxMeta: sandboxMeta });
  }

  return { stdout: result.stdout, stderr: result.stderr, sandbox: sandboxMeta };
}

/**
 * @module tools/v2/handlers/terminal
 *
 * 终端执行工具 — 在 Seatbelt 沙箱中执行命令，返回结构化压缩输出。
 * Actions: exec
 *
 * 执行流程: 安全检查 → cwd 校验 → Seatbelt 沙箱执行 → OutputCompressor 压缩 → token budget 截断
 *
 * 沙箱集成: 通过 ToolContext.sandboxExecutor 注入 SandboxExecutor，
 *           未注入时降级为 plain exec（测试/非 macOS 环境）。
 */

import { exec } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { stripAnsi } from '../compressor/strip.js';
import { estimateTokens, fail, ok, type ToolContext, type ToolResult } from '../types.js';

const execAsync = promisify(exec);

/** 危险命令黑名单 — 子串匹配 */
const BLOCKED_COMMANDS = [
  'sudo ',
  'su ',
  'rm -rf /',
  'shutdown',
  'reboot',
  'halt',
  'mkfs',
  'dd if=',
  'chmod 777',
  ':(){',
  'fork bomb',
];

/** 危险管道模式 — 下载命令输出 pipe 到 shell */
const PIPE_TO_SHELL_RE =
  /\b(curl|wget)\b.*\|\s*(sh|bash|zsh|dash|ksh|csh|tcsh|fish|perl|python|ruby|node)\b/i;

/** 危险可执行文件 */
const BLOCKED_BINS = new Set([
  'sudo',
  'su',
  'shutdown',
  'reboot',
  'halt',
  'mkfs',
  'dd',
  'passwd',
  'useradd',
  'userdel',
  'groupadd',
  'chown',
]);

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  if (action !== 'exec') {
    return fail(`Unknown terminal action: ${action}`);
  }
  return handleExec(params, ctx);
}

async function handleExec(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = params.command as string;
  if (!command || typeof command !== 'string') {
    return fail('terminal.exec requires command');
  }

  const rawCwd = params.cwd ? String(params.cwd) : ctx.projectRoot;
  const cwd = path.resolve(ctx.projectRoot, rawCwd);
  if (!cwd.startsWith(ctx.projectRoot)) {
    return fail(`cwd must be within project root: ${ctx.projectRoot}`);
  }

  const timeout = Math.min((params.timeout as number) || 30000, 120000);

  const securityCheck = checkCommandSafety(command);
  if (!securityCheck.safe) {
    return fail(`Command blocked: ${securityCheck.reason}`);
  }

  const startMs = Date.now();

  try {
    const { stdout, stderr, exitCode } = await execInSandboxOrDirect(command, cwd, timeout, ctx);

    const rawOutput = combineOutput(stdout, stderr);
    const compressed = await compressOutput(rawOutput, command, ctx);
    const durationMs = Date.now() - startMs;

    if (exitCode === 137) {
      const partial = stripAnsi(stdout);
      const text = partial
        ? `[timeout] partial output:\n${partial}`
        : '[command timed out or aborted]';
      return ok(text, { durationMs, tokensEstimate: estimateTokens(text) });
    }

    const text = exitCode === 0 ? compressed : `[exit ${exitCode}]\n${compressed}`;
    return ok(text, {
      tokensEstimate: estimateTokens(text),
      durationMs,
    });
  } catch (err: unknown) {
    const durationMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : 'Command failed';
    const text = `[exit 1]\n${msg}`;
    return ok(text, { tokensEstimate: estimateTokens(text), durationMs });
  }
}

/**
 * 优先使用 Seatbelt 沙箱执行，未注入时降级为 plain exec。
 *
 * ctx.sandboxExecutor 由 ToolContextFactory 从 DI 容器注入，
 * 类型为 { exec(cmd, opts): Promise<{stdout,stderr,exitCode}> }
 */
async function execInSandboxOrDirect(
  command: string,
  cwd: string,
  timeout: number,
  ctx: ToolContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const executor = ctx.sandboxExecutor as SandboxExecutorLike | undefined;
  if (executor) {
    return executor.exec(command, {
      cwd,
      projectRoot: ctx.projectRoot,
      timeout,
      signal: ctx.abortSignal,
    });
  }

  // 降级: plain exec（测试环境 / sandboxExecutor 未注入）
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
      signal: ctx.abortSignal,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    if (e.killed || ctx.abortSignal?.aborted) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: 137 };
    }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
  }
}

interface SandboxExecutorLike {
  exec(
    command: string,
    opts: { cwd: string; projectRoot: string; timeout: number; signal?: AbortSignal }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function checkCommandSafety(command: string): { safe: boolean; reason?: string } {
  const trimmed = command.trim().toLowerCase();

  for (const blocked of BLOCKED_COMMANDS) {
    if (trimmed.startsWith(blocked) || trimmed.includes(blocked)) {
      return { safe: false, reason: `Blocked command pattern: ${blocked.trim()}` };
    }
  }

  if (PIPE_TO_SHELL_RE.test(trimmed)) {
    return { safe: false, reason: 'Blocked: piping download command output to shell' };
  }

  const firstWord = trimmed.split(/\s+/)[0];
  if (BLOCKED_BINS.has(firstWord)) {
    return { safe: false, reason: `Blocked executable: ${firstWord}` };
  }

  return { safe: true };
}

function combineOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout?.trim()) {
    parts.push(stdout.trim());
  }
  if (stderr?.trim()) {
    parts.push(`[stderr]\n${stderr.trim()}`);
  }
  return parts.join('\n\n') || '[no output]';
}

async function compressOutput(raw: string, command: string, ctx: ToolContext): Promise<string> {
  if (!raw) {
    return raw;
  }

  if (ctx.compressor) {
    try {
      const result = await Promise.resolve(
        ctx.compressor.compress(raw, { command, tokenBudget: ctx.tokenBudget || 4000 })
      );
      return result;
    } catch {
      // compressor 失败，返回清理后的原始输出
    }
  }

  return stripAnsi(raw);
}

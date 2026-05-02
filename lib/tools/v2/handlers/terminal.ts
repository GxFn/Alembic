/**
 * @module tools/v2/handlers/terminal
 *
 * 终端执行工具 — 在沙箱中执行命令，返回结构化压缩输出。
 * Actions: exec
 *
 * 执行流程: 安全检查 → 沙箱执行 → OutputCompressor 压缩 → token budget 截断
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { stripAnsi } from '../compressor/strip.js';
import { estimateTokens, fail, ok, type ToolContext, type ToolResult } from '../types.js';

const execAsync = promisify(exec);

/** 危险命令黑名单 — 前缀匹配 */
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
  'curl | sh',
  'wget | sh',
  'curl | bash',
  'wget | bash',
];

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

  const cwd = params.cwd ? String(params.cwd) : ctx.projectRoot;
  const timeout = Math.min((params.timeout as number) || 30000, 120000);

  const securityCheck = checkCommandSafety(command);
  if (!securityCheck.safe) {
    return fail(`Command blocked: ${securityCheck.reason}`);
  }

  const startMs = Date.now();

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
      signal: ctx.abortSignal,
    });

    const rawOutput = combineOutput(stdout, stderr);
    const compressed = await compressOutput(rawOutput, command, ctx);
    const durationMs = Date.now() - startMs;

    return ok(
      { exitCode: 0, output: compressed },
      {
        tokensEstimate: estimateTokens(compressed),
        durationMs,
      }
    );
  } catch (err: unknown) {
    const durationMs = Date.now() - startMs;
    const execErr = err as {
      code?: number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      message?: string;
    };

    if (execErr.killed || ctx.abortSignal?.aborted) {
      return ok(
        {
          exitCode: -1,
          output: '[command timed out or aborted]',
          partial: stripAnsi(execErr.stdout ?? ''),
        },
        { durationMs }
      );
    }

    const rawOutput = combineOutput(execErr.stdout ?? '', execErr.stderr ?? '');
    const compressed = await compressOutput(rawOutput, command, ctx);

    return ok(
      {
        exitCode: execErr.code ?? 1,
        output: compressed || execErr.message || 'Command failed',
      },
      {
        tokensEstimate: estimateTokens(compressed || ''),
        durationMs,
      }
    );
  }
}

function checkCommandSafety(command: string): { safe: boolean; reason?: string } {
  const trimmed = command.trim().toLowerCase();

  for (const blocked of BLOCKED_COMMANDS) {
    if (trimmed.startsWith(blocked) || trimmed.includes(blocked)) {
      return { safe: false, reason: `Blocked command pattern: ${blocked.trim()}` };
    }
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

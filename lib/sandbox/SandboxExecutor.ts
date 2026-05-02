import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Logger from '#infra/logging/Logger.js';
import { buildSandboxEnvironment } from './SandboxEnvironment.js';
import { type ProxyHandle, startSandboxProxy } from './SandboxNetworkProxy.js';
import type { SandboxProfile } from './SandboxPolicy.js';
import {
  getSandboxExecPath,
  hasNestedSandboxConflict,
  isSandboxExecAvailable,
} from './SandboxProbe.js';
import { parseSandboxViolations, summarizeViolations } from './SandboxViolationParser.js';
import { buildSeatbeltProfile } from './SeatbeltProfileBuilder.js';

export interface SandboxExecOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  maxBuffer: number;
  signal?: AbortSignal;
  stdin?: string;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxed: boolean;
  degradeReason?: string;
  violations?: { count: number; operations: Record<string, number>; paths: string[] };
}

/**
 * 在 macOS Seatbelt 沙箱中执行命令。
 *
 * 降级场景:
 *   - profile.mode === 'disabled' → 直接执行（无沙箱）
 *   - sandbox-exec 不存在         → 降级到直接执行 + 警告日志
 *   - 目标二进制存在嵌套沙箱冲突  → 仅做环境净化，不包 sandbox-exec
 */
export async function sandboxExec(
  options: SandboxExecOptions,
  profile: SandboxProfile
): Promise<SandboxExecResult> {
  if (profile.mode === 'disabled') {
    return directExec(options, 'disabled');
  }

  const available = await isSandboxExecAvailable();
  if (!available) {
    Logger.warn('[Sandbox] sandbox-exec not available, executing without sandbox');
    return directExec(options, 'sandbox-exec-unavailable');
  }

  if (hasNestedSandboxConflict(options.bin)) {
    Logger.info(
      `[Sandbox] nested sandbox conflict for ${path.basename(options.bin)}, env-only isolation`
    );
    const cleanEnv = buildSandboxEnvironment(options.env, profile);
    return directExec({ ...options, env: cleanEnv }, 'nested-sandbox-conflict');
  }

  let proxy: ProxyHandle | null = null;
  const effectiveProfile = { ...profile, network: { ...profile.network } };

  if (profile.network.proxyPort === -1 && profile.network.allowedDomains.length > 0) {
    try {
      proxy = await startSandboxProxy({ allowedDomains: profile.network.allowedDomains });
      effectiveProfile.network.proxyPort = proxy.port;
    } catch (err) {
      Logger.warn(`[Sandbox] proxy start failed, falling back to no-network: ${err}`);
      effectiveProfile.network.allow = false;
      effectiveProfile.network.proxyPort = undefined;
    }
  }

  const cleanEnv = buildSandboxEnvironment(options.env, effectiveProfile);

  if (proxy) {
    cleanEnv.http_proxy = `http://127.0.0.1:${proxy.port}`;
    cleanEnv.https_proxy = `http://127.0.0.1:${proxy.port}`;
    cleanEnv.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    cleanEnv.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
  }

  await fs.mkdir(effectiveProfile.filesystem.tempDir, { recursive: true });

  const sbpl = buildSeatbeltProfile(effectiveProfile);
  const profilePath = path.join(
    os.tmpdir(),
    `alembic-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sb`
  );
  await fs.writeFile(profilePath, sbpl, { mode: 0o400 });

  try {
    const result = await execInSandbox(profilePath, options.bin, options.args, {
      cwd: options.cwd,
      env: cleanEnv,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      signal: options.signal,
      stdin: options.stdin,
    });
    const rawViolations = parseSandboxViolations(result.stderr);
    const violations = rawViolations.length > 0 ? summarizeViolations(rawViolations) : undefined;
    if (violations && violations.count > 0) {
      Logger.info(
        `[Sandbox] ${violations.count} violation(s): ${JSON.stringify(violations.operations)}`
      );
    }
    return { ...result, sandboxed: true, violations };
  } finally {
    if (proxy) {
      await proxy.stop().catch(() => {});
    }
    await fs.unlink(profilePath).catch(() => {});
    await fs
      .rm(effectiveProfile.filesystem.tempDir, { recursive: true, force: true })
      .catch(() => {});
  }
}

function execInSandbox(
  profilePath: string,
  bin: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
    stdin?: string;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const sandboxPath = getSandboxExecPath();
    const child = spawn(sandboxPath, ['-f', profilePath, bin, ...args], {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let killed = false;

    const finish = (cb: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      cb();
    };

    const abort = () => {
      killed = true;
      killProcessTree(child.pid);
    };
    const timer = setTimeout(() => {
      killed = true;
      killProcessTree(child.pid);
    }, options.timeout);
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes + stderrBytes > options.maxBuffer) {
        killed = true;
        killProcessTree(child.pid);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      stderrBytes += chunk.byteLength;
      if (stdoutBytes + stderrBytes > options.maxBuffer) {
        killed = true;
        killProcessTree(child.pid);
      }
    });

    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => {
      finish(() =>
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code ?? (killed ? 137 : 1),
        })
      );
    });

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

function directExec(
  options: SandboxExecOptions,
  degradeReason: string
): Promise<SandboxExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.bin, options.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let killed = false;

    const finish = (cb: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      cb();
    };

    const abort = () => {
      killed = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, options.timeout);
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout?.on('data', (c: Buffer) => stdout.push(c));
    child.stderr?.on('data', (c: Buffer) => stderr.push(c));
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => {
      finish(() =>
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code ?? (killed ? 137 : 1),
          sandboxed: false,
          degradeReason,
        })
      );
    });

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

function killProcessTree(pid: number | undefined) {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* process already exited */
    }
  }
}

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { PACKAGE_ROOT } from '../../shared/package-assets.js';

const execFileAsync = promisify(execFile);

/**
 * launchd 开机自启（macOS LaunchAgent，登录时 one-shot）。
 *
 * 模式：RunAtLoad 触发一次 `node cli.js daemon start -d <projectRoot>`。
 * DaemonSupervisor 自己管 lock/pid/detach，daemon 进程由它拉起后常驻；
 * launchd 只负责登录触发，不做 KeepAlive 保活——否则 launchd 的 respawn
 * 会与 Supervisor 的 pid/lock 管理互相争抢同一个 daemon。
 */

export type LaunchdCommandRunner = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

export interface AutostartOptions {
  projectRoot: string;
  /** 覆盖 home 目录（测试注入，避免触碰真实 LaunchAgents）。 */
  homeDir?: string;
  /** 覆盖 launchctl 执行器（测试注入）。 */
  runLaunchctl?: LaunchdCommandRunner;
  /** 覆盖 node 与 CLI 入口（测试注入；默认取当前进程与包内 dist CLI）。 */
  nodePath?: string;
  cliEntryPath?: string;
}

export interface AutostartStatus {
  supported: boolean;
  label: string;
  plistPath: string;
  plistExists: boolean;
  /** launchctl 已登记（仅真实查询时给出；dry 场景为 null）。 */
  loaded: boolean | null;
  logPath: string;
  message?: string;
}

/** label 稳定唯一：路径 hash 防同名项目冲突，slug 便于人工辨识。 */
export function autostartLabel(projectRoot: string): string {
  const hash = createHash('sha1').update(projectRoot).digest('hex').slice(0, 8);
  const slug = basename(projectRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `dev.alembic.daemon.${slug || 'project'}-${hash}`;
}

export function autostartPlistPath(label: string, homeDir = homedir()): string {
  return join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function autostartLogPath(label: string, homeDir = homedir()): string {
  return join(homeDir, 'Library', 'Logs', 'Alembic', `${label}.log`);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface AutostartPlistInput {
  label: string;
  nodePath: string;
  cliEntryPath: string;
  projectRoot: string;
  logPath: string;
}

/** 纯函数：生成 LaunchAgent plist 内容（可直测，不触碰系统）。 */
export function buildAutostartPlist(input: AutostartPlistInput): string {
  const args = [input.nodePath, input.cliEntryPath, 'daemon', 'start', '-d', input.projectRoot];
  const argXml = args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.projectRoot)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.logPath)}</string>
</dict>
</plist>
`;
}

function defaultLaunchctlRunner(): LaunchdCommandRunner {
  return async (command, args) => execFileAsync(command, args);
}

function resolveContext(options: AutostartOptions) {
  const homeDir = options.homeDir ?? homedir();
  const label = autostartLabel(options.projectRoot);
  return {
    homeDir,
    label,
    plistPath: autostartPlistPath(label, homeDir),
    logPath: autostartLogPath(label, homeDir),
    runLaunchctl: options.runLaunchctl ?? defaultLaunchctlRunner(),
  };
}

export async function installAutostart(options: AutostartOptions): Promise<AutostartStatus> {
  const { homeDir, label, plistPath, logPath, runLaunchctl } = resolveContext(options);
  if (process.platform !== 'darwin' && !options.homeDir) {
    return {
      supported: false,
      label,
      plistPath,
      plistExists: false,
      loaded: null,
      logPath,
      message: 'launchd autostart 仅支持 macOS',
    };
  }

  mkdirSync(join(homeDir, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(join(homeDir, 'Library', 'Logs', 'Alembic'), { recursive: true });
  const plist = buildAutostartPlist({
    label,
    nodePath: options.nodePath ?? process.execPath,
    cliEntryPath: options.cliEntryPath ?? join(PACKAGE_ROOT, 'dist', 'bin', 'cli.js'),
    projectRoot: options.projectRoot,
    logPath,
  });
  writeFileSync(plistPath, plist, { mode: 0o644 });

  // 重装场景先 unload 旧登记（不存在则忽略），再 load -w 持久启用。
  await runLaunchctl('launchctl', ['unload', plistPath]).catch(() => undefined);
  await runLaunchctl('launchctl', ['load', '-w', plistPath]);
  return {
    supported: true,
    label,
    plistPath,
    plistExists: true,
    loaded: true,
    logPath,
    message: `已安装登录自启：${label}`,
  };
}

export async function uninstallAutostart(options: AutostartOptions): Promise<AutostartStatus> {
  const { label, plistPath, logPath, runLaunchctl } = resolveContext(options);
  const plistExists = existsSync(plistPath);
  if (plistExists) {
    await runLaunchctl('launchctl', ['unload', '-w', plistPath]).catch(() => undefined);
    rmSync(plistPath, { force: true });
  }
  return {
    supported: process.platform === 'darwin' || Boolean(options.homeDir),
    label,
    plistPath,
    plistExists: false,
    loaded: false,
    logPath,
    message: plistExists ? `已移除登录自启：${label}` : '未安装登录自启，无需移除',
  };
}

export async function autostartStatus(options: AutostartOptions): Promise<AutostartStatus> {
  const { label, plistPath, logPath, runLaunchctl } = resolveContext(options);
  const plistExists = existsSync(plistPath);
  let loaded: boolean | null = null;
  if (plistExists) {
    loaded = await runLaunchctl('launchctl', ['list', label]).then(
      () => true,
      () => false
    );
  }
  return {
    supported: process.platform === 'darwin' || Boolean(options.homeDir),
    label,
    plistPath,
    plistExists,
    loaded,
    logPath,
    message: plistExists
      ? loaded
        ? '登录自启已安装且已登记'
        : 'plist 存在但 launchctl 未登记（可重装）'
      : '未安装登录自启',
  };
}

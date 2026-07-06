import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  autostartLabel,
  autostartPlistPath,
  autostartStatus,
  buildAutostartPlist,
  installAutostart,
  uninstallAutostart,
} from '../../lib/daemon/runtime/LaunchdAutostart.js';

describe('launchd autostart (login-time one-shot LaunchAgent)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeHome() {
    const home = mkdtempSync(join(tmpdir(), 'alembic-autostart-home-'));
    tmpDirs.push(home);
    return home;
  }

  /** 记录 launchctl 调用而不真正执行（不触碰系统 launchd）。 */
  function makeRunner(calls: string[][], failOn?: string) {
    return async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (failOn && args.includes(failOn)) {
        throw new Error(`stub failure: ${failOn}`);
      }
      return { stdout: '', stderr: '' };
    };
  }

  it('builds a stable per-project label with slug and path hash', () => {
    const a = autostartLabel('/Users/x/Projects/MyApp');
    const b = autostartLabel('/Users/x/Other/MyApp');
    expect(a).toMatch(/^dev\.alembic\.daemon\.myapp-[0-9a-f]{8}$/);
    // 同名项目不同路径不冲突
    expect(a).not.toBe(b);
    expect(autostartLabel('/Users/x/Projects/MyApp')).toBe(a);
  });

  it('renders plist with one-shot semantics and XML-escaped paths', () => {
    const plist = buildAutostartPlist({
      label: 'dev.alembic.daemon.demo-12345678',
      nodePath: '/usr/local/bin/node',
      cliEntryPath: '/opt/alembic/dist/bin/cli.js',
      projectRoot: '/Users/x/Docs & Repos/demo',
      logPath: '/Users/x/Library/Logs/Alembic/demo.log',
    });
    expect(plist).toContain('<string>/Users/x/Docs &amp; Repos/demo</string>');
    // 顺序：node cli daemon start -d <root>
    expect(plist).toContain(
      '<string>/usr/local/bin/node</string>\n    <string>/opt/alembic/dist/bin/cli.js</string>\n    <string>daemon</string>\n    <string>start</string>\n    <string>-d</string>'
    );
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    // one-shot：不做 KeepAlive，避免 launchd 与 DaemonSupervisor 争抢 daemon
    expect(plist).toContain('<key>KeepAlive</key>\n  <false/>');
  });

  it('install writes plist and reloads via unload+load -w; uninstall removes it', async () => {
    const home = makeHome();
    const calls: string[][] = [];
    const projectRoot = '/Users/x/Projects/demo';
    const installed = await installAutostart({
      projectRoot,
      homeDir: home,
      runLaunchctl: makeRunner(calls),
      nodePath: '/usr/local/bin/node',
      cliEntryPath: '/opt/alembic/dist/bin/cli.js',
    });
    expect(installed.plistExists).toBe(true);
    expect(installed.loaded).toBe(true);
    const plistPath = autostartPlistPath(installed.label, home);
    expect(readFileSync(plistPath, 'utf8')).toContain(installed.label);
    // 重装安全：先 unload（失败忽略）再 load -w
    expect(calls.map((c) => c[1])).toEqual(['unload', 'load']);
    expect(calls[1]).toContain('-w');

    const removed = await uninstallAutostart({
      projectRoot,
      homeDir: home,
      runLaunchctl: makeRunner(calls),
    });
    expect(removed.plistExists).toBe(false);
    const status = await autostartStatus({
      projectRoot,
      homeDir: home,
      runLaunchctl: makeRunner(calls),
    });
    expect(status.plistExists).toBe(false);
    expect(status.loaded).toBeNull();
  });

  it('install survives unload failure on first-time install', async () => {
    const home = makeHome();
    const calls: string[][] = [];
    const result = await installAutostart({
      projectRoot: '/Users/x/Projects/first',
      homeDir: home,
      runLaunchctl: makeRunner(calls, 'unload'),
      nodePath: '/usr/local/bin/node',
      cliEntryPath: '/opt/alembic/dist/bin/cli.js',
    });
    expect(result.loaded).toBe(true);
    expect(calls.map((c) => c[1])).toEqual(['unload', 'load']);
  });

  it('status reports launchctl registration when plist exists', async () => {
    const home = makeHome();
    const projectRoot = '/Users/x/Projects/status-demo';
    await installAutostart({
      projectRoot,
      homeDir: home,
      runLaunchctl: makeRunner([]),
      nodePath: '/usr/local/bin/node',
      cliEntryPath: '/opt/alembic/dist/bin/cli.js',
    });
    const loaded = await autostartStatus({
      projectRoot,
      homeDir: home,
      runLaunchctl: makeRunner([]),
    });
    expect(loaded.plistExists).toBe(true);
    expect(loaded.loaded).toBe(true);

    const notLoaded = await autostartStatus({
      projectRoot,
      homeDir: home,
      runLaunchctl: makeRunner([], 'list'),
    });
    expect(notLoaded.loaded).toBe(false);
  });
});

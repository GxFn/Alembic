import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type DaemonPaths,
  type DaemonState,
  ensureDaemonDirs,
  getPackageVersion,
  readDaemonState,
  removeDaemonState,
} from '@alembic/core/daemon';
import { resolveAlembicDaemonPaths } from '../../project-scope/ProjectScopeRegistry.js';
import { PACKAGE_ROOT } from '../../shared/package-assets.js';

export type DaemonStatusKind = 'ready' | 'starting' | 'stopped' | 'stale' | 'failed';

export interface DaemonStatus {
  status: DaemonStatusKind;
  ready: boolean;
  projectRoot: string;
  dataRoot: string;
  projectId: string | null;
  statePath: string;
  pidPath: string;
  lockDir: string;
  logPath: string;
  state: DaemonState | null;
  pidAlive: boolean;
  health: Record<string, unknown> | null;
  message?: string;
}

export interface StartDaemonOptions {
  projectRoot: string;
  host?: string;
  port?: number;
  restart?: boolean;
  waitUntilReadyMs?: number;
}

export interface StopDaemonOptions {
  projectRoot: string;
  waitMs?: number;
}

export interface DaemonSupervisorOptions {
  daemonEntryPath?: string;
  spawnDaemon?: typeof spawn;
}

export class DaemonSupervisor {
  readonly #daemonEntryPath?: string;
  readonly #spawnDaemon: typeof spawn;

  constructor(options: DaemonSupervisorOptions = {}) {
    this.#daemonEntryPath = options.daemonEntryPath;
    this.#spawnDaemon = options.spawnDaemon ?? spawn;
  }

  async status(projectRootInput: string): Promise<DaemonStatus> {
    const projectRoot = resolve(projectRootInput);
    const paths = resolveAlembicDaemonPaths(projectRoot);
    const state = readDaemonState(paths.statePath);
    const pidAlive = state?.pid ? isProcessAlive(state.pid) : false;

    if (!state) {
      return this.#statusResult(
        paths,
        'stopped',
        false,
        null,
        false,
        null,
        'daemon is not started'
      );
    }

    if (!pidAlive) {
      return this.#statusResult(
        paths,
        'stale',
        false,
        state,
        false,
        null,
        'daemon pid is not alive'
      );
    }

    if (isDaemonRuntimeOlderThanCurrentBuild(state)) {
      return this.#statusResult(
        paths,
        'stale',
        false,
        state,
        true,
        null,
        'daemon runtime is older than current build'
      );
    }

    const health = await fetchDaemonHealth(state);
    if (isMatchingHealth(state, health)) {
      return this.#statusResult(paths, 'ready', true, state, true, health);
    }

    // 假 stale 修复（2026-07-05 Dashboard 轮转"过期"复盘）：health 取数失败（1s 超时/网络抖动）
    // 与"身份真不匹配"是两回事——此前统一判 stale，多项目概要并发打同一 daemon 时总有一个
    // 超时→每次恰好一个项目被误标且刷新轮转。null=瞬态不可达→'starting'（pid 活着，非告警态）；
    // 只有 health 真返回且字段失配才是 stale（需重启的语义不变）。
    if (health === null) {
      return this.#statusResult(
        paths,
        'starting',
        false,
        state,
        true,
        null,
        'daemon process is alive but health endpoint did not respond in time'
      );
    }

    return this.#statusResult(
      paths,
      'stale',
      false,
      state,
      true,
      health,
      'daemon process is alive but health identity did not match'
    );
  }

  async start(options: StartDaemonOptions): Promise<DaemonStatus> {
    const projectRoot = resolve(options.projectRoot);
    const paths = resolveAlembicDaemonPaths(projectRoot);
    const strictExternalLaunch = Boolean(process.env.ALEMBIC_STRICT_SETUP_AUTHORITY_PATH?.trim());
    const existing = await this.status(projectRoot);
    if (!strictExternalLaunch && existing.ready && !options.restart) {
      return existing;
    }

    const entry = this.#daemonEntryPath ?? getDaemonServerEntryPath();
    if (!existsSync(entry)) {
      throw new Error(`Daemon server entry not found: ${entry}. Run npm run build first.`);
    }

    const startChild = async (
      current: DaemonStatus,
      manageTargetControlFiles: boolean
    ): Promise<DaemonStatus> => {
      if (manageTargetControlFiles && current.state?.pid && current.pidAlive) {
        await this.#terminateProcess(current.state.pid, 5000);
      }
      if (manageTargetControlFiles) {
        removeDaemonState(paths, { includeLock: false });
      }

      const port = options.port ?? 0;
      const host = options.host || '127.0.0.1';
      const strictStdioEvidence =
        !manageTargetControlFiles && current.state?.pid && current.pidAlive
          ? createStrictStdioLogEvidence(paths.logPath, current.state.pid)
          : null;
      const logFd = manageTargetControlFiles ? openSync(paths.logPath, 'a') : null;
      let child: ChildProcess;
      try {
        child = this.#spawnDaemon(process.execPath, [entry], {
          cwd: projectRoot,
          detached: true,
          env: {
            ...process.env,
            ALEMBIC_API_SERVER: '1',
            ALEMBIC_DAEMON_MODE: '1',
            ALEMBIC_DAEMON_HOST: host,
            ALEMBIC_DAEMON_PORT: String(port),
            ALEMBIC_DAEMON_STATE_PATH: paths.statePath,
            ALEMBIC_PROJECT_DIR: projectRoot,
            ALEMBIC_QUIET: process.env.ALEMBIC_QUIET || '1',
            ...(strictStdioEvidence
              ? { ALEMBIC_STRICT_QUIESCE_STDIO_EVIDENCE: JSON.stringify(strictStdioEvidence) }
              : {}),
          },
          stdio: manageTargetControlFiles
            ? ['ignore', logFd as number, logFd as number]
            : ['ignore', 'ignore', 'ignore'],
        });
      } finally {
        if (logFd !== null) {
          closeSync(logFd);
        }
      }
      child.unref();

      const childPid = child.pid ?? null;
      if (manageTargetControlFiles) {
        writeFileSync(paths.pidPath, `${childPid ?? ''}\n`, { mode: 0o600 });
      }

      const startup = await waitForReadyOrChildExit(
        paths,
        child,
        options.waitUntilReadyMs ?? 10_000,
        strictExternalLaunch ? childPid : null
      );
      if (startup.kind === 'exited') {
        if (strictExternalLaunch && startup.exitCode === 0) {
          if (manageTargetControlFiles) {
            removeDaemonState(paths, { includeLock: false });
          }
          return this.#statusResult(
            paths,
            'stopped',
            false,
            null,
            false,
            null,
            'strict external setup action completed'
          );
        }
        if (manageTargetControlFiles) {
          removeDaemonState(paths, { includeLock: false });
        }
        const exitDetail = startup.signalCode
          ? `signal ${startup.signalCode}`
          : `exit code ${startup.exitCode ?? 'unknown'}`;
        return this.#statusResult(
          paths,
          'failed',
          false,
          null,
          false,
          null,
          manageTargetControlFiles
            ? `daemon exited with ${exitDetail}; see ${paths.logPath}`
            : `strict setup daemon exited with ${exitDetail} before target initialization`
        );
      }

      const ready = startup.status;
      if (!ready.ready) {
        const childAlive = childPid ? isProcessAlive(childPid) : false;
        if (!childAlive) {
          if (manageTargetControlFiles) {
            removeDaemonState(paths, { includeLock: false });
          }
          return this.#statusResult(
            paths,
            'failed',
            false,
            null,
            false,
            null,
            manageTargetControlFiles
              ? `daemon failed to become ready; see ${paths.logPath}`
              : 'strict setup daemon failed before target initialization'
          );
        }
        return this.#statusResult(
          paths,
          'starting',
          false,
          null,
          true,
          null,
          ready.message ||
            (manageTargetControlFiles
              ? `daemon is still starting; see ${paths.logPath}`
              : 'strict setup daemon is still starting')
        );
      }
      return ready;
    };

    // strict external authority owns the first mutation boundary for both pristine and rebuild.
    // The supervisor may inspect existing state and stop a prior process, but target-local
    // dirs/lock/log/pid/state are created only after the child has acquired the external lease,
    // fsynced its journal header, and established snapshot authority.
    if (strictExternalLaunch) {
      return startChild(existing, false);
    }

    ensureDaemonDirs(paths);

    return this.#withLock(paths, options.waitUntilReadyMs ?? 10_000, async () => {
      const afterLock = await this.status(projectRoot);
      if (afterLock.ready && !options.restart) {
        return afterLock;
      }
      return startChild(afterLock, true);
    });
  }

  async stop(options: StopDaemonOptions): Promise<DaemonStatus> {
    const projectRoot = resolve(options.projectRoot);
    const paths = resolveAlembicDaemonPaths(projectRoot);
    const state = readDaemonState(paths.statePath);

    if (state?.pid && isProcessAlive(state.pid)) {
      await this.#terminateProcess(state.pid, options.waitMs ?? 5000);
    }

    removeDaemonState(paths);
    return this.#statusResult(paths, 'stopped', false, null, false, null, 'daemon stopped');
  }

  async ensure(options: StartDaemonOptions): Promise<DaemonStatus> {
    const current = await this.status(options.projectRoot);
    if (current.ready) {
      return current;
    }
    return this.start(options);
  }

  async #withLock<T>(paths: DaemonPaths, waitMs: number, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    let lockAttempt = 0;
    while (true) {
      try {
        mkdirSync(paths.lockDir, { mode: 0o700 });
        writeFileSync(
          join(paths.lockDir, 'owner.json'),
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`
        );
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        const ready = await this.status(paths.projectRoot);
        if (ready.ready) {
          return ready as T;
        }
        if (Date.now() - startedAt > waitMs) {
          if (isStaleLock(paths.lockDir)) {
            rmSync(paths.lockDir, { recursive: true, force: true });
            continue;
          }
          throw new Error(`Timed out waiting for daemon lock: ${paths.lockDir}`);
        }
        await sleep(computeDaemonLockBackoffMs(lockAttempt++));
      }
    }

    try {
      return await fn();
    } finally {
      rmSync(paths.lockDir, { recursive: true, force: true });
    }
  }

  async #terminateProcess(pid: number, waitMs: number): Promise<void> {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < waitMs) {
      if (!isProcessAlive(pid)) {
        return;
      }
      await sleep(100);
    }

    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }

  #statusResult(
    paths: DaemonPaths,
    status: DaemonStatusKind,
    ready: boolean,
    state: DaemonState | null,
    pidAlive: boolean,
    health: Record<string, unknown> | null,
    message?: string
  ): DaemonStatus {
    return {
      status,
      ready,
      projectRoot: paths.projectRoot,
      dataRoot: paths.dataRoot,
      projectId: paths.projectId,
      statePath: paths.statePath,
      pidPath: paths.pidPath,
      lockDir: paths.lockDir,
      logPath: paths.logPath,
      state,
      pidAlive,
      health,
      message,
    };
  }
}

function createStrictStdioLogEvidence(
  logPath: string,
  ownerPid: number
): Record<string, unknown> | null {
  try {
    const stat = statSync(logPath);
    if (!stat.isFile()) {
      return null;
    }
    const semantic = {
      schemaVersion: 1 as const,
      ownerPid,
      relativePathHash: `sha256:${createHash('sha256').update('.asd/daemon.log').digest('hex')}`,
      inode: String(stat.ino),
      initialSize: stat.size,
    };
    return { ...semantic, evidenceHash: hashJson(semantic) };
  } catch {
    return null;
  }
}

function hashJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

type DaemonStartupWaitResult =
  | { kind: 'ready-or-timeout'; status: DaemonStatus }
  | {
      exitCode: number | null;
      kind: 'exited';
      signalCode: NodeJS.Signals | null;
    };

async function waitForReadyOrChildExit(
  paths: DaemonPaths,
  child: Pick<ChildProcess, 'exitCode' | 'signalCode'>,
  waitMs: number,
  requiredReadyPid: number | null
): Promise<DaemonStartupWaitResult> {
  const supervisor = new DaemonSupervisor();
  const startedAt = Date.now();
  while (Date.now() - startedAt < waitMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return {
        exitCode: child.exitCode,
        kind: 'exited',
        signalCode: child.signalCode,
      };
    }
    const status = await supervisor.status(paths.projectRoot);
    if (status.ready && (requiredReadyPid === null || status.state?.pid === requiredReadyPid)) {
      return { kind: 'ready-or-timeout', status };
    }
    await sleep(200);
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      exitCode: child.exitCode,
      kind: 'exited',
      signalCode: child.signalCode,
    };
  }
  const finalStatus = await supervisor.status(paths.projectRoot);
  if (
    requiredReadyPid !== null &&
    finalStatus.ready &&
    finalStatus.state?.pid !== requiredReadyPid
  ) {
    return {
      kind: 'ready-or-timeout',
      status: {
        ...finalStatus,
        status: 'starting',
        ready: false,
        message: 'strict setup child has not published its exact ready identity',
      },
    };
  }
  return { kind: 'ready-or-timeout', status: finalStatus };
}

export function computeDaemonLockBackoffMs(attempt: number): number {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  const exponentialMs = 100 * 2 ** Math.min(normalizedAttempt, 4);
  return Math.min(exponentialMs, 1_000);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isStaleLock(lockDir: string): boolean {
  try {
    const stat = statSync(lockDir);
    return Date.now() - stat.mtimeMs > 30_000;
  } catch {
    return true;
  }
}

function getDaemonServerEntryPath(): string {
  return join(PACKAGE_ROOT, 'dist', 'bin', 'daemon-server.js');
}

function isDaemonRuntimeOlderThanCurrentBuild(state: DaemonState): boolean {
  const startedAt = Date.parse(state.startedAt);
  if (!Number.isFinite(startedAt)) {
    return false;
  }
  try {
    const entryStat = statSync(getDaemonServerEntryPath());
    return entryStat.mtimeMs > startedAt + 1000;
  } catch {
    return false;
  }
}

/** health 单飞+微 TTL：多项目概要并发探测同一 daemon 时共享一次真实请求（自致超时的放大器） */
const HEALTH_COALESCE_TTL_MS = 2000;
const healthInFlight = new Map<
  string,
  { at: number; promise: Promise<Record<string, unknown> | null> }
>();

/** 仅供测试：清空 health 合并缓存（微 TTL 会让同 url 的连续断言互相污染） */
export function __clearDaemonHealthCoalesceForTests(): void {
  healthInFlight.clear();
}

async function fetchDaemonHealth(state: DaemonState): Promise<Record<string, unknown> | null> {
  const key = state.url ?? '';
  const cached = healthInFlight.get(key);
  const now = Date.now();
  if (cached && now - cached.at < HEALTH_COALESCE_TTL_MS) {
    return cached.promise;
  }
  const promise = fetchDaemonHealthUncached(state);
  healthInFlight.set(key, { at: now, promise });
  return promise;
}

async function fetchDaemonHealthUncached(
  state: DaemonState
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(`${state.url}/api/v1/daemon/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isMatchingHealth(state: DaemonState, health: Record<string, unknown> | null): boolean {
  const data = (health?.data || {}) as Record<string, unknown>;
  return (
    health?.success === true &&
    data.projectRoot === state.projectRoot &&
    data.dataRoot === state.dataRoot &&
    data.projectId === state.projectId &&
    data.version === getPackageVersion() &&
    data.databasePath === state.databasePath &&
    data.schemaMigrationVersion === state.schemaMigrationVersion &&
    data.mode === 'daemon'
  );
}

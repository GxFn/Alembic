import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readPackageInfo } from "../codex/package-info.js";
import { inspectWorkspace, resolveProjectRoot } from "../codex/workspace.js";
import {
  clearDaemonState,
  type DaemonState,
  daemonBaseUrl,
  daemonLockDirectory,
  daemonLogPath,
  daemonPidPath,
  readDaemonState,
} from "./DaemonState.js";

export type DaemonStatusKind = "ready" | "starting" | "stopped" | "stale" | "failed";

export interface DaemonStatus {
  readonly status: DaemonStatusKind;
  readonly ready: boolean;
  readonly projectRoot: string;
  readonly dataRoot: string;
  readonly state: DaemonState | undefined;
  readonly pidAlive: boolean;
  readonly health: Record<string, unknown> | undefined;
  readonly message?: string;
}

export interface DaemonSupervisorOptions {
  readonly projectRoot?: string;
  readonly waitUntilReadyMs?: number;
}

export class DaemonSupervisor {
  async status(projectRootInput?: string): Promise<DaemonStatus> {
    const workspace = inspectWorkspace(resolveProjectRoot(projectRootInput));
    const state = await readDaemonState(workspace.dataRoot);
    const pidAlive = state ? isProcessAlive(state.pid) : false;
    if (!state) {
      return statusResult(
        workspace.projectRoot,
        workspace.dataRoot,
        "stopped",
        false,
        undefined,
        false,
      );
    }
    if (!pidAlive) {
      return statusResult(
        workspace.projectRoot,
        workspace.dataRoot,
        "stale",
        false,
        state,
        false,
        undefined,
        "daemon pid is not alive",
      );
    }
    const health = await fetchHealth(state);
    if (matchesState(state, health)) {
      return statusResult(
        workspace.projectRoot,
        workspace.dataRoot,
        "ready",
        true,
        state,
        true,
        health,
      );
    }
    return statusResult(
      workspace.projectRoot,
      workspace.dataRoot,
      "stale",
      false,
      state,
      true,
      health,
      "daemon process is alive but health identity did not match",
    );
  }

  async start(options: DaemonSupervisorOptions = {}): Promise<DaemonStatus> {
    const workspace = inspectWorkspace(resolveProjectRoot(options.projectRoot));
    if (!workspace.initialized || !workspace.projectId) {
      return statusResult(
        workspace.projectRoot,
        workspace.dataRoot,
        "failed",
        false,
        undefined,
        false,
        undefined,
        "Alembic workspace is not initialized. Run `alembic codex init` first.",
      );
    }
    const current = await this.status(workspace.projectRoot);
    if (current.ready) {
      return current;
    }

    return withDaemonLock(workspace.dataRoot, async () => {
      const afterLock = await this.status(workspace.projectRoot);
      if (afterLock.ready) {
        return afterLock;
      }
      if (afterLock.state?.pid && afterLock.pidAlive) {
        await terminateProcess(afterLock.state.pid, 5000);
      }
      await clearDaemonState(workspace.dataRoot);

      const info = readPackageInfo();
      const entry = path.join(info.packageRoot, "dist", "bin", "daemon-server.js");
      if (!existsSync(entry)) {
        return statusResult(
          workspace.projectRoot,
          workspace.dataRoot,
          "failed",
          false,
          undefined,
          false,
          undefined,
          `Daemon server entry not found: ${entry}. Run npm run build first.`,
        );
      }

      await fs.mkdir(path.dirname(daemonLogPath(workspace.dataRoot)), { recursive: true });
      const logPath = daemonLogPath(workspace.dataRoot);
      const logFd = openSync(logPath, "a");
      const child = spawn(process.execPath, [entry], {
        cwd: workspace.projectRoot,
        detached: true,
        env: {
          ...process.env,
          ALEMBIC_PROJECT_DIR: workspace.projectRoot,
          ALEMBIC_DAEMON_DATA_ROOT: workspace.dataRoot,
        },
        stdio: ["ignore", logFd, logFd],
      });
      closeSync(logFd);
      child.unref();
      await fs.writeFile(daemonPidPath(workspace.dataRoot), `${child.pid ?? ""}\n`, {
        mode: 0o600,
      });

      return waitForReady(this, workspace.projectRoot, options.waitUntilReadyMs ?? 10_000);
    });
  }

  async stop(options: DaemonSupervisorOptions = {}): Promise<DaemonStatus> {
    const workspace = inspectWorkspace(resolveProjectRoot(options.projectRoot));
    const state = await readDaemonState(workspace.dataRoot);
    if (state && isProcessAlive(state.pid)) {
      await terminateProcess(state.pid, options.waitUntilReadyMs ?? 5000);
    }
    await clearDaemonState(workspace.dataRoot);
    await fs.rm(daemonPidPath(workspace.dataRoot), { force: true });
    return statusResult(
      workspace.projectRoot,
      workspace.dataRoot,
      "stopped",
      false,
      undefined,
      false,
      undefined,
      "daemon stopped",
    );
  }
}

async function waitForReady(
  supervisor: DaemonSupervisor,
  projectRoot: string,
  waitMs: number,
): Promise<DaemonStatus> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < waitMs) {
    const status = await supervisor.status(projectRoot);
    if (status.ready) {
      return status;
    }
    await sleep(200);
  }
  return supervisor.status(projectRoot);
}

async function withDaemonLock<T>(dataRoot: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = daemonLockDirectory(dataRoot);
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  try {
    await fs.mkdir(lockDir);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
    throw new Error(`Daemon lock already exists: ${lockDir}`);
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

function statusResult(
  projectRoot: string,
  dataRoot: string,
  status: DaemonStatusKind,
  ready: boolean,
  state: DaemonState | undefined,
  pidAlive: boolean,
  health?: Record<string, unknown>,
  message?: string,
): DaemonStatus {
  return {
    status,
    ready,
    projectRoot,
    dataRoot,
    state,
    pidAlive,
    health,
    ...(message ? { message } : {}),
  };
}

async function fetchHealth(state: DaemonState): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(`${daemonBaseUrl(state)}/api/v1/daemon/health`);
    return response.ok ? ((await response.json()) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function matchesState(state: DaemonState, health: Record<string, unknown> | undefined): boolean {
  const data = health?.data;
  return (
    health?.success === true &&
    typeof data === "object" &&
    data !== null &&
    (data as Record<string, unknown>).projectRoot === state.projectRoot &&
    (data as Record<string, unknown>).dataRoot === state.dataRoot &&
    (data as Record<string, unknown>).projectId === state.projectId &&
    (data as Record<string, unknown>).databasePath === state.databasePath &&
    (data as Record<string, unknown>).version === state.version
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcess(pid: number, waitMs: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
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
    process.kill(pid, "SIGKILL");
  } catch {
    /* process already gone */
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

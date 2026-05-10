import fs from "node:fs/promises";
import path from "node:path";

export interface DaemonState {
  pid: number;
  port: number;
  token: string;
  projectRoot: string;
  dataRoot: string;
  projectId: string;
  databasePath: string;
  version: string;
  startedAt: string;
  updatedAt: string;
}

const daemonRuntimeDirectoryName = ".asd";
const daemonDirectoryName = "daemon";
const daemonStateFileName = "state.json";
const daemonPidFileName = "daemon.pid";
const daemonLogFileName = "daemon.log";
const daemonLockDirectoryName = "lock";

export function daemonStateDirectory(dataRoot: string): string {
  return path.join(dataRoot, daemonRuntimeDirectoryName, daemonDirectoryName);
}

export function daemonStatePath(dataRoot: string): string {
  return path.join(daemonStateDirectory(dataRoot), daemonStateFileName);
}

export function daemonPidPath(dataRoot: string): string {
  return path.join(daemonStateDirectory(dataRoot), daemonPidFileName);
}

export function daemonLogPath(dataRoot: string): string {
  return path.join(daemonStateDirectory(dataRoot), daemonLogFileName);
}

export function daemonLockDirectory(dataRoot: string): string {
  return path.join(daemonStateDirectory(dataRoot), daemonLockDirectoryName);
}

export function daemonBaseUrl(state: Pick<DaemonState, "port">): string {
  return `http://127.0.0.1:${state.port}`;
}

export async function readDaemonState(dataRoot: string): Promise<DaemonState | undefined> {
  const statePath = daemonStatePath(dataRoot);
  let raw: string;

  try {
    raw = await fs.readFile(statePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  return parseDaemonState(JSON.parse(raw));
}

export async function writeDaemonState(state: DaemonState): Promise<void> {
  const statePath = daemonStatePath(state.dataRoot);

  // State 是 daemon/job 的持久边界：进程内存态可以重建，外部接入只依赖这里的快照。
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(parseDaemonState(state), null, 2)}\n`, "utf8");
}

export async function clearDaemonState(dataRoot: string): Promise<void> {
  await fs.rm(daemonStatePath(dataRoot), { force: true });
}

export function parseDaemonState(value: unknown): DaemonState {
  assertRecord(value, "daemon state");

  return {
    pid: requireNumber(value, "pid"),
    port: requireNumber(value, "port"),
    token: requireString(value, "token"),
    projectRoot: requireString(value, "projectRoot"),
    dataRoot: requireString(value, "dataRoot"),
    projectId: requireString(value, "projectId"),
    databasePath: requireString(value, "databasePath"),
    version: requireString(value, "version"),
    startedAt: requireString(value, "startedAt"),
    updatedAt: requireString(value, "updatedAt"),
  };
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];

  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Invalid daemon state: expected non-empty string field "${key}"`);
  }

  return field;
}

function requireNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];

  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`Invalid daemon state: expected finite number field "${key}"`);
  }

  return field;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

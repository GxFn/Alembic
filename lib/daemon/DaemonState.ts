import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WorkspaceResolver } from '@alembic/core/shared/WorkspaceResolver';
import { PACKAGE_ROOT } from '../shared/package-assets.js';

export const DAEMON_STATE_SCHEMA_VERSION = 1;

export interface DaemonPaths {
  dataRoot: string;
  jobsDir: string;
  lockDir: string;
  logPath: string;
  pidPath: string;
  projectId: string | null;
  projectRoot: string;
  runtimeDir: string;
  statePath: string;
}

export interface DaemonState {
  schemaVersion: number;
  projectRoot: string;
  dataRoot: string;
  projectId: string | null;
  pid: number;
  host: string;
  port: number;
  url: string;
  dashboardUrl: string;
  token: string;
  version: string;
  mode: 'daemon';
  startedAt: string;
  lastReadyAt: string;
  databasePath: string;
  schemaMigrationVersion: string | null;
}

export function getPackageVersion(): string {
  try {
    const raw = readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function resolveDaemonPaths(projectRoot: string): DaemonPaths {
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  return {
    projectRoot: resolver.projectRoot,
    dataRoot: resolver.dataRoot,
    projectId: resolver.projectId,
    runtimeDir: resolver.runtimeDir,
    statePath: join(resolver.runtimeDir, 'daemon.json'),
    pidPath: join(resolver.runtimeDir, 'daemon.pid'),
    lockDir: join(resolver.runtimeDir, 'daemon.lock'),
    logPath: join(resolver.runtimeDir, 'daemon.log'),
    jobsDir: join(resolver.runtimeDir, 'jobs'),
  };
}

export function ensureDaemonDirs(paths: DaemonPaths): void {
  mkdirSync(paths.runtimeDir, { recursive: true });
  mkdirSync(paths.jobsDir, { recursive: true });
}

export function readDaemonState(statePath: string): DaemonState | null {
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<DaemonState>;
    if (
      parsed.schemaVersion !== DAEMON_STATE_SCHEMA_VERSION ||
      typeof parsed.token !== 'string' ||
      parsed.token.length === 0
    ) {
      return null;
    }
    return parsed as DaemonState;
  } catch {
    return null;
  }
}

export function writeDaemonState(statePath: string, state: DaemonState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, statePath);
}

export function removeDaemonState(
  paths: Pick<DaemonPaths, 'statePath' | 'pidPath' | 'lockDir'>,
  options: { includeLock?: boolean } = {}
) {
  rmSync(paths.statePath, { force: true });
  rmSync(paths.pidPath, { force: true });
  if (options.includeLock !== false) {
    rmSync(paths.lockDir, { recursive: true, force: true });
  }
}

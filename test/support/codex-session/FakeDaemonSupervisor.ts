import path from 'node:path';
import {
  DAEMON_STATE_SCHEMA_VERSION,
  type DaemonState,
  getPackageVersion,
  resolveDaemonPaths,
} from '../../../lib/daemon/DaemonState.js';
import type { DaemonStatus } from '../../../lib/daemon/DaemonSupervisor.js';
import type { ScenarioDaemonState } from './ScenarioTypes.js';

export class FakeDaemonSupervisor {
  readonly ensureCalls: Array<{ projectRoot: string; waitUntilReadyMs?: number }> = [];
  readonly statusCalls: string[] = [];
  readonly stopCalls: Array<{ projectRoot: string; waitMs?: number }> = [];
  readonly state: ScenarioDaemonState;

  constructor(state: ScenarioDaemonState = 'stopped') {
    this.state = state;
  }

  async ensure(options: { projectRoot: string; waitUntilReadyMs?: number }): Promise<DaemonStatus> {
    this.ensureCalls.push(options);
    return makeDaemonStatus(options.projectRoot, 'ready');
  }

  async status(projectRoot: string): Promise<DaemonStatus> {
    this.statusCalls.push(projectRoot);
    return makeDaemonStatus(projectRoot, this.state);
  }

  async stop(options: { projectRoot: string; waitMs?: number }): Promise<DaemonStatus> {
    this.stopCalls.push(options);
    return makeDaemonStatus(options.projectRoot, 'stopped');
  }
}

function makeDaemonStatus(projectRoot: string, state: ScenarioDaemonState): DaemonStatus {
  const paths = resolveDaemonPaths(projectRoot);
  const daemonState = state === 'ready' ? makeDaemonState(projectRoot) : null;
  return {
    status: state === 'ready' ? 'ready' : 'stopped',
    ready: state === 'ready',
    projectRoot: paths.projectRoot,
    dataRoot: paths.dataRoot,
    projectId: paths.projectId,
    statePath: paths.statePath,
    pidPath: paths.pidPath,
    lockDir: paths.lockDir,
    logPath: paths.logPath,
    state: daemonState,
    pidAlive: state === 'ready',
    health: null,
    ...(state === 'ready' ? {} : { message: 'daemon is not started' }),
  };
}

function makeDaemonState(projectRoot: string): DaemonState {
  const paths = resolveDaemonPaths(projectRoot);
  return {
    schemaVersion: DAEMON_STATE_SCHEMA_VERSION,
    projectRoot: paths.projectRoot,
    dataRoot: paths.dataRoot,
    projectId: paths.projectId,
    pid: 12345,
    host: '127.0.0.1',
    port: 39127,
    url: 'http://127.0.0.1:39127',
    dashboardUrl: 'http://127.0.0.1:39127',
    token: 'test-token',
    version: getPackageVersion(),
    mode: 'daemon',
    startedAt: '2026-05-16T00:00:00.000Z',
    lastReadyAt: '2026-05-16T00:00:01.000Z',
    databasePath: path.join(paths.runtimeDir, 'alembic.db'),
    schemaMigrationVersion: '001',
  };
}

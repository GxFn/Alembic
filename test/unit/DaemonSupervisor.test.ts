import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGhostWorkspaceDir, ProjectRegistry } from '@alembic/core/shared/ProjectRegistry';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DAEMON_STATE_SCHEMA_VERSION,
  type DaemonPaths,
  type DaemonState,
  ensureDaemonDirs,
  getPackageVersion,
  readDaemonState,
  removeDaemonState,
  resolveDaemonPaths,
  writeDaemonState,
} from '../../lib/daemon/DaemonState.js';
import { DaemonSupervisor } from '../../lib/daemon/DaemonSupervisor.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

function useTempAlembicHome(): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-daemon-home-'));
  process.env.ALEMBIC_HOME = tempHome;
  return tempHome;
}

function makeProjectRoot(prefix = 'alembic-daemon-project-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeState(paths: DaemonPaths, overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    schemaVersion: DAEMON_STATE_SCHEMA_VERSION,
    projectRoot: paths.projectRoot,
    dataRoot: paths.dataRoot,
    projectId: paths.projectId,
    pid: process.pid,
    host: '127.0.0.1',
    port: 39127,
    url: 'http://127.0.0.1:39127',
    dashboardUrl: 'http://127.0.0.1:39127',
    token: 'test-token',
    version: getPackageVersion(),
    mode: 'daemon',
    startedAt: '2026-05-08T00:00:00.000Z',
    lastReadyAt: '2026-05-08T00:00:01.000Z',
    databasePath: path.join(paths.runtimeDir, 'alembic.db'),
    schemaMigrationVersion: '001',
    ...overrides,
  };
}

function healthResponse(state: DaemonState, overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        mode: 'daemon',
        projectRoot: state.projectRoot,
        dataRoot: state.dataRoot,
        projectId: state.projectId,
        version: state.version,
        databasePath: state.databasePath,
        schemaMigrationVersion: state.schemaMigrationVersion,
        ...overrides,
      },
    }),
    { headers: { 'content-type': 'application/json' }, status: 200 }
  );
}

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  vi.restoreAllMocks();
});

describe('DaemonState', () => {
  test('resolves daemon files under the ghost runtime directory', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const dataRoot = getGhostWorkspaceDir(entry.id);

    const paths = resolveDaemonPaths(projectRoot);
    ensureDaemonDirs(paths);

    expect(paths.dataRoot).toBe(dataRoot);
    expect(paths.runtimeDir).toBe(path.join(dataRoot, '.asd'));
    expect(paths.statePath).toBe(path.join(dataRoot, '.asd', 'daemon.json'));
    expect(paths.pidPath).toBe(path.join(dataRoot, '.asd', 'daemon.pid'));
    expect(paths.lockDir).toBe(path.join(dataRoot, '.asd', 'daemon.lock'));
    expect(paths.jobsDir).toBe(path.join(dataRoot, '.asd', 'jobs'));
    expect(fs.existsSync(paths.jobsDir)).toBe(true);
  });

  test('round-trips state and can clear files without deleting an owned lock', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const paths = resolveDaemonPaths(projectRoot);
    ensureDaemonDirs(paths);
    fs.mkdirSync(paths.lockDir, { recursive: true });
    fs.writeFileSync(paths.pidPath, '12345\n');

    const state = makeState(paths);
    writeDaemonState(paths.statePath, state);

    expect(readDaemonState(paths.statePath)).toMatchObject({
      schemaVersion: DAEMON_STATE_SCHEMA_VERSION,
      projectRoot: paths.projectRoot,
      dataRoot: paths.dataRoot,
      pid: process.pid,
      mode: 'daemon',
    });

    removeDaemonState(paths, { includeLock: false });

    expect(fs.existsSync(paths.statePath)).toBe(false);
    expect(fs.existsSync(paths.pidPath)).toBe(false);
    expect(fs.existsSync(paths.lockDir)).toBe(true);
  });

  test('rejects daemon state files without a bridge token', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const paths = resolveDaemonPaths(projectRoot);
    ensureDaemonDirs(paths);
    const stateWithoutToken: Partial<DaemonState> = makeState(paths);
    delete stateWithoutToken.token;
    fs.writeFileSync(paths.statePath, `${JSON.stringify(stateWithoutToken, null, 2)}\n`);

    expect(readDaemonState(paths.statePath)).toBeNull();
  });
});

describe('DaemonSupervisor', () => {
  test('reports stale when a state file points to a dead pid', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const paths = resolveDaemonPaths(projectRoot);
    ensureDaemonDirs(paths);
    writeDaemonState(paths.statePath, makeState(paths, { pid: 2_147_483_647 }));

    const status = await new DaemonSupervisor().status(projectRoot);

    expect(status.ready).toBe(false);
    expect(status.status).toBe('stale');
    expect(status.pidAlive).toBe(false);
    expect(status.message).toBe('daemon pid is not alive');
  });

  test('accepts only daemon health responses that match project and schema identity', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const paths = resolveDaemonPaths(projectRoot);
    ensureDaemonDirs(paths);
    const state = makeState(paths);
    writeDaemonState(paths.statePath, state);

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => healthResponse(state));

    const ready = await new DaemonSupervisor().status(projectRoot);

    expect(ready.ready).toBe(true);
    expect(ready.status).toBe('ready');

    fetchMock.mockImplementation(async () =>
      healthResponse(state, { schemaMigrationVersion: 'schema-mismatch' })
    );

    const stale = await new DaemonSupervisor().status(projectRoot);

    expect(stale.ready).toBe(false);
    expect(stale.status).toBe('stale');
    expect(stale.message).toBe('daemon process is alive but health identity did not match');
  });
});

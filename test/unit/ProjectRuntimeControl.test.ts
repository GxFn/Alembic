import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DAEMON_STATE_SCHEMA_VERSION,
  type DaemonPaths,
  type DaemonState,
  ensureDaemonDirs,
  getPackageVersion,
  JobStore,
  resolveDaemonPaths,
  writeDaemonState,
} from '@alembic/core/daemon';
import { getProjectRegistryDir, ProjectRegistry, WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DaemonStatus, DaemonSupervisor } from '../../lib/daemon/DaemonSupervisor.js';
import {
  getProjectRuntimeControlStatePath,
  ProjectRuntimeControl,
} from '../../lib/daemon/ProjectRuntimeControl.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

function useTempAlembicHome(): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-project-control-home-'));
  process.env.ALEMBIC_HOME = tempHome;
  return tempHome;
}

function makeProjectRoot(prefix = 'alembic-project-control-'): string {
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
    port: 48151,
    url: 'http://127.0.0.1:48151',
    dashboardUrl: 'http://127.0.0.1:48151',
    token: 'test-token',
    version: getPackageVersion(),
    mode: 'daemon',
    startedAt: '2026-05-18T00:00:00.000Z',
    lastReadyAt: '2026-05-18T00:00:01.000Z',
    databasePath: path.join(paths.runtimeDir, 'alembic.db'),
    schemaMigrationVersion: null,
    ...overrides,
  };
}

function healthResponse(state: DaemonState): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        capabilities: {
          fileMonitor: {
            acceptedEventSources: ['host-edit', 'git-head', 'git-worktree'],
            available: true,
            endpoint: '/api/v1/file-changes',
            mode: 'daemon-git-worktree',
          },
          internalAi: {
            available: true,
            configSource: 'workspace-settings',
            model: 'gpt-test',
            provider: 'openai',
          },
        },
        dashboardUrl: state.dashboardUrl,
        dataRoot: state.dataRoot,
        databasePath: state.databasePath,
        mode: 'daemon',
        projectId: state.projectId,
        projectRoot: state.projectRoot,
        schemaMigrationVersion: state.schemaMigrationVersion,
        version: state.version,
      },
    }),
    { headers: { 'content-type': 'application/json' }, status: 200 }
  );
}

function makeDaemonStatus(paths: DaemonPaths, overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  const state = makeState(paths, overrides.state ?? {});
  const ready = overrides.ready ?? true;
  const status = overrides.status ?? (ready ? 'ready' : 'stopped');
  return {
    dataRoot: paths.dataRoot,
    health: ready ? JSON.parse(awaitlessHealthResponse(state)) : null,
    lockDir: paths.lockDir,
    logPath: paths.logPath,
    message: ready ? undefined : 'daemon is not started',
    pidAlive: ready,
    pidPath: paths.pidPath,
    projectId: paths.projectId,
    projectRoot: paths.projectRoot,
    ready,
    state: ready ? state : null,
    statePath: paths.statePath,
    status,
    ...overrides,
  };
}

function awaitlessHealthResponse(state: DaemonState): string {
  return JSON.stringify({
    success: true,
    data: {
      capabilities: {
        fileMonitor: { available: true, mode: 'daemon-git-worktree' },
        internalAi: { available: false, configSource: 'empty', model: null, provider: null },
      },
      dashboardUrl: state.dashboardUrl,
      dataRoot: state.dataRoot,
      databasePath: state.databasePath,
      mode: 'daemon',
      projectId: state.projectId,
      projectRoot: state.projectRoot,
      schemaMigrationVersion: state.schemaMigrationVersion,
      version: state.version,
    },
  });
}

class FakeSupervisor {
  readonly startCalls: string[] = [];
  readonly stopCalls: string[] = [];
  readonly statuses = new Map<string, DaemonStatus>();

  setReady(projectRoot: string): DaemonStatus {
    const paths = resolveDaemonPaths(projectRoot);
    const status = makeDaemonStatus(paths);
    this.statuses.set(paths.projectRoot, status);
    return status;
  }

  async status(projectRoot: string): Promise<DaemonStatus> {
    const paths = resolveDaemonPaths(projectRoot);
    return (
      this.statuses.get(paths.projectRoot) ??
      makeDaemonStatus(paths, {
        health: null,
        message: 'daemon is not started',
        pidAlive: false,
        ready: false,
        state: null,
        status: 'stopped',
      })
    );
  }

  async start(options: { projectRoot: string }): Promise<DaemonStatus> {
    const paths = resolveDaemonPaths(options.projectRoot);
    this.startCalls.push(paths.projectRoot);
    return this.setReady(paths.projectRoot);
  }

  async stop(options: { projectRoot: string }): Promise<DaemonStatus> {
    const paths = resolveDaemonPaths(options.projectRoot);
    this.stopCalls.push(paths.projectRoot);
    const status = makeDaemonStatus(paths, {
      health: null,
      message: 'daemon stopped',
      pidAlive: false,
      ready: false,
      state: null,
      status: 'stopped',
    });
    this.statuses.set(paths.projectRoot, status);
    return status;
  }
}

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  vi.restoreAllMocks();
});

describe('ProjectRuntimeControl', () => {
  test('summarizes registered projects with real resolver, daemon and job scope data', async () => {
    useTempAlembicHome();
    const ghostRoot = makeProjectRoot();
    const standardRoot = makeProjectRoot();
    const ghostEntry = ProjectRegistry.register(ghostRoot, true);
    const standardEntry = ProjectRegistry.register(standardRoot, false);
    const ghostPaths = resolveDaemonPaths(ghostRoot);
    ensureDaemonDirs(ghostPaths);
    const ghostState = makeState(ghostPaths);
    writeDaemonState(ghostPaths.statePath, ghostState);
    const job = new JobStore({ projectRoot: ghostRoot }).create({
      kind: 'bootstrap',
      request: { maxFiles: 5 },
      source: 'http',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => healthResponse(ghostState));

    const snapshot = await new ProjectRuntimeControl().snapshot();

    expect(snapshot.projects.map((project) => project.projectId).sort()).toEqual(
      [ghostEntry.id, standardEntry.id].sort()
    );
    const ghostProject = snapshot.projects.find((project) => project.projectId === ghostEntry.id);
    expect(ghostProject).toMatchObject({
      dataRootSource: 'ghost-registry',
      ghost: true,
      jobs: {
        active: 1,
        latestJobId: job.id,
        total: 1,
      },
      mode: 'ghost',
      status: 'ready',
    });
    expect(ghostProject?.daemon).toMatchObject({
      dashboardUrl: 'http://127.0.0.1:48151',
      ready: true,
      status: 'ready',
      url: 'http://127.0.0.1:48151',
    });
    expect(ghostProject?.fileMonitor).toMatchObject({
      available: true,
      mode: 'daemon-git-worktree',
    });
    expect(ghostProject?.internalAi).toMatchObject({
      available: true,
      configSource: 'workspace-settings',
    });

    const standardProject = snapshot.projects.find(
      (project) => project.projectId === standardEntry.id
    );
    expect(standardProject).toMatchObject({
      dataRoot: standardProject
        ? WorkspaceResolver.fromProject(standardProject.projectRoot).dataRoot
        : undefined,
      mode: 'standard',
      status: 'stopped',
    });
  });

  test('persists selected state globally without writing into project data roots', async () => {
    const tempHome = useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const control = new ProjectRuntimeControl();

    const snapshot = await control.selectProject({ projectId: entry.id });

    expect(snapshot.selectedProject).toMatchObject({
      projectId: entry.id,
      projectRoot: ProjectRegistry.inspect(projectRoot).projectRealpath,
      status: 'stopped',
    });
    expect(snapshot.activeRuntimeProject).toBeNull();
    expect(control.readState()).toMatchObject({
      activeProjectRoot: null,
      selectedProjectId: entry.id,
      selectedProjectRoot: ProjectRegistry.inspect(projectRoot).projectRealpath,
    });
    expect(getProjectRuntimeControlStatePath()).toBe(
      path.join(tempHome, '.asd', 'runtime-control.json')
    );
    expect(
      getProjectRuntimeControlStatePath().startsWith(
        WorkspaceResolver.fromProject(projectRoot).dataRoot
      )
    ).toBe(false);
  });

  test('keeps missing registered projects visible instead of deleting them', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    fs.rmSync(projectRoot, { recursive: true, force: true });

    const snapshot = await new ProjectRuntimeControl().snapshot();
    const missingProject = snapshot.projects.find((project) => project.projectId === entry.id);

    expect(missingProject).toMatchObject({
      flags: { missing: true },
      projectExists: false,
      status: 'missing',
    });
    expect(ProjectRegistry.list().map((project) => project.entry.id)).toContain(entry.id);
    expect(fs.existsSync(getProjectRegistryDir())).toBe(true);
  });

  test('switch stops the current active runtime, starts target, and updates handoff state', async () => {
    useTempAlembicHome();
    const currentRoot = makeProjectRoot();
    const targetRoot = makeProjectRoot();
    const currentEntry = ProjectRegistry.register(currentRoot, true);
    const targetEntry = ProjectRegistry.register(targetRoot, true);
    const fake = new FakeSupervisor();
    const control = new ProjectRuntimeControl({
      supervisor: fake as unknown as DaemonSupervisor,
    });
    const currentProjectRoot = ProjectRegistry.inspect(currentRoot).projectRealpath;
    const targetProjectRoot = ProjectRegistry.inspect(targetRoot).projectRealpath;
    const currentStart = await control.startProject({ projectId: currentEntry.id });
    expect(currentStart.ok).toBe(true);
    fake.startCalls.length = 0;

    const result = await control.switchProject({ projectId: targetEntry.id });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('switch');
    expect(result.previousActiveProject).toMatchObject({ projectId: currentEntry.id });
    expect(fake.stopCalls).toEqual([currentProjectRoot]);
    expect(fake.startCalls).toEqual([targetProjectRoot]);
    expect(result.targetProject).toMatchObject({
      daemon: { ready: true, status: 'ready' },
      flags: { activeRuntime: true, selected: true },
      projectId: targetEntry.id,
      status: 'ready',
    });
    expect(result.handoff).toMatchObject({
      dashboardUrl: 'http://127.0.0.1:48151',
      projectId: targetEntry.id,
    });
    expect(control.readState()).toMatchObject({
      activeProjectId: targetEntry.id,
      selectedProjectId: targetEntry.id,
    });
  });

  test('openDashboard starts the selected project and returns a real daemon handoff', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const fake = new FakeSupervisor();
    const control = new ProjectRuntimeControl({
      supervisor: fake as unknown as DaemonSupervisor,
    });
    await control.selectProject({ projectId: entry.id });

    const result = await control.openDashboard();

    expect(result.ok).toBe(true);
    expect(result.action).toBe('open-dashboard');
    expect(fake.startCalls).toEqual([ProjectRegistry.inspect(projectRoot).projectRealpath]);
    expect(result.handoff).toMatchObject({
      apiBaseUrl: 'http://127.0.0.1:48151',
      dashboardUrl: 'http://127.0.0.1:48151',
      projectId: entry.id,
      status: 'ready',
    });
  });
});

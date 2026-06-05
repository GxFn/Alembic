import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectRuntimeControlState,
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
const ORIGINAL_ALEMBIC_DAEMON_MODE = process.env.ALEMBIC_DAEMON_MODE;
const ORIGINAL_ALEMBIC_PROJECT_DIR = process.env.ALEMBIC_PROJECT_DIR;
const ORIGINAL_ALEMBIC_DAEMON_STATE_PATH = process.env.ALEMBIC_DAEMON_STATE_PATH;

function useTempAlembicHome(): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-project-control-home-'));
  process.env.ALEMBIC_HOME = tempHome;
  return tempHome;
}

function makeProjectRoot(prefix = 'alembic-project-control-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeState(paths: DaemonPaths, overrides: Partial<DaemonState> = {}): DaemonState {
  const now = new Date().toISOString();
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
    startedAt: now,
    lastReadyAt: now,
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
          apiAi: {
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
        apiAi: { available: false, configSource: 'empty', model: null, provider: null },
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
  readonly failedStartRoots = new Set<string>();
  readonly startCalls: string[] = [];
  readonly stopCalls: string[] = [];
  readonly statuses = new Map<string, DaemonStatus>();

  setReady(projectRoot: string): DaemonStatus {
    const paths = resolveDaemonPaths(projectRoot);
    const status = makeDaemonStatus(paths);
    this.statuses.set(paths.projectRoot, status);
    return status;
  }

  setStartFailure(projectRoot: string): void {
    const paths = resolveDaemonPaths(projectRoot);
    this.failedStartRoots.add(paths.projectRoot);
    this.failedStartRoots.add(ProjectRegistry.inspect(projectRoot).projectRealpath);
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
    if (this.failedStartRoots.has(paths.projectRoot)) {
      const status = makeDaemonStatus(paths, {
        health: null,
        message: 'daemon failed to become ready',
        pidAlive: false,
        ready: false,
        state: null,
        status: 'failed',
      });
      this.statuses.set(paths.projectRoot, status);
      return status;
    }
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
  if (ORIGINAL_ALEMBIC_DAEMON_MODE === undefined) {
    delete process.env.ALEMBIC_DAEMON_MODE;
  } else {
    process.env.ALEMBIC_DAEMON_MODE = ORIGINAL_ALEMBIC_DAEMON_MODE;
  }
  if (ORIGINAL_ALEMBIC_PROJECT_DIR === undefined) {
    delete process.env.ALEMBIC_PROJECT_DIR;
  } else {
    process.env.ALEMBIC_PROJECT_DIR = ORIGINAL_ALEMBIC_PROJECT_DIR;
  }
  if (ORIGINAL_ALEMBIC_DAEMON_STATE_PATH === undefined) {
    delete process.env.ALEMBIC_DAEMON_STATE_PATH;
  } else {
    process.env.ALEMBIC_DAEMON_STATE_PATH = ORIGINAL_ALEMBIC_DAEMON_STATE_PATH;
  }
  vi.restoreAllMocks();
});

function markSelfDaemon(projectRoot: string): void {
  const paths = resolveDaemonPaths(projectRoot);
  process.env.ALEMBIC_DAEMON_MODE = '1';
  process.env.ALEMBIC_PROJECT_DIR = paths.projectRoot;
  process.env.ALEMBIC_DAEMON_STATE_PATH = paths.statePath;
}

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
    expect(ghostProject?.apiAi).toMatchObject({
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

  test('publishes runtime-control source of truth as read-only diagnostics', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const control = new ProjectRuntimeControl();
    await control.selectProject({ projectId: entry.id });
    const beforeState = control.readState();

    const snapshot = await control.snapshot();

    expect(control.readState()).toEqual(beforeState);
    expect(snapshot.sourceOfTruth).toMatchObject({
      contractVersion: 1,
      owner: 'alembic',
      readiness: {
        ready: false,
        reasonCode: 'daemon-not-running',
        status: 'stopped',
      },
      route: 'project-runtime-control',
      targetProject: {
        activeRuntime: false,
        projectId: entry.id,
        ready: false,
        selected: true,
        status: 'stopped',
      },
    });
    expect(snapshot.sourceOfTruth.operation).toEqual({
      explicitRuntimeActionRequired: true,
      implicitRuntimeActionAllowed: false,
      mode: 'diagnostics-read',
      readOnly: true,
    });
    expect(snapshot.sourceOfTruth.writePolicy).toMatchObject({
      activeStateWriteAllowed: false,
      daemonLifecycleWriteAllowed: false,
      projectScopeRegistryWriteAllowed: false,
      selectedStateWriteAllowed: false,
    });
    expect(snapshot.sourceOfTruth.runtimeControl).toMatchObject({
      activeProject: null,
      activeReadyProject: null,
      activeStateTrusted: false,
      projects: { ready: 0, total: 1 },
      readOnly: true,
      selectedProject: {
        projectId: entry.id,
        selected: true,
        status: 'stopped',
      },
      statePath: getProjectRuntimeControlStatePath(),
    });
    expect(snapshot.sourceOfTruth.failure).toMatchObject({
      blockedFallbacks: ['plugin-selected-root-fallback', 'implicit-runtime-control-write'],
      observedSource: 'alembic-source-of-truth',
      reasonCode: 'daemon-not-running',
      retryable: true,
    });
  });

  test('reports selected and active runtime mismatch without clearing a ready daemon state', async () => {
    useTempAlembicHome();
    const selectedRoot = makeProjectRoot();
    const activeRoot = makeProjectRoot();
    const selectedEntry = ProjectRegistry.register(selectedRoot, true);
    const activeEntry = ProjectRegistry.register(activeRoot, true);
    const selectedProjectRoot = ProjectRegistry.inspect(selectedRoot).projectRealpath;
    const activeProjectRoot = ProjectRegistry.inspect(activeRoot).projectRealpath;
    const fake = new FakeSupervisor();
    fake.setReady(activeProjectRoot);
    const control = new ProjectRuntimeControl({
      supervisor: fake as unknown as DaemonSupervisor,
    });
    control.writeState(
      createProjectRuntimeControlState({
        activeProjectId: activeEntry.id,
        activeProjectRoot,
        selectedAt: '2026-06-05T01:02:03.000Z',
        selectedProjectId: selectedEntry.id,
        selectedProjectRoot,
        updatedAt: '2026-06-05T01:02:03.000Z',
      })
    );

    const snapshot = await control.snapshot();

    expect(snapshot.activeRuntimeProject).toBeNull();
    expect(snapshot.state).toMatchObject({
      activeProjectId: activeEntry.id,
      selectedProjectId: selectedEntry.id,
    });
    expect(control.readState()).toMatchObject({
      activeProjectId: activeEntry.id,
      selectedProjectId: selectedEntry.id,
    });
    expect(snapshot.stateCleanup.activeState.cleaned).toBe(false);
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'explicit-runtime-action-required',
          code: 'selected-active-mismatch',
          projectId: activeEntry.id,
          reasonCode: 'runtime-control-selected-mismatch',
          severity: 'error',
        }),
      ])
    );
    expect(snapshot.sourceOfTruth).toMatchObject({
      failure: {
        blockingCondition: expect.stringContaining('does not match active daemon state'),
        observedSource: 'alembic-source-of-truth',
        reasonCode: 'runtime-control-selected-mismatch',
        retryable: false,
      },
      readiness: {
        ready: false,
        reasonCode: 'runtime-control-selected-mismatch',
        stale: true,
        status: 'stale',
      },
      runtimeControl: {
        activeStateTrusted: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'selected-active-mismatch' }),
        ]),
        stateCleanup: {
          activeState: {
            cleaned: false,
          },
        },
      },
    });
  });

  test('clears stale active state when the persisted daemon state is missing', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const projectRealpath = ProjectRegistry.inspect(projectRoot).projectRealpath;
    const control = new ProjectRuntimeControl();
    control.writeState(
      createProjectRuntimeControlState({
        activeProjectId: entry.id,
        activeProjectRoot: projectRealpath,
        selectedAt: '2026-06-05T04:05:06.000Z',
        selectedProjectId: entry.id,
        selectedProjectRoot: projectRealpath,
        updatedAt: '2026-06-05T04:05:06.000Z',
      })
    );

    const snapshot = await control.snapshot();

    expect(snapshot.activeRuntimeProject).toBeNull();
    expect(snapshot.state).toMatchObject({
      activeProjectId: null,
      selectedProjectId: entry.id,
    });
    expect(control.readState()).toMatchObject({
      activeProjectId: null,
      selectedProjectId: entry.id,
    });
    expect(snapshot.stateCleanup.activeState).toMatchObject({
      cleaned: true,
      previousProjectId: entry.id,
      previousProjectRoot: projectRealpath,
      reasonCode: 'daemon-missing',
    });
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'cleared-active-state',
          code: 'daemon-state-missing',
          reasonCode: 'daemon-missing',
          severity: 'error',
        }),
      ])
    );
    expect(snapshot.sourceOfTruth).toMatchObject({
      failure: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'daemon-state-missing' }),
        ]),
        observedSource: 'alembic-source-of-truth',
        reasonCode: 'daemon-missing',
      },
      readiness: {
        ready: false,
        reasonCode: 'daemon-missing',
      },
      runtimeControl: {
        activeProject: null,
        stateCleanup: {
          activeState: {
            cleaned: true,
            reasonCode: 'daemon-missing',
          },
        },
      },
    });
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
    expect(targetEntry.id).not.toBe(currentEntry.id);
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

  test('self-daemon switch returns target handoff and defers stopping the current daemon', async () => {
    useTempAlembicHome();
    const currentRoot = makeProjectRoot();
    const targetRoot = makeProjectRoot();
    const currentEntry = ProjectRegistry.register(currentRoot, true);
    const targetEntry = ProjectRegistry.register(targetRoot, true);
    expect(targetEntry.id).not.toBe(currentEntry.id);
    const fake = new FakeSupervisor();
    const control = new ProjectRuntimeControl({
      supervisor: fake as unknown as DaemonSupervisor,
    });
    const currentStart = await control.startProject({ projectId: currentEntry.id });
    expect(currentStart.ok).toBe(true);
    markSelfDaemon(currentRoot);
    const beforeSwitch = await control.snapshot();
    expect(beforeSwitch.activeRuntimeProject).toMatchObject({
      daemon: {
        pid: process.pid,
        statePath: process.env.ALEMBIC_DAEMON_STATE_PATH,
      },
      projectId: currentEntry.id,
    });
    fake.startCalls.length = 0;

    const result = await control.switchProject(
      { projectId: targetEntry.id },
      { deferSelfDaemonStop: true }
    );

    expect(result.ok).toBe(true);
    expect(result.previousActiveProject).toMatchObject({ projectId: currentEntry.id });
    expect(result.targetProject).toMatchObject({ projectId: targetEntry.id });
    expect(result.deferredStopProject).toMatchObject({ projectId: currentEntry.id });
    expect(result.stoppedProject).toBeNull();
    expect(fake.stopCalls).toEqual([]);
    expect(fake.startCalls).toEqual([ProjectRegistry.inspect(targetRoot).projectRealpath]);
    expect(result.handoff).toMatchObject({
      projectId: targetEntry.id,
      status: 'ready',
    });
    expect(control.readState()).toMatchObject({
      activeProjectId: targetEntry.id,
      selectedProjectId: targetEntry.id,
    });
  });

  test('self-daemon switch keeps the current daemon active when target startup fails', async () => {
    useTempAlembicHome();
    const currentRoot = makeProjectRoot();
    const targetRoot = makeProjectRoot();
    const currentEntry = ProjectRegistry.register(currentRoot, true);
    const targetEntry = ProjectRegistry.register(targetRoot, true);
    const fake = new FakeSupervisor();
    const control = new ProjectRuntimeControl({
      supervisor: fake as unknown as DaemonSupervisor,
    });
    const currentStart = await control.startProject({ projectId: currentEntry.id });
    expect(currentStart.ok).toBe(true);
    markSelfDaemon(currentRoot);
    const beforeSwitch = await control.snapshot();
    expect(beforeSwitch.activeRuntimeProject).toMatchObject({
      daemon: {
        pid: process.pid,
        statePath: process.env.ALEMBIC_DAEMON_STATE_PATH,
      },
      projectId: currentEntry.id,
    });
    fake.setStartFailure(targetRoot);
    fake.startCalls.length = 0;

    const result = await control.switchProject(
      { projectId: targetEntry.id },
      { deferSelfDaemonStop: true }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('daemon failed to become ready');
    expect(result.deferredStopProject).toBeNull();
    expect(fake.stopCalls).toEqual([]);
    expect(fake.startCalls).toEqual([ProjectRegistry.inspect(targetRoot).projectRealpath]);
    expect(control.readState()).toMatchObject({
      activeProjectId: currentEntry.id,
      selectedProjectId: currentEntry.id,
    });
    expect(result.snapshot.activeRuntimeProject).toMatchObject({ projectId: currentEntry.id });
  });

  test('self-daemon stop returns an action result before deferring process termination', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const fake = new FakeSupervisor();
    const control = new ProjectRuntimeControl({
      supervisor: fake as unknown as DaemonSupervisor,
    });
    const start = await control.startProject({ projectId: entry.id });
    expect(start.ok).toBe(true);
    markSelfDaemon(projectRoot);
    const beforeStop = await control.snapshot();
    expect(beforeStop.activeRuntimeProject).toMatchObject({
      daemon: {
        pid: process.pid,
        statePath: process.env.ALEMBIC_DAEMON_STATE_PATH,
      },
      projectId: entry.id,
    });
    fake.startCalls.length = 0;

    const result = await control.stopProject(
      { projectId: entry.id },
      { deferSelfDaemonStop: true }
    );

    expect(result.ok).toBe(true);
    expect(result.deferredStopProject).toMatchObject({ projectId: entry.id });
    expect(result.stoppedProject).toBeNull();
    expect(fake.stopCalls).toEqual([]);
    expect(result.snapshot.activeRuntimeProject).toBeNull();
    expect(result.snapshot.selectedProject).toMatchObject({
      flags: { activeRuntime: false, selected: true },
      projectId: entry.id,
      status: 'ready',
    });
    expect(control.readState()).toMatchObject({
      activeProjectId: null,
      selectedProjectId: entry.id,
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

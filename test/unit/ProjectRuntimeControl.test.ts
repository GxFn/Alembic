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
});

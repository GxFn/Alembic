import { afterEach, describe, expect, test } from 'vitest';
import { buildAlembicRuntimeBoundary } from '../../lib/daemon/RuntimeBoundary.js';
import {
  buildDaemonCapabilities,
  buildDaemonProjectIdentity,
  buildResidentSearchCapability,
  type DaemonCapabilitiesOptions,
} from '../../lib/http/routes/daemon.js';

describe('daemon capabilities', () => {
  const originalFileChanges = process.env.ALEMBIC_DAEMON_FILE_CHANGES;

  afterEach(() => {
    if (originalFileChanges === undefined) {
      delete process.env.ALEMBIC_DAEMON_FILE_CHANGES;
    } else {
      process.env.ALEMBIC_DAEMON_FILE_CHANGES = originalFileChanges;
    }
  });

  function makeCapabilities(overrides: Partial<DaemonCapabilitiesOptions> = {}) {
    return buildDaemonCapabilities({
      dashboardAvailable: true,
      dashboardUrl: 'http://127.0.0.1:49152',
      fileMonitorAvailable: true,
      internalAi: {
        available: true,
        configSource: 'workspace-settings',
        model: 'gpt-test',
        provider: 'openai',
      },
      origin: 'http://127.0.0.1:49152',
      ...overrides,
    });
  }

  function makeRuntimeBoundary(
    capabilities = makeCapabilities(),
    overrides: Partial<Omit<Parameters<typeof buildAlembicRuntimeBoundary>[0], 'capabilities'>> = {}
  ) {
    return buildAlembicRuntimeBoundary({
      capabilities,
      dashboardUrl: 'http://127.0.0.1:49152',
      mode: 'daemon',
      origin: 'http://127.0.0.1:49152',
      workspace: {
        databasePath: '/tmp/project/.asd/alembic.db',
        dataRoot: '/tmp/project',
        dataRootSource: 'project-root',
        ghost: false,
        projectId: null,
        projectRoot: '/tmp/project',
        runtimeDir: '/tmp/project/.asd',
      },
      ...overrides,
    });
  }

  test('describes local enhancement capabilities for plugin route choice', () => {
    delete process.env.ALEMBIC_DAEMON_FILE_CHANGES;
    const capabilities = makeCapabilities();
    const runtimeBoundary = makeRuntimeBoundary(capabilities);

    expect(capabilities.api).toEqual({
      available: true,
      baseUrl: 'http://127.0.0.1:49152',
      healthPath: '/api/v1/daemon/health',
    });
    expect(capabilities.dashboard).toEqual({
      available: true,
      url: 'http://127.0.0.1:49152',
    });
    expect(capabilities).not.toHaveProperty('runtimeBoundary');
    expect(capabilities.jobs.kinds).toEqual(['bootstrap', 'rescan']);
    expect(capabilities.fileMonitor).toMatchObject({
      acceptedEventSources: ['host-edit', 'git-head', 'git-worktree'],
      available: true,
      endpoint: '/api/v1/file-changes',
      mode: 'daemon-git-worktree',
    });
    expect(Object.values(capabilities.fileMonitor.compatibilityAliases)).toEqual(['host-edit']);
    expect(capabilities.internalAi.available).toBe(true);
    expect(buildResidentSearchCapability()).toEqual({
      available: true,
      endpoint: '/api/v1/search',
      modes: ['keyword', 'bm25', 'semantic'],
      owner: 'alembic',
      route: 'resident-search',
      telemetry: {
        exposesActualMode: true,
        exposesDegradedReason: true,
        exposesDurationMs: true,
        exposesVectorStats: true,
        exposesWorkspaceIdentity: true,
      },
    });
    expect(runtimeBoundary).toMatchObject({
      owner: 'alembic',
      route: 'local-alembic',
      workspace: {
        contract: '@alembic/core/workspace',
        dataRootSource: 'project-root',
        mode: 'standard',
        projectRoot: '/tmp/project',
        workspaceMode: 'standard',
      },
      daemon: {
        owner: 'alembic',
        stateContract: '@alembic/core/daemon',
      },
      dashboard: {
        frontendOwner: 'AlembicDashboard',
        handoff: 'url',
        serverOwner: 'alembic',
      },
      fileMonitor: {
        acceptedEventSources: ['host-edit', 'git-head', 'git-worktree'],
        longLivedOwner: 'alembic-daemon',
        mode: 'daemon-git-worktree',
      },
      jobs: {
        endpoints: {
          bootstrap: '/api/v1/jobs/bootstrap',
          list: '/api/v1/jobs',
          rescan: '/api/v1/jobs/rescan',
        },
        kinds: ['bootstrap', 'rescan'],
        owner: 'alembic',
        store: '@alembic/core/daemon/JobStore',
      },
    });
    expect(runtimeBoundary.internalAi).toMatchObject({
      owner: 'alembic-internal-ai',
      runtimeOwner: 'AlembicAgent',
    });
  });

  test('reports file monitor unavailable when explicitly disabled', () => {
    process.env.ALEMBIC_DAEMON_FILE_CHANGES = '0';
    const capabilities = makeCapabilities({
      dashboardAvailable: false,
      dashboardUrl: null,
      fileMonitorAvailable: false,
      internalAi: { available: false, configSource: 'empty', model: null, provider: null },
      origin: null,
    });
    const runtimeBoundary = makeRuntimeBoundary(capabilities, {
      dashboardUrl: null,
      origin: null,
    });

    expect(capabilities.fileMonitor.available).toBe(false);
    expect(capabilities.fileMonitor.mode).toBe('disabled');
    expect(runtimeBoundary.fileMonitor.available).toBe(false);
  });

  test('builds project identity through the core runtime contract', () => {
    const projectIdentity = buildDaemonProjectIdentity({
      dataRoot: '/tmp/project',
      dataRootSource: 'ghost-registry',
      databasePath: '/tmp/project/.asd/alembic.db',
      projectId: 'project-123',
      projectRoot: '/tmp/source',
      runtimeDir: '/tmp/project/.asd',
      schemaMigrationVersion: '2026-05-18',
    });

    expect(projectIdentity).toEqual({
      dataRoot: '/tmp/project',
      dataRootSource: 'ghost-registry',
      databasePath: '/tmp/project/.asd/alembic.db',
      projectId: 'project-123',
      projectRoot: '/tmp/source',
      runtimeDir: '/tmp/project/.asd',
      schemaMigrationVersion: '2026-05-18',
      workspaceMode: 'ghost',
    });

    const runtimeBoundary = makeRuntimeBoundary(makeCapabilities(), {
      workspace: {
        ...projectIdentity,
        databasePath: projectIdentity.databasePath ?? '/tmp/project/.asd/alembic.db',
        ghost: true,
      },
    });

    expect(runtimeBoundary.workspace).toMatchObject({
      contract: '@alembic/core/workspace',
      dataRootSource: 'ghost-registry',
      mode: 'ghost',
      runtimeDir: '/tmp/project/.asd',
      workspaceMode: 'ghost',
    });
  });
});

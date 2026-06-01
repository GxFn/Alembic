import { createProjectDescriptor, summarizeProjectScopeDescriptor } from '@alembic/core/shared';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createDisabledFileMonitorStatus,
  createGitFallbackFileMonitorStatus,
  createNativeFileMonitorStatus,
} from '../../lib/daemon/FileMonitorStatus.js';
import { buildAlembicRuntimeBoundary } from '../../lib/daemon/RuntimeBoundary.js';
import {
  buildDaemonCapabilities,
  buildDaemonProjectIdentity,
  buildResidentSearchCapability,
  buildResidentServiceStatus,
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
      apiAi: {
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
    expect(capabilities.jobs.processEvents).toMatchObject({
      available: true,
      endpoint: '/api/v1/jobs/:jobId/events',
      supportedKinds: expect.arrayContaining(['workflow', 'summary', 'error']),
    });
    expect(capabilities.projectScope).toMatchObject({
      available: true,
      endpoints: {
        addFolder: '/api/v1/project-scope/folders',
        listFolders: '/api/v1/project-scope/folders',
        readScope: '/api/v1/project-scope',
        resolveFolder: '/api/v1/project-scope/resolve-folder',
      },
      storageKind: 'ghost',
      supportedOperations: [
        'project-scope.read',
        'project-folders.add',
        'project-folders.list',
        'project-folders.resolve',
      ],
    });
    expect(capabilities.fileMonitor).toMatchObject({
      acceptedEventSources: ['host-edit', 'git-head', 'git-worktree'],
      activeEventSource: 'git-worktree',
      available: true,
      degraded: true,
      degradedReason: 'native watcher unavailable; using git worktree fallback',
      endpoint: '/api/v1/file-changes',
      mode: 'daemon-git-worktree',
      nativeWatcher: {
        status: 'unsupported',
      },
      status: 'degraded',
    });
    expect(Object.values(capabilities.fileMonitor.compatibilityAliases)).toEqual(['host-edit']);
    expect(capabilities.apiAi.available).toBe(true);
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
        activeEventSource: 'git-worktree',
        degraded: true,
        longLivedOwner: 'alembic-daemon',
        mode: 'daemon-git-worktree',
        status: 'degraded',
      },
      jobs: {
        endpoints: {
          bootstrap: '/api/v1/jobs/bootstrap',
          events: '/api/v1/jobs/:jobId/events',
          list: '/api/v1/jobs',
          rescan: '/api/v1/jobs/rescan',
        },
        kinds: ['bootstrap', 'rescan'],
        owner: 'alembic',
        store: '@alembic/core/daemon/JobStore',
      },
    });
    expect(runtimeBoundary.apiAi).toMatchObject({
      owner: 'alembic-api-ai',
      runtimeOwner: 'AlembicAgent',
    });

    const residentService = buildResidentServiceStatus({
      capabilities,
      apiAi: capabilities.apiAi,
      origin: 'http://127.0.0.1:49152',
      projectIdentity: buildDaemonProjectIdentity({
        dataRoot: '/tmp/project',
        dataRootSource: 'project-root',
        databasePath: '/tmp/project/.asd/alembic.db',
        projectId: 'project-123',
        projectRoot: '/tmp/project',
        runtimeDir: '/tmp/project/.asd',
        schemaMigrationVersion: '2026-05-23',
      }),
      statePath: '/tmp/project/.asd/daemon.json',
    });

    expect(residentService).toMatchObject({
      apiBaseUrl: 'http://127.0.0.1:49152',
      contractVersion: 1,
      healthPath: '/api/v1/daemon/health',
      owner: 'alembic',
      route: 'local-alembic-daemon',
      serviceScope: {
        diagnosticPaths: {
          databasePath: '/tmp/project/.asd/alembic.db',
          projectRoot: '/tmp/project',
          statePath: '/tmp/project/.asd/daemon.json',
        },
        kind: 'current-project',
        projectIdentity: {
          dataRootSource: 'project-root',
          projectId: 'project-123',
          schemaMigrationVersion: '2026-05-23',
          workspaceMode: 'standard',
        },
        scopeId: 'project:project-123',
      },
    });
    expect('projectRoot' in residentService.serviceScope.projectIdentity).toBe(false);
    expect(residentService.capabilities['status.health']).toMatchObject({
      available: true,
      owner: 'alembic',
      route: 'local-alembic-daemon',
      unavailableReason: null,
    });
    expect(residentService.capabilities['search.keyword'].available).toBe(true);
    expect(residentService.capabilities['search.semantic'].available).toBe(true);
    expect(residentService.capabilities['dashboard.handoff'].available).toBe(true);
    expect(residentService.capabilities['file-monitor.git-worktree'].available).toBe(true);
    expect(residentService.capabilities['jobs.api-ai.bootstrap']).toMatchObject({
      available: true,
      owner: 'alembic',
    });
    expect(residentService.capabilities['jobs.host-agent-recoverable.bootstrap']).toMatchObject({
      available: false,
      owner: 'alembic-plugin',
      unavailableReason: 'capability-unavailable',
    });
  });

  test('reports file monitor unavailable when explicitly disabled', () => {
    process.env.ALEMBIC_DAEMON_FILE_CHANGES = '0';
    const capabilities = makeCapabilities({
      dashboardAvailable: false,
      dashboardUrl: null,
      fileMonitorAvailable: false,
      fileMonitorStatus: createDisabledFileMonitorStatus('disabled-by-env'),
      apiAi: { available: false, configSource: 'empty', model: null, provider: null },
      origin: null,
    });
    const runtimeBoundary = makeRuntimeBoundary(capabilities, {
      dashboardUrl: null,
      origin: null,
    });

    expect(capabilities.fileMonitor.available).toBe(false);
    expect(capabilities.fileMonitor.mode).toBe('disabled');
    expect(capabilities.fileMonitor).toMatchObject({
      activeEventSource: null,
      fallback: {
        active: false,
        reason: 'disabled-by-env',
      },
      status: 'disabled',
    });
    expect(runtimeBoundary.fileMonitor.available).toBe(false);
    expect(runtimeBoundary.fileMonitor.status).toBe('disabled');

    const residentService = buildResidentServiceStatus({
      capabilities,
      apiAi: capabilities.apiAi,
      origin: null,
      projectIdentity: buildDaemonProjectIdentity({
        dataRoot: '/tmp/project',
        dataRootSource: 'ghost-registry',
        databasePath: '/tmp/project/.asd/alembic.db',
        projectId: null,
        projectRoot: '/tmp/source',
        runtimeDir: '/tmp/project/.asd',
      }),
    });

    expect(residentService.serviceScope.scopeId).toBe('workspace:ghost:ghost-registry');
    expect(residentService.capabilities['dashboard.handoff']).toMatchObject({
      available: false,
      unavailableReason: 'capability-unavailable',
    });
    expect(residentService.capabilities['file-monitor.git-worktree']).toMatchObject({
      available: false,
      unavailableReason: 'capability-unavailable',
    });
    expect(residentService.capabilities['jobs.api-ai.rescan']).toMatchObject({
      available: true,
      owner: 'alembic',
    });
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
      projectScope: null,
      projectScopeId: null,
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

  test('uses explicit collector status instead of daemon env shortcuts', () => {
    const capabilities = makeCapabilities({
      fileMonitorAvailable: false,
      fileMonitorStatus: createGitFallbackFileMonitorStatus({
        intervalMs: 12_000,
        lastDispatchAt: '2026-05-31T01:02:03.000Z',
        lastScanAt: '2026-05-31T01:02:02.000Z',
      }),
    });

    expect(capabilities.fileMonitor).toMatchObject({
      activeEventSource: 'git-worktree',
      available: true,
      degraded: true,
      lastDispatchAt: '2026-05-31T01:02:03.000Z',
      lastScanAt: '2026-05-31T01:02:02.000Z',
      mode: 'daemon-git-worktree',
      status: 'degraded',
    });
  });

  test('reports native watcher as running and git fallback inactive', () => {
    const capabilities = makeCapabilities({
      fileMonitorStatus: createNativeFileMonitorStatus({
        lastScanAt: '2026-05-31T02:03:04.000Z',
      }),
    });
    const runtimeBoundary = makeRuntimeBoundary(capabilities);
    const residentService = buildResidentServiceStatus({
      capabilities,
      apiAi: capabilities.apiAi,
      origin: 'http://127.0.0.1:49152',
      projectIdentity: buildDaemonProjectIdentity({
        dataRoot: '/tmp/project',
        dataRootSource: 'project-root',
        databasePath: '/tmp/project/.asd/alembic.db',
        projectId: 'project-123',
        projectRoot: '/tmp/project',
        runtimeDir: '/tmp/project/.asd',
      }),
    });

    expect(capabilities.fileMonitor).toMatchObject({
      activeEventSource: 'native-watch',
      available: true,
      degraded: false,
      lastScanAt: '2026-05-31T02:03:04.000Z',
      mode: 'host-event-bridge',
      nativeWatcher: {
        status: 'running',
      },
      status: 'running',
    });
    expect(runtimeBoundary.fileMonitor).toMatchObject({
      activeEventSource: 'native-watch',
      available: true,
      degraded: false,
      mode: 'host-event-bridge',
      status: 'running',
    });
    expect(residentService.capabilities['file-monitor.git-worktree']).toMatchObject({
      available: false,
      message: 'Alembic daemon native file monitor is running; git worktree fallback is inactive.',
    });
  });

  test('exposes ProjectScope identity through daemon health and resident service scope', () => {
    const projectScope = createProjectDescriptor({
      controlRoot: '/tmp/workspace',
      dataRoot: '/tmp/alembic-data',
      displayName: 'Alembic workspace',
      folders: [
        {
          path: '/tmp/workspace/Alembic',
          role: 'primary-source',
        },
        {
          path: '/tmp/workspace/AlembicCore',
          role: 'source',
        },
      ],
      projectId: 'project-scope-project',
      projectScopeId: 'project-scope-123',
    });
    const projectScopeSummary = summarizeProjectScopeDescriptor(
      projectScope,
      projectScope.folders[1]?.id ?? null
    );
    const projectIdentity = buildDaemonProjectIdentity({
      dataRoot: projectScopeSummary.dataRoot,
      dataRootSource: 'ghost-registry',
      databasePath: '/tmp/alembic-data/.asd/alembic.db',
      projectId: projectScopeSummary.projectId,
      projectRoot: '/tmp/workspace/AlembicCore',
      projectScope: projectScopeSummary,
      runtimeDir: '/tmp/alembic-data/.asd',
    });
    const residentService = buildResidentServiceStatus({
      capabilities: makeCapabilities(),
      apiAi: makeCapabilities().apiAi,
      origin: 'http://127.0.0.1:49152',
      projectIdentity,
      statePath: '/tmp/alembic-data/.asd/daemon.json',
    });

    expect(projectIdentity).toMatchObject({
      dataRoot: '/tmp/alembic-data',
      dataRootSource: 'ghost-registry',
      projectId: 'project-scope-project',
      projectScope: {
        controlRoot: '/tmp/workspace',
        projectScopeId: 'project-scope-123',
        storageKind: 'ghost',
      },
      projectScopeId: 'project-scope-123',
      projectRoot: '/tmp/workspace/AlembicCore',
      workspaceMode: 'ghost',
    });
    expect(residentService.serviceScope).toMatchObject({
      diagnosticPaths: {
        controlRoot: '/tmp/workspace',
        dataRoot: '/tmp/alembic-data',
        projectRoot: '/tmp/workspace/AlembicCore',
        runtimeDir: '/tmp/alembic-data/.asd',
      },
      displayName: 'Alembic workspace',
      projectIdentity: {
        projectScopeId: 'project-scope-123',
      },
      scopeId: 'project-scope:project-scope-123',
    });
  });
});

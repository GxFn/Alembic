import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => {
  const resolver = {
    dataRoot: '/tmp/alembic-data',
    databasePath: '/tmp/alembic-data/alembic.db',
    ghost: true,
    projectId: 'project-route',
    projectRoot: '/tmp/alembic-project',
    runtimeDir: '/tmp/alembic-data/runtime',
    toFacts: () => ({
      controlRoot: null,
      currentFolderId: null,
      dataRootSource: 'ghost-registry',
      folders: [],
      mode: 'ghost',
      projectScope: null,
      projectScopeId: null,
    }),
  };
  return {
    container: { get: vi.fn(), singletons: {} as Record<string, unknown> },
    resolver,
  };
});

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

vi.mock('../../lib/infrastructure/database/SqliteDatabaseAccess.js', () => ({
  readLatestSchemaMigrationVersion: vi.fn(() => 'schema-route'),
}));

vi.mock('../../lib/project-scope/ProjectScopeRegistry.js', () => ({
  resolveAlembicWorkspace: vi.fn(() => mocks.resolver),
}));

vi.mock('@alembic/core/workspace', () => ({
  // W2:runtime-control 路径单源后 ProjectRuntimeControl 从 workspace 入口取该函数
  getProjectRuntimeControlStatePath: () => '/tmp/alembic-registry/runtime-control.json',
  DEFAULT_FOLDER_NAMES: {
    package: {
      config: 'config',
      dashboard: 'dashboard',
      internalSkills: 'skills',
      resources: 'resources',
      templates: 'templates',
    },
  },
  getProjectRegistryDir: vi.fn(() => '/tmp/alembic-registry'),
  resolveProjectRoot: vi.fn(() => '/tmp/alembic-project'),
  WorkspaceResolver: {
    fromProject: vi.fn(() => mocks.resolver),
  },
}));

vi.mock('@alembic/core/shared', () => ({
  collectAiEnvOverrides: vi.fn(() => ({ ALEMBIC_AI_PROVIDER: 'openai' })),
  isAiEnvReady: vi.fn(() => true),
  WorkspaceSettingsStore: {
    fromProject: vi.fn(() => ({
      readAiConfig: () => ({
        env: { ALEMBIC_AI_MODEL: 'gpt-test' },
        hasSecretsFile: false,
        hasSettingsFile: true,
      }),
    })),
  },
}));

import {
  createGitFallbackFileMonitorStatus,
  createNativeFileMonitorStatus,
} from '../../lib/daemon/FileMonitorStatus.js';
import daemonRouter from '../../lib/http/routes/daemon.js';

describe('daemon health resident service contract', () => {
  const originalDashboardMounted = process.env.ALEMBIC_DAEMON_DASHBOARD_MOUNTED;
  const originalFileChanges = process.env.ALEMBIC_DAEMON_FILE_CHANGES;
  const originalMode = process.env.ALEMBIC_DAEMON_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ALEMBIC_DAEMON_DASHBOARD_MOUNTED = '1';
    delete process.env.ALEMBIC_DAEMON_FILE_CHANGES;
    process.env.ALEMBIC_DAEMON_MODE = '1';
    mocks.container.singletons = {
      daemonFileChangeCollector: {
        getStatus: () =>
          createGitFallbackFileMonitorStatus({
            intervalMs: 60_000,
            lastScanAt: '2026-05-31T01:02:03.000Z',
          }),
      },
    };
  });

  afterEach(() => {
    restoreEnv('ALEMBIC_DAEMON_DASHBOARD_MOUNTED', originalDashboardMounted);
    restoreEnv('ALEMBIC_DAEMON_FILE_CHANGES', originalFileChanges);
    restoreEnv('ALEMBIC_DAEMON_MODE', originalMode);
  });

  test('GET /daemon/health returns the canonical residentService block', async () => {
    const response = await getRouter(daemonRouter, '/api/v1/daemon/health', {
      headers: { host: '127.0.0.1:49152' },
      mountPath: '/api/v1/daemon',
    });
    const data = response.body.data as Record<string, unknown>;
    const residentService = data.residentService as Record<string, unknown>;
    const projectRuntimeSourceOfTruth = data.projectRuntimeSourceOfTruth as Record<string, unknown>;
    const serviceScope = residentService.serviceScope as Record<string, unknown>;
    const diagnosticPaths = serviceScope.diagnosticPaths as Record<string, unknown>;
    const projectIdentity = serviceScope.projectIdentity as Record<string, unknown>;
    const capabilities = residentService.capabilities as Record<string, Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(residentService).toMatchObject({
      apiBaseUrl: 'http://127.0.0.1:49152',
      contractVersion: 1,
      healthPath: '/api/v1/daemon/health',
      owner: 'alembic',
      route: 'local-alembic-daemon',
    });
    expect(serviceScope).toMatchObject({
      kind: 'current-project',
      scopeId: 'project:project-route',
    });
    expect(projectIdentity).toEqual({
      dataRootSource: 'ghost-registry',
      projectId: 'project-route',
      projectScope: null,
      projectScopeId: null,
      schemaMigrationVersion: 'schema-route',
      workspaceMode: 'ghost',
    });
    expect(diagnosticPaths).toMatchObject({
      databasePath: '/tmp/alembic-data/alembic.db',
      projectRoot: '/tmp/alembic-project',
      runtimeDir: '/tmp/alembic-data/runtime',
      statePath: '/tmp/alembic-data/runtime/daemon.json',
    });
    expect(capabilities['status.health']).toMatchObject({
      available: true,
      owner: 'alembic',
    });
    expect(capabilities['search.keyword'].available).toBe(true);
    expect(capabilities['search.semantic'].available).toBe(true);
    expect(capabilities['dashboard.handoff'].available).toBe(true);
    expect(capabilities['file-monitor.git-worktree'].available).toBe(true);
    expect(capabilities['jobs.api-ai.bootstrap']).toMatchObject({
      available: true,
      owner: 'alembic',
    });
    expect(capabilities['jobs.host-agent-recoverable.bootstrap']).toMatchObject({
      available: false,
      owner: 'alembic-plugin',
    });
    expect((data.capabilities as Record<string, unknown>).residentSearch).toBeDefined();
    expect(projectRuntimeSourceOfTruth).toMatchObject({
      contractVersion: 1,
      owner: 'alembic',
      projectIdentity: {
        dataRoot: '/tmp/alembic-data',
        dataRootSource: 'ghost-registry',
        projectId: 'project-route',
        projectRoot: '/tmp/alembic-project',
      },
      readiness: {
        ready: true,
        reasonCode: 'ready',
        status: 'ready',
      },
      route: 'daemon-health',
    });
    expect(projectRuntimeSourceOfTruth.operation).toEqual({
      explicitRuntimeActionRequired: true,
      implicitRuntimeActionAllowed: false,
      mode: 'diagnostics-read',
      readOnly: true,
    });
    expect(projectRuntimeSourceOfTruth.writePolicy).toMatchObject({
      activeStateWriteAllowed: false,
      daemonLifecycleWriteAllowed: false,
      projectScopeRegistryWriteAllowed: false,
      selectedStateWriteAllowed: false,
      writeOwner: 'alembic',
    });
    expect(projectRuntimeSourceOfTruth.runtimeControl).toMatchObject({
      activeMatchesCurrentProject: false,
      readOnly: true,
      selectedMatchesCurrentProject: false,
      statePath: '/tmp/alembic-registry/runtime-control.json',
    });
    expect(
      (
        (projectRuntimeSourceOfTruth.explicitActions as Record<string, string[]>).runtimeControl ??
        []
      ).sort()
    ).toEqual(['DELETE /api/v1/projects/select', 'POST /api/v1/projects/select']);
    expect(
      (data.capabilities as Record<string, Record<string, unknown>>).fileMonitor
    ).toMatchObject({
      activeEventSource: 'git-worktree',
      available: true,
      degraded: true,
      lastScanAt: '2026-05-31T01:02:03.000Z',
      status: 'degraded',
    });
    expect(
      (data.capabilities as Record<string, Record<string, unknown>>).fileMonitor
    ).not.toHaveProperty('compatibilityAliases');
    expect(data.runtimeBoundary).toBeDefined();
  });

  test('GET /daemon/health reports native watcher runtime status', async () => {
    mocks.container.singletons = {
      daemonFileChangeCollector: {
        getStatus: () =>
          createNativeFileMonitorStatus({
            lastScanAt: '2026-05-31T03:04:05.000Z',
          }),
      },
    };

    const response = await getRouter(daemonRouter, '/api/v1/daemon/health', {
      headers: { host: '127.0.0.1:49152' },
      mountPath: '/api/v1/daemon',
    });
    const data = response.body.data as Record<string, unknown>;
    const capabilities = data.capabilities as Record<string, Record<string, unknown>>;
    const residentService = data.residentService as Record<string, unknown>;
    const residentCapabilities = residentService.capabilities as Record<
      string,
      Record<string, unknown>
    >;

    expect(response.status).toBe(200);
    expect(capabilities.fileMonitor).toMatchObject({
      activeEventSource: 'native-watch',
      available: true,
      degraded: false,
      lastScanAt: '2026-05-31T03:04:05.000Z',
      mode: 'host-event-bridge',
      status: 'running',
    });
    expect(capabilities.fileMonitor).not.toHaveProperty('compatibilityAliases');
    expect(residentCapabilities['file-monitor.git-worktree']).toMatchObject({
      available: false,
      message: 'Alembic daemon native file monitor is running; git worktree fallback is inactive.',
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

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
    toFacts: () => ({ dataRootSource: 'ghost-registry', mode: 'ghost' }),
  };
  return {
    container: { get: vi.fn() },
    resolver,
  };
});

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

vi.mock('../../lib/infrastructure/database/SqliteDatabaseAccess.js', () => ({
  readLatestSchemaMigrationVersion: vi.fn(() => 'schema-route'),
}));

vi.mock('@alembic/core/workspace', () => ({
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
    expect(capabilities['jobs.internal-ai.bootstrap']).toMatchObject({
      available: true,
      owner: 'alembic',
    });
    expect(capabilities['jobs.host-agent-recoverable.bootstrap']).toMatchObject({
      available: false,
      owner: 'alembic-plugin',
    });
    expect((data.capabilities as Record<string, unknown>).residentSearch).toBeDefined();
    expect(data.runtimeBoundary).toBeDefined();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

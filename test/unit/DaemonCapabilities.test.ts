import { afterEach, describe, expect, test } from 'vitest';
import { buildAlembicRuntimeBoundary } from '../../lib/daemon/RuntimeBoundary.js';
import { buildDaemonCapabilities } from '../../lib/http/routes/daemon.js';

describe('daemon capabilities', () => {
  const originalFileChanges = process.env.ALEMBIC_DAEMON_FILE_CHANGES;

  afterEach(() => {
    if (originalFileChanges === undefined) {
      delete process.env.ALEMBIC_DAEMON_FILE_CHANGES;
    } else {
      process.env.ALEMBIC_DAEMON_FILE_CHANGES = originalFileChanges;
    }
  });

  function makeRuntimeBoundary(
    overrides: Partial<Parameters<typeof buildAlembicRuntimeBoundary>[0]> = {}
  ) {
    return buildAlembicRuntimeBoundary({
      dashboardUrl: 'http://127.0.0.1:49152',
      fileMonitorAvailable: true,
      internalAi: {
        available: true,
        configSource: 'workspace-settings',
        model: 'gpt-test',
        provider: 'openai',
      },
      mode: 'daemon',
      origin: 'http://127.0.0.1:49152',
      workspace: {
        databasePath: '/tmp/project/.asd/alembic.db',
        dataRoot: '/tmp/project',
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
    const runtimeBoundary = makeRuntimeBoundary();

    const capabilities = buildDaemonCapabilities({
      dashboardAvailable: true,
      dashboardUrl: 'http://127.0.0.1:49152',
      fileMonitorAvailable: true,
      internalAi: {
        available: true,
        configSource: 'workspace-settings',
        model: 'gpt-test',
        provider: 'openai',
      },
      mode: 'daemon',
      origin: 'http://127.0.0.1:49152',
      runtimeBoundary,
    });

    expect(capabilities.api).toEqual({
      available: true,
      baseUrl: 'http://127.0.0.1:49152',
      healthPath: '/api/v1/daemon/health',
    });
    expect(capabilities.dashboard).toEqual({
      available: true,
      url: 'http://127.0.0.1:49152',
    });
    expect(capabilities.jobs.kinds).toEqual(['bootstrap', 'rescan']);
    expect(capabilities.fileMonitor).toMatchObject({
      acceptedEventSources: ['host-edit', 'git-head', 'git-worktree'],
      available: true,
      endpoint: '/api/v1/file-changes',
      mode: 'daemon-git-worktree',
    });
    expect(Object.values(capabilities.fileMonitor.compatibilityAliases)).toEqual(['host-edit']);
    expect(capabilities.internalAi.available).toBe(true);
    expect(capabilities.runtimeBoundary).toMatchObject({
      owner: 'alembic',
      route: 'local-alembic',
      workspace: {
        contract: '@alembic/core/workspace',
        mode: 'standard',
        projectRoot: '/tmp/project',
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
      },
      jobs: {
        kinds: ['bootstrap', 'rescan'],
        owner: 'alembic',
        store: '@alembic/core/daemon/JobStore',
      },
    });
    expect(capabilities.runtimeBoundary.internalAi).toMatchObject({
      owner: 'alembic-internal-ai',
      runtimeOwner: 'AlembicAgent',
    });
  });

  test('reports file monitor unavailable when explicitly disabled', () => {
    process.env.ALEMBIC_DAEMON_FILE_CHANGES = '0';
    const runtimeBoundary = makeRuntimeBoundary({ fileMonitorAvailable: false });

    const capabilities = buildDaemonCapabilities({
      dashboardAvailable: false,
      dashboardUrl: null,
      fileMonitorAvailable: false,
      internalAi: { available: false, configSource: 'empty', model: null, provider: null },
      mode: 'daemon',
      origin: null,
      runtimeBoundary,
    });

    expect(capabilities.fileMonitor.available).toBe(false);
    expect(capabilities.runtimeBoundary.fileMonitor.available).toBe(false);
  });
});

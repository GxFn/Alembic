import { afterEach, describe, expect, test } from 'vitest';
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

  test('describes local enhancement capabilities for plugin route choice', () => {
    delete process.env.ALEMBIC_DAEMON_FILE_CHANGES;

    const capabilities = buildDaemonCapabilities({
      dashboardAvailable: true,
      dashboardUrl: 'http://127.0.0.1:49152',
      internalAi: {
        available: true,
        configSource: 'workspace-settings',
        model: 'gpt-test',
        provider: 'openai',
      },
      mode: 'daemon',
      origin: 'http://127.0.0.1:49152',
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
  });

  test('reports file monitor unavailable when explicitly disabled', () => {
    process.env.ALEMBIC_DAEMON_FILE_CHANGES = '0';

    const capabilities = buildDaemonCapabilities({
      dashboardAvailable: false,
      dashboardUrl: null,
      internalAi: { available: false, configSource: 'empty', model: null, provider: null },
      mode: 'daemon',
      origin: null,
    });

    expect(capabilities.fileMonitor.available).toBe(false);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildCodexStatus } from '../../lib/codex/index.js';
import {
  DAEMON_STATE_SCHEMA_VERSION,
  type DaemonState,
  getPackageVersion,
  resolveDaemonPaths,
} from '../../lib/daemon/DaemonState.js';
import type { DaemonStatus } from '../../lib/daemon/DaemonSupervisor.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const ORIGINAL_DEEPSEEK_KEY = process.env.ALEMBIC_DEEPSEEK_API_KEY;
const ORIGINAL_PROVIDER = process.env.ALEMBIC_AI_PROVIDER;

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-status-home-'));
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-status-project-'));
}

function makeInitializedWorkspace(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, '.asd'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.asd', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(projectRoot, '.asd', 'alembic.db'), '');
  fs.mkdirSync(path.join(projectRoot, 'Alembic', 'recipes'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'Alembic', 'skills'), { recursive: true });
}

function makeDaemonState(projectRoot: string): DaemonState {
  const paths = resolveDaemonPaths(projectRoot);
  return {
    schemaVersion: DAEMON_STATE_SCHEMA_VERSION,
    projectRoot: paths.projectRoot,
    dataRoot: paths.dataRoot,
    projectId: paths.projectId,
    pid: 12345,
    host: '127.0.0.1',
    port: 39127,
    url: 'http://127.0.0.1:39127',
    dashboardUrl: 'http://127.0.0.1:39127',
    token: 'secret-token',
    version: getPackageVersion(),
    mode: 'daemon',
    startedAt: '2026-05-08T00:00:00.000Z',
    lastReadyAt: '2026-05-08T00:00:01.000Z',
    databasePath: path.join(paths.runtimeDir, 'alembic.db'),
    schemaMigrationVersion: '001',
  };
}

function makeDaemonStatus(projectRoot: string, ready = false): DaemonStatus {
  const paths = resolveDaemonPaths(projectRoot);
  return {
    status: ready ? 'ready' : 'stopped',
    ready,
    projectRoot: paths.projectRoot,
    dataRoot: paths.dataRoot,
    projectId: paths.projectId,
    statePath: paths.statePath,
    pidPath: paths.pidPath,
    lockDir: paths.lockDir,
    logPath: paths.logPath,
    state: ready ? makeDaemonState(projectRoot) : null,
    pidAlive: ready,
    health: null,
  };
}

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  if (ORIGINAL_PROVIDER === undefined) {
    delete process.env.ALEMBIC_AI_PROVIDER;
  } else {
    process.env.ALEMBIC_AI_PROVIDER = ORIGINAL_PROVIDER;
  }
  if (ORIGINAL_DEEPSEEK_KEY === undefined) {
    delete process.env.ALEMBIC_DEEPSEEK_API_KEY;
  } else {
    process.env.ALEMBIC_DEEPSEEK_API_KEY = ORIGINAL_DEEPSEEK_KEY;
  }
  vi.restoreAllMocks();
});

describe('Codex status service', () => {
  test('builds the shared needs-init status without starting the daemon', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    delete process.env.ALEMBIC_AI_PROVIDER;
    delete process.env.ALEMBIC_DEEPSEEK_API_KEY;
    const supervisor = {
      status: vi.fn(async () => makeDaemonStatus(projectRoot, false)),
    };

    const status = await buildCodexStatus(projectRoot, { supervisor });
    const onboarding = status.onboarding as { primaryAction: { tool: string }; state: string };

    expect(status).toMatchObject({
      initialized: false,
      channel: { id: 'codex', expectedId: 'codex' },
      profile: 'codex-plugin',
      projectRoot,
    });
    expect(onboarding).toMatchObject({
      state: 'needs_init',
      primaryAction: { tool: 'alembic_codex_init' },
    });
    expect(status.policy.state).toBe('needs_init');
    expect(status.aiConfig).toMatchObject({
      allowsInternalBootstrap: false,
      ready: false,
      source: 'empty',
    });
    expect(status.nextActions).toContain('Initialize Ghost workspace: call alembic_codex_init');
    expect(supervisor.status).toHaveBeenCalledTimes(1);
  });

  test('reports initialized empty knowledge and summarizes daemon state without token leakage', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    makeInitializedWorkspace(projectRoot);
    process.env.ALEMBIC_AI_PROVIDER = 'deepseek';
    process.env.ALEMBIC_DEEPSEEK_API_KEY = 'secret-deepseek-key';
    const supervisor = {
      status: vi.fn(async () => makeDaemonStatus(projectRoot, true)),
    };

    const status = await buildCodexStatus(projectRoot, { supervisor });
    const serialized = JSON.stringify(status);

    expect(status).toMatchObject({
      initialized: true,
      knowledge: {
        initialized: true,
        usable: false,
        status: 'initialized_empty',
      },
      daemon: {
        ready: true,
        state: {
          url: 'http://127.0.0.1:39127',
          dashboardUrl: 'http://127.0.0.1:39127',
        },
      },
    });
    expect(status.aiConfig).toMatchObject({
      allowsInternalBootstrap: true,
      provider: 'deepseek',
      ready: true,
      source: 'runtime-overrides',
    });
    expect(status.policy.state).toBe('needs_bootstrap');
    expect(status.nextActions).toContain('Start bootstrap: call alembic_codex_bootstrap');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('secret-deepseek-key');
  });
});

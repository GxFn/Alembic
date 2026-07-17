import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DAEMON_STATE_SCHEMA_VERSION,
  type DaemonPaths,
  type DaemonState,
  ensureDaemonDirs,
  getPackageVersion,
  readDaemonState,
  removeDaemonState,
  resolveDaemonPaths,
  writeDaemonState,
} from '@alembic/core/daemon';
import { getGhostWorkspaceDir, ProjectRegistry } from '@alembic/core/workspace';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  __clearDaemonHealthCoalesceForTests,
  computeDaemonLockBackoffMs,
  DaemonSupervisor,
} from '../../lib/daemon/runtime/DaemonSupervisor.js';
import { resolveAlembicDaemonPaths } from '../../lib/project-scope/ProjectScopeRegistry.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const ORIGINAL_STRICT_SETUP_ACTION_PATH = process.env.ALEMBIC_STRICT_SETUP_ACTION_PATH;
const ORIGINAL_STRICT_SETUP_AUTHORITY_PATH = process.env.ALEMBIC_STRICT_SETUP_AUTHORITY_PATH;

function useTempAlembicHome(): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-daemon-home-'));
  process.env.ALEMBIC_HOME = tempHome;
  return tempHome;
}

function makeProjectRoot(prefix = 'alembic-daemon-project-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeStrictSupervisorFixture(
  options: { action?: 'execute' | 'recover' | 'complete'; existingTarget?: boolean } = {}
) {
  useTempAlembicHome();
  const projectRoot = makeProjectRoot('alembic-daemon-strict-project-');
  ProjectRegistry.register(projectRoot, true);
  const paths = resolveAlembicDaemonPaths(projectRoot);
  const authorityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-strict-authority-'));
  const authorityPath = path.join(authorityRoot, 'strict-setup-authority.json');
  fs.writeFileSync(authorityPath, '{}\n');
  const actionPath = path.join(authorityRoot, 'strict-setup-action.json');
  fs.writeFileSync(actionPath, `${JSON.stringify({ action: options.action ?? 'execute' })}\n`);
  if (options.existingTarget) {
    fs.mkdirSync(path.join(paths.dataRoot, 'sentinel-dir'), { recursive: true });
    fs.writeFileSync(path.join(paths.dataRoot, 'sentinel.txt'), 'pre-authority-bytes\n');
    fs.writeFileSync(
      path.join(paths.dataRoot, 'sentinel-dir', 'nested.bin'),
      Buffer.from([0, 1, 2, 255])
    );
  }
  process.env.ALEMBIC_STRICT_SETUP_ACTION_PATH = actionPath;
  process.env.ALEMBIC_STRICT_SETUP_AUTHORITY_PATH = authorityPath;
  return { actionPath, authorityRoot, paths, projectRoot };
}

function collectTreeInventory(root: string): Array<{
  contentHash?: string;
  kind: 'directory' | 'file';
  relativePath: string;
}> {
  if (!fs.existsSync(root)) {
    return [];
  }
  const inventory: Array<{
    contentHash?: string;
    kind: 'directory' | 'file';
    relativePath: string;
  }> = [];
  const visit = (current: string, relativePath: string): void => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(current, entry.name);
      const childRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
      if (entry.isDirectory()) {
        inventory.push({ kind: 'directory', relativePath: childRelativePath });
        visit(absolutePath, childRelativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unexpected inventory entry: ${absolutePath}`);
      }
      inventory.push({
        contentHash: createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex'),
        kind: 'file',
        relativePath: childRelativePath,
      });
    }
  };
  visit(root, '');
  return inventory;
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
    port: 39127,
    url: 'http://127.0.0.1:39127',
    dashboardUrl: 'http://127.0.0.1:39127',
    token: 'test-token',
    version: getPackageVersion(),
    mode: 'daemon',
    startedAt: now,
    lastReadyAt: now,
    databasePath: path.join(paths.runtimeDir, 'alembic.db'),
    schemaMigrationVersion: '001',
    ...overrides,
  };
}

function healthResponse(state: DaemonState, overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        mode: 'daemon',
        projectRoot: state.projectRoot,
        dataRoot: state.dataRoot,
        projectId: state.projectId,
        version: state.version,
        databasePath: state.databasePath,
        schemaMigrationVersion: state.schemaMigrationVersion,
        ...overrides,
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
  if (ORIGINAL_STRICT_SETUP_AUTHORITY_PATH === undefined) {
    delete process.env.ALEMBIC_STRICT_SETUP_AUTHORITY_PATH;
  } else {
    process.env.ALEMBIC_STRICT_SETUP_AUTHORITY_PATH = ORIGINAL_STRICT_SETUP_AUTHORITY_PATH;
  }
  if (ORIGINAL_STRICT_SETUP_ACTION_PATH === undefined) {
    delete process.env.ALEMBIC_STRICT_SETUP_ACTION_PATH;
  } else {
    process.env.ALEMBIC_STRICT_SETUP_ACTION_PATH = ORIGINAL_STRICT_SETUP_ACTION_PATH;
  }
  __clearDaemonHealthCoalesceForTests();
  vi.restoreAllMocks();
});

describe('DaemonState', () => {
  test('resolves daemon files under the ghost runtime directory', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const dataRoot = getGhostWorkspaceDir(entry.id);

    const paths = resolveDaemonPaths(projectRoot);
    ensureDaemonDirs(paths);

    expect(paths.dataRoot).toBe(dataRoot);
    expect(paths.runtimeDir).toBe(path.join(dataRoot, '.asd'));
    expect(paths.statePath).toBe(path.join(dataRoot, '.asd', 'daemon.json'));
    expect(paths.pidPath).toBe(path.join(dataRoot, '.asd', 'daemon.pid'));
    expect(paths.lockDir).toBe(path.join(dataRoot, '.asd', 'daemon.lock'));
    expect(paths.jobsDir).toBe(path.join(dataRoot, '.asd', 'jobs'));
    expect(fs.existsSync(paths.jobsDir)).toBe(true);
  });

  test('round-trips state and can clear files without deleting an owned lock', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const paths = resolveDaemonPaths(projectRoot);
    ensureDaemonDirs(paths);
    fs.mkdirSync(paths.lockDir, { recursive: true });
    fs.writeFileSync(paths.pidPath, '12345\n');

    const state = makeState(paths);
    writeDaemonState(paths.statePath, state);

    expect(readDaemonState(paths.statePath)).toMatchObject({
      schemaVersion: DAEMON_STATE_SCHEMA_VERSION,
      projectRoot: paths.projectRoot,
      dataRoot: paths.dataRoot,
      pid: process.pid,
      mode: 'daemon',
    });

    removeDaemonState(paths, { includeLock: false });

    expect(fs.existsSync(paths.statePath)).toBe(false);
    expect(fs.existsSync(paths.pidPath)).toBe(false);
    expect(fs.existsSync(paths.lockDir)).toBe(true);
  });

  test('rejects daemon state files without a bridge token', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const paths = resolveDaemonPaths(projectRoot);
    ensureDaemonDirs(paths);
    const stateWithoutToken: Partial<DaemonState> = makeState(paths);
    delete stateWithoutToken.token;
    fs.writeFileSync(paths.statePath, `${JSON.stringify(stateWithoutToken, null, 2)}\n`);

    expect(readDaemonState(paths.statePath)).toBeNull();
  });
});

describe('DaemonSupervisor', () => {
  test('strict execute never accepts an already-ready old daemon instead of spawning the exact child', async () => {
    const { paths, projectRoot } = makeStrictSupervisorFixture({
      action: 'execute',
      existingTarget: true,
    });
    ensureDaemonDirs(paths);
    const oldState = makeState(paths, { pid: process.pid });
    writeDaemonState(paths.statePath, oldState);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => healthResponse(oldState));
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 2_147_483_646,
      signalCode: null as NodeJS.Signals | null,
      unref: vi.fn(),
    });
    const spawnDaemon = vi.fn(() => child);
    const supervisor = new DaemonSupervisor({
      daemonEntryPath: process.execPath,
      spawnDaemon,
    });

    const status = await supervisor.start({ projectRoot, waitUntilReadyMs: 25 });

    expect(spawnDaemon).toHaveBeenCalledOnce();
    expect(status.ready).toBe(false);
    expect(collectTreeInventory(paths.dataRoot)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'file', relativePath: 'sentinel.txt' }),
      ])
    );
  });

  test('strict pristine start preserves absence through external header and lease before ready state', async () => {
    const { authorityRoot, paths, projectRoot } = makeStrictSupervisorFixture();
    expect(fs.existsSync(paths.dataRoot)).toBe(false);

    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: process.pid,
      signalCode: null as NodeJS.Signals | null,
      unref: vi.fn(),
    });
    let state: DaemonState | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (!state) {
        throw new Error('child state is not ready');
      }
      return healthResponse(state);
    });
    const spawnDaemon = vi.fn(() => {
      expect(fs.existsSync(paths.dataRoot)).toBe(false);
      expect(fs.existsSync(paths.runtimeDir)).toBe(false);
      expect(fs.existsSync(paths.jobsDir)).toBe(false);
      expect(fs.existsSync(paths.lockDir)).toBe(false);
      expect(fs.existsSync(paths.logPath)).toBe(false);
      expect(fs.existsSync(paths.pidPath)).toBe(false);
      expect(fs.existsSync(paths.statePath)).toBe(false);
      queueMicrotask(() => {
        const operationLockRoot = path.join(authorityRoot, 'operation-lock');
        const journalRoot = path.join(authorityRoot, 'evidence', 'strict-run-journal', 'run');
        fs.mkdirSync(operationLockRoot);
        fs.mkdirSync(journalRoot, { recursive: true });
        fs.writeFileSync(path.join(operationLockRoot, 'strict-production.operation.lock'), '{}\n');
        fs.writeFileSync(path.join(journalRoot, 'strict-production.journal.jsonl'), '{}\n');
        expect(fs.existsSync(paths.dataRoot)).toBe(false);
        ensureDaemonDirs(paths);
        state = makeState(paths, {
          lastReadyAt: new Date(Date.now() + 60_000).toISOString(),
          pid: process.pid,
          startedAt: new Date(Date.now() + 60_000).toISOString(),
        });
        writeDaemonState(paths.statePath, state);
      });
      return child;
    });
    const supervisor = new DaemonSupervisor({
      daemonEntryPath: process.execPath,
      spawnDaemon,
    });

    const status = await supervisor.start({ projectRoot, waitUntilReadyMs: 1_000 });

    expect(status.status).toBe('ready');
    expect(status.ready).toBe(true);
    expect(spawnDaemon).toHaveBeenCalledOnce();
    expect(fs.existsSync(paths.dataRoot)).toBe(true);
  });

  test('strict startup-only child exit is reported as a successful terminal action', async () => {
    const { paths, projectRoot } = makeStrictSupervisorFixture();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 48271,
      signalCode: null as NodeJS.Signals | null,
      unref: vi.fn(),
    });
    const supervisor = new DaemonSupervisor({
      daemonEntryPath: process.execPath,
      spawnDaemon: vi.fn(() => {
        expect(fs.existsSync(paths.dataRoot)).toBe(false);
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit('exit', 0, null);
        });
        return child;
      }),
    });

    const status = await supervisor.start({ projectRoot, waitUntilReadyMs: 500 });

    expect(status.status).toBe('stopped');
    expect(status.message).toBe('strict external setup action completed');
    expect(fs.existsSync(paths.dataRoot)).toBe(false);
  });

  test.each([
    'execute',
    'recover',
    'complete',
  ] as const)('strict %s rebuild preserves the complete target inventory until child authority is established', async (action) => {
    const { authorityRoot, paths, projectRoot } = makeStrictSupervisorFixture({
      action,
      existingTarget: true,
    });
    const beforeAuthority = collectTreeInventory(paths.dataRoot);
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: process.pid,
      signalCode: null as NodeJS.Signals | null,
      unref: vi.fn(),
    });
    let state: DaemonState | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (!state) {
        throw new Error('child state is not ready');
      }
      return healthResponse(state);
    });
    const spawnDaemon = vi.fn(() => {
      expect(collectTreeInventory(paths.dataRoot)).toEqual(beforeAuthority);
      queueMicrotask(() => {
        const operationLockRoot = path.join(authorityRoot, 'operation-lock');
        const journalRoot = path.join(authorityRoot, 'evidence', 'strict-run-journal', 'run');
        const snapshotRoot = path.join(authorityRoot, 'snapshot', 'whole-root');
        fs.mkdirSync(operationLockRoot);
        fs.mkdirSync(journalRoot, { recursive: true });
        fs.mkdirSync(snapshotRoot, { recursive: true });
        fs.writeFileSync(path.join(operationLockRoot, 'strict-production.operation.lock'), '{}\n');
        fs.writeFileSync(path.join(journalRoot, 'strict-production.journal.jsonl'), '{}\n');
        fs.writeFileSync(path.join(snapshotRoot, 'authority-established.json'), '{}\n');
        expect(collectTreeInventory(paths.dataRoot)).toEqual(beforeAuthority);

        if (action === 'execute') {
          ensureDaemonDirs(paths);
          state = makeState(paths, {
            lastReadyAt: new Date(Date.now() + 60_000).toISOString(),
            pid: process.pid,
            startedAt: new Date(Date.now() + 60_000).toISOString(),
          });
          writeDaemonState(paths.statePath, state);
          return;
        }
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
      return child;
    });
    const supervisor = new DaemonSupervisor({
      daemonEntryPath: process.execPath,
      spawnDaemon,
    });

    const status = await supervisor.start({ projectRoot, waitUntilReadyMs: 1_000 });

    expect(status.status).toBe(action === 'execute' ? 'ready' : 'stopped');
    expect(spawnDaemon).toHaveBeenCalledOnce();
  });

  test('uses bounded increasing lock retry backoff', () => {
    expect([0, 1, 2, 3, 4, 5].map(computeDaemonLockBackoffMs)).toEqual([
      100, 200, 400, 800, 1000, 1000,
    ]);
  });

  test('reports stale when a state file points to a dead pid', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const paths = resolveDaemonPaths(projectRoot);
    ensureDaemonDirs(paths);
    writeDaemonState(paths.statePath, makeState(paths, { pid: 2_147_483_647 }));

    const status = await new DaemonSupervisor().status(projectRoot);

    expect(status.ready).toBe(false);
    expect(status.status).toBe('stale');
    expect(status.pidAlive).toBe(false);
    expect(status.message).toBe('daemon pid is not alive');
  });

  test('accepts only daemon health responses that match project and schema identity', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const paths = resolveDaemonPaths(projectRoot);
    ensureDaemonDirs(paths);
    const state = makeState(paths);
    writeDaemonState(paths.statePath, state);

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => healthResponse(state));

    const ready = await new DaemonSupervisor().status(projectRoot);

    expect(ready.ready).toBe(true);
    expect(ready.status).toBe('ready');

    fetchMock.mockImplementation(async () =>
      healthResponse(state, { schemaMigrationVersion: 'schema-mismatch' })
    );
    // health 合并缓存微 TTL 内会复用上一次 ready 结果——清空以断言真实失配路径
    __clearDaemonHealthCoalesceForTests();

    const stale = await new DaemonSupervisor().status(projectRoot);

    expect(stale.ready).toBe(false);
    expect(stale.status).toBe('stale');
    expect(stale.message).toBe('daemon process is alive but health identity did not match');
  });

  test('假 stale 修复：health 超时/不可达 → starting 而非 stale（身份未证伪）', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const paths = resolveDaemonPaths(projectRoot);
    ensureDaemonDirs(paths);
    writeDaemonState(paths.statePath, makeState(paths));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('timeout');
    });
    __clearDaemonHealthCoalesceForTests();

    const status = await new DaemonSupervisor().status(projectRoot);

    expect(status.status).toBe('starting');
    expect(status.message).toBe(
      'daemon process is alive but health endpoint did not respond in time'
    );
  });

  test('health 合并：并发/连续探测同一 daemon 在微 TTL 内共享一次 fetch', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const paths = resolveDaemonPaths(projectRoot);
    ensureDaemonDirs(paths);
    const state = makeState(paths);
    writeDaemonState(paths.statePath, state);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => healthResponse(state));
    __clearDaemonHealthCoalesceForTests();

    const supervisor = new DaemonSupervisor();
    const [a, b] = await Promise.all([
      supervisor.status(projectRoot),
      supervisor.status(projectRoot),
    ]);

    expect(a.status).toBe('ready');
    expect(b.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('reports stale when an alive daemon predates the current built runtime', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const paths = resolveDaemonPaths(projectRoot);
    ensureDaemonDirs(paths);
    const daemonEntry = path.join(process.cwd(), 'dist', 'bin', 'daemon-server.js');
    const daemonEntryStat = fs.statSync(daemonEntry);
    const state = makeState(paths, {
      startedAt: new Date(daemonEntryStat.mtimeMs - 5_000).toISOString(),
      lastReadyAt: new Date(daemonEntryStat.mtimeMs - 4_000).toISOString(),
    });
    writeDaemonState(paths.statePath, state);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => healthResponse(state));

    const stale = await new DaemonSupervisor().status(projectRoot);

    expect(stale.ready).toBe(false);
    expect(stale.status).toBe('stale');
    expect(stale.pidAlive).toBe(true);
    expect(stale.message).toBe('daemon runtime is older than current build');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

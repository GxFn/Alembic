import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileChangeEvent, ReactiveEvolutionReport } from '@alembic/core/types';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createFileChangeDispatchToken,
  DaemonFileChangeCollector,
  dedupeFileChangeEvents,
  type NativeWatcherFactory,
} from '../../lib/service/evolution/DaemonFileChangeCollector.js';
import type { FileChangeDispatcher } from '../../lib/service/FileChangeDispatcher.js';

const tempDirs: string[] = [];

describe('DaemonFileChangeCollector', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('baselines first scan and dispatches newly observed worktree changes', async () => {
    const repo = createRepo();
    const { collector, dispatch } = createCollector(repo);

    await collector.scanOnce(1_000);
    expect(dispatch).not.toHaveBeenCalled();

    appendFileSync(join(repo, 'src', 'index.ts'), '\nexport const next = 2;\n');
    await collector.scanOnce(2_000);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        type: 'modified',
        path: 'src/index.ts',
        eventSource: 'git-worktree',
        idempotencyToken: expect.stringContaining('git-worktree:'),
      }),
    ]);

    collector.stop();
  });

  test('starts native watcher as the primary lifecycle path', () => {
    const repo = createNativeProject();
    const nativeWatcherFactory = vi.fn<NativeWatcherFactory>(() => ({
      close: vi.fn(),
      on: vi.fn(),
    }));
    const { collector } = createCollector(repo, { nativeWatcherFactory });

    collector.start();

    expect(nativeWatcherFactory).toHaveBeenCalledWith(repo, expect.any(Function));
    expect(collector.getStatus()).toMatchObject({
      activeEventSource: 'native-watch',
      fallback: {
        active: false,
      },
      nativeWatcher: {
        status: 'running',
      },
      state: 'running',
    });

    collector.stop();
    expect(collector.getStatus()).toMatchObject({
      activeEventSource: null,
      state: 'disabled',
    });
  });

  test('dispatches native modify/create/delete/rename events and filters ignored paths', async () => {
    const repo = createNativeProject();
    const { collector, dispatch } = createCollector(repo, {
      nativeWatcherFactory: () => ({ close: vi.fn(), on: vi.fn() }),
    });

    collector.start();

    appendFileSync(join(repo, 'src', 'index.ts'), '\nexport const next = 2;\n');
    writeFileSync(join(repo, 'src', 'created.ts'), 'export const created = true;\n');
    unlinkSync(join(repo, 'src', 'deleted.ts'));
    renameSync(join(repo, 'src', 'old-name.ts'), join(repo, 'src', 'new-name.ts'));
    mkdirSync(join(repo, '.asd'), { recursive: true });
    writeFileSync(join(repo, '.asd', 'state.json'), '{}\n');

    await collector.scanNativeOnce(2_000);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'modified',
          path: 'src/index.ts',
          eventSource: 'host-edit',
          idempotencyToken: expect.stringContaining('native-watch:'),
        }),
        expect.objectContaining({
          type: 'created',
          path: 'src/created.ts',
          eventSource: 'host-edit',
          idempotencyToken: expect.stringContaining('native-watch:'),
        }),
        expect.objectContaining({
          type: 'deleted',
          path: 'src/deleted.ts',
          eventSource: 'host-edit',
          idempotencyToken: expect.stringContaining('native-watch:'),
        }),
        expect.objectContaining({
          type: 'renamed',
          oldPath: 'src/old-name.ts',
          path: 'src/new-name.ts',
          eventSource: 'host-edit',
          idempotencyToken: expect.stringContaining('native-watch:'),
        }),
      ])
    );
    expect(dispatch.mock.calls[0]?.[0]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '.asd/state.json' })])
    );
    expect(collector.getStatus()).toMatchObject({
      activeEventSource: 'native-watch',
      state: 'running',
    });

    collector.stop();
  });

  test('falls back to git worktree lifecycle status when native watcher cannot start', async () => {
    const repo = createRepo();
    const { collector } = createCollector(repo, {
      nativeWatcherFactory: () => {
        throw new Error('native recursive watch unsupported');
      },
    });

    collector.start();
    expect(collector.getStatus()).toMatchObject({
      activeEventSource: 'git-worktree',
      degradedReason: expect.stringContaining('using git worktree fallback'),
      fallback: {
        active: true,
        eventSource: 'git-worktree',
      },
      nativeWatcher: {
        reason: 'native recursive watch unsupported',
        status: 'error',
      },
      state: 'degraded',
    });

    collector.stop();
    expect(collector.getStatus()).toMatchObject({
      activeEventSource: null,
      state: 'disabled',
    });
  });

  test('reports unsupported when native watcher fails outside a git worktree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alembic-daemon-file-change-non-git-'));
    tempDirs.push(dir);
    const { collector } = createCollector(dir, {
      nativeWatcherFactory: () => {
        throw new Error('native recursive watch unsupported');
      },
    });

    collector.start();

    expect(collector.getStatus()).toMatchObject({
      activeEventSource: null,
      fallback: {
        active: false,
        reason: 'project-is-not-git-worktree',
      },
      state: 'unsupported',
    });
  });

  test('reports error when git fallback scan fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alembic-daemon-file-change-bad-git-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, '.git'), { recursive: true });
    const { collector } = createCollector(dir);

    await collector.scanOnce(1_000);

    expect(collector.getStatus()).toMatchObject({
      activeEventSource: 'git-worktree',
      state: 'error',
    });
    expect(collector.getStatus().lastError).toContain('git ');
    expect(collector.getStatus().lastError).toContain('failed');
  });

  test('keeps collecting daemon worktree changes without external host gating', async () => {
    const repo = createRepo();
    const { collector, dispatch } = createCollector(repo);

    await collector.scanOnce(1_000);

    appendFileSync(join(repo, 'src', 'index.ts'), '\nexport const collectedByDaemon = 3;\n');
    await collector.scanOnce(2_000);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        type: 'modified',
        path: 'src/index.ts',
        eventSource: 'git-worktree',
        idempotencyToken: expect.stringContaining('git-worktree:'),
      }),
    ]);

    collector.stop();
  });

  test('filters Alembic internal files from fallback dispatch', async () => {
    const repo = createRepo();
    const { collector, dispatch } = createCollector(repo);

    await collector.scanOnce(1_000);

    mkdirSync(join(repo, '.asd'), { recursive: true });
    writeFileSync(join(repo, '.asd', 'state.json'), '{}\n');
    await collector.scanOnce(2_000);

    expect(dispatch).not.toHaveBeenCalled();
    collector.stop();
  });

  test('dedupes file-change events and creates a stable dispatch token', () => {
    const events: FileChangeEvent[] = [
      { eventSource: 'host-edit', path: 'src/index.ts', type: 'modified' },
      { eventSource: 'host-edit', path: 'src/index.ts', type: 'modified' },
      { eventSource: 'host-edit', oldPath: 'src/old.ts', path: 'src/new.ts', type: 'renamed' },
    ];

    const deduped = dedupeFileChangeEvents(events);
    expect(deduped).toHaveLength(2);
    expect(createFileChangeDispatchToken('native-watch', deduped)).toBe(
      createFileChangeDispatchToken('native-watch', [...deduped].reverse())
    );
  });
});

function createCollector(
  repo: string,
  options: { nativeWatcherFactory?: NativeWatcherFactory } = {}
) {
  const dispatch = vi.fn(async (events: FileChangeEvent[]) => makeReport(events));
  const dispatcher = { dispatch } as unknown as FileChangeDispatcher;
  const collector = new DaemonFileChangeCollector({
    projectRoot: repo,
    dispatcher,
    intervalMs: 999_999,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    nativeWatcherFactory: options.nativeWatcherFactory,
  });
  return { collector, dispatch };
}

function createNativeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'alembic-native-file-change-'));
  tempDirs.push(dir);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(join(dir, 'src', 'deleted.ts'), 'export const removed = true;\n');
  writeFileSync(join(dir, 'src', 'old-name.ts'), 'export const renamed = true;\n');

  return dir;
}

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'alembic-daemon-file-change-'));
  tempDirs.push(dir);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const value = 1;\n');
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Alembic Test']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);

  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeReport(events: FileChangeEvent[]): ReactiveEvolutionReport {
  return {
    fixed: 0,
    deprecated: 0,
    skipped: 0,
    needsReview: 0,
    suggestReview: false,
    details: [],
    eventSource: events[0]?.eventSource,
  };
}

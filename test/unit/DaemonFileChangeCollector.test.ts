import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileChangeEvent, ReactiveEvolutionReport } from '@alembic/core/types';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DaemonFileChangeCollector } from '../../lib/service/evolution/DaemonFileChangeCollector.js';
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
      {
        type: 'modified',
        path: 'src/index.ts',
        eventSource: 'git-worktree',
      },
    ]);

    collector.stop();
  });

  test('exposes git worktree fallback lifecycle status', async () => {
    const repo = createRepo();
    const { collector } = createCollector(repo);

    collector.start();
    expect(collector.getStatus()).toMatchObject({
      activeEventSource: 'git-worktree',
      degradedReason: 'native watcher unavailable; using git worktree fallback',
      fallback: {
        active: true,
        eventSource: 'git-worktree',
      },
      nativeWatcher: {
        status: 'unsupported',
      },
      state: 'degraded',
    });

    collector.stop();
    expect(collector.getStatus()).toMatchObject({
      activeEventSource: null,
      state: 'disabled',
    });
  });

  test('reports unsupported when started outside a git worktree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alembic-daemon-file-change-non-git-'));
    tempDirs.push(dir);
    const { collector } = createCollector(dir);

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
      {
        type: 'modified',
        path: 'src/index.ts',
        eventSource: 'git-worktree',
      },
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
});

function createCollector(repo: string) {
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
  });
  return { collector, dispatch };
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

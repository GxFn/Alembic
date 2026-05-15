import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DaemonFileChangeCollector } from '../../lib/service/evolution/DaemonFileChangeCollector.js';
import { getFileChangeSourceTracker } from '../../lib/service/evolution/FileChangeSourceTracker.js';
import type { FileChangeDispatcher } from '../../lib/service/FileChangeDispatcher.js';
import type {
  FileChangeEvent,
  ReactiveEvolutionReport,
} from '../../lib/types/reactive-evolution.js';

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

    await collector.stop();
  });

  test('does not gate daemon monitoring on VSCode extension heartbeat', async () => {
    const repo = createRepo();
    getFileChangeSourceTracker().markVscodeExtensionSeen(1_000);
    const { collector, dispatch } = createCollector(repo);

    await collector.scanOnce(1_000);

    writeFileSync(join(repo, 'src', 'daemon.ts'), 'export const daemon = true;\n');
    await collector.scanOnce(2_000);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toEqual([
      {
        eventSource: 'git-worktree',
        path: 'src/daemon.ts',
        type: 'created',
      },
    ]);

    await collector.stop();
  });

  test('filters Alembic internal files from fallback dispatch', async () => {
    const repo = createRepo();
    const { collector, dispatch } = createCollector(repo);

    await collector.scanOnce(1_000);

    mkdirSync(join(repo, '.asd'), { recursive: true });
    writeFileSync(join(repo, '.asd', 'state.json'), '{}\n');
    await collector.scanOnce(2_000);

    expect(dispatch).not.toHaveBeenCalled();
    await collector.stop();
  });
});

function createCollector(repo: string) {
  const dispatch = vi.fn(async (events: FileChangeEvent[]) => makeReport(events));
  const dispatcher = { dispatch } as unknown as FileChangeDispatcher;
  const collector = new DaemonFileChangeCollector({
    projectRoot: repo,
    dispatcher,
    gitPollIntervalMs: 999_999,
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

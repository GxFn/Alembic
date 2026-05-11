import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DaemonFileChangeCollector } from '../../lib/service/evolution/DaemonFileChangeCollector.js';
import { FileChangeSourceTracker } from '../../lib/service/evolution/FileChangeSourceTracker.js';
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

    collector.stop();
  });

  test('uses vscode heartbeat to suppress fallback duplicates, then resumes after expiry', async () => {
    const repo = createRepo();
    const tracker = new FileChangeSourceTracker();
    tracker.markVscodeExtensionSeen(1_000);
    const { collector, dispatch } = createCollector(repo, tracker);

    await collector.scanOnce(1_000);

    appendFileSync(join(repo, 'src', 'index.ts'), '\nexport const handledByIde = 3;\n');
    await collector.scanOnce(2_000);
    expect(dispatch).not.toHaveBeenCalled();

    writeFileSync(join(repo, 'src', 'fallback.ts'), 'export const fallback = true;\n');
    await collector.scanOnce(20_000);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toEqual([
      {
        type: 'created',
        path: 'src/fallback.ts',
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

function createCollector(repo: string, sourceTracker = new FileChangeSourceTracker()) {
  const dispatch = vi.fn(async (events: FileChangeEvent[]) => makeReport(events));
  const dispatcher = { dispatch } as unknown as FileChangeDispatcher;
  const collector = new DaemonFileChangeCollector({
    projectRoot: repo,
    dispatcher,
    sourceTracker,
    intervalMs: 999_999,
    extensionTtlMs: 10_000,
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

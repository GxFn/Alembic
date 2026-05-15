import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createInactiveGitDiffCheckpointStatus,
  GitDiffCheckpointService,
  GitDiffScanner,
  shouldIgnoreProjectPath,
  toProjectRelativePath,
} from '../../lib/service/evolution/git-diff-checkpoint/index.js';
import type { FileChangeDispatcher } from '../../lib/service/FileChangeDispatcher.js';
import type {
  FileChangeEvent,
  ReactiveEvolutionReport,
} from '../../lib/types/reactive-evolution.js';

const tempDirs: string[] = [];

describe('Git diff checkpoint', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('does not ignore source directories that share generated-folder names', () => {
    expect(shouldIgnoreProjectPath('cache/build-state.json')).toBe(true);
    expect(shouldIgnoreProjectPath('dist/index.js')).toBe(true);
    expect(shouldIgnoreProjectPath('node_modules/pkg/index.js')).toBe(true);
    expect(shouldIgnoreProjectPath('.asd/state.json')).toBe(true);

    expect(shouldIgnoreProjectPath('src/cache/index.ts')).toBe(false);
    expect(shouldIgnoreProjectPath('lib/logs/parser.ts')).toBe(false);
    expect(shouldIgnoreProjectPath('packages/app/src/vendor/client.ts')).toBe(false);
  });

  test('normalizes absolute paths relative to the project root', () => {
    const projectRoot = join('/tmp', 'alembic-project');
    expect(toProjectRelativePath(join(projectRoot, 'src', 'index.ts'), projectRoot)).toBe(
      'src/index.ts'
    );
    expect(toProjectRelativePath('src/index.ts', projectRoot)).toBe('src/index.ts');
  });

  test('keeps disabled checkpoint status visible for diagnostics', () => {
    const status = createInactiveGitDiffCheckpointStatus(
      '/tmp/project',
      'disabled for test',
      false
    );

    expect(status).toMatchObject({
      enabled: false,
      healthy: false,
      mode: 'git-diff-checkpoint',
      projectRoot: '/tmp/project',
      reason: 'disabled for test',
      surface: 'codex-plugin',
    });
  });

  test('dispatches current dirty diff on first checkpoint and repeats only when content changes', async () => {
    const repo = createRepo();
    const { checkpoint, dispatch } = createCheckpoint(repo);

    appendFileSync(join(repo, 'src', 'index.ts'), '\nexport const next = 2;\n');
    const first = await checkpoint.checkpoint(1_000);

    expect(first).toMatchObject({
      changed: true,
      dirtyPathCount: 1,
      dispatchedEventCount: 1,
      ok: true,
      scanned: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toEqual([
      {
        eventSource: 'git-worktree',
        path: 'src/index.ts',
        type: 'modified',
      },
    ]);

    const unchanged = await checkpoint.checkpoint(2_000);
    expect(unchanged).toMatchObject({
      changed: false,
      dispatchedEventCount: 0,
      ok: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);

    appendFileSync(join(repo, 'src', 'index.ts'), '\nexport const later = 3;\n');
    const changedAgain = await checkpoint.checkpoint(3_000);

    expect(changedAgain).toMatchObject({
      changed: true,
      dispatchedEventCount: 1,
      ok: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  test('dispatches untracked file content changes without watcher events', async () => {
    const repo = createRepo();
    const { checkpoint, dispatch } = createCheckpoint(repo);

    writeFileSync(join(repo, 'src', 'draft.ts'), 'export const draft = 1;\n');
    await checkpoint.checkpoint(1_000);
    await checkpoint.checkpoint(2_000);
    appendFileSync(join(repo, 'src', 'draft.ts'), 'export const draft2 = 2;\n');
    const changedAgain = await checkpoint.checkpoint(3_000);

    expect(changedAgain).toMatchObject({
      changed: true,
      dispatchedEventCount: 1,
      ok: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map((call) => call[0]?.[0])).toEqual([
      {
        eventSource: 'git-worktree',
        path: 'src/draft.ts',
        type: 'created',
      },
      {
        eventSource: 'git-worktree',
        path: 'src/draft.ts',
        type: 'created',
      },
    ]);
  });

  test('filters Alembic internal files from git diff dispatch', async () => {
    const repo = createRepo();
    const { checkpoint, dispatch } = createCheckpoint(repo);

    mkdirSync(join(repo, '.asd'), { recursive: true });
    writeFileSync(join(repo, '.asd', 'state.json'), '{}\n');
    const result = await checkpoint.checkpoint(1_000);

    expect(result).toMatchObject({
      changed: false,
      dirtyPathCount: 0,
      dispatchedEventCount: 0,
      ok: true,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('does not accept a diff signature when dispatch fails, so the next checkpoint retries', async () => {
    const repo = createRepo();
    const dispatch = vi
      .fn<(events: FileChangeEvent[]) => Promise<ReactiveEvolutionReport>>()
      .mockRejectedValueOnce(new Error('dispatcher offline'))
      .mockResolvedValueOnce(makeReport('git-worktree'));
    const dispatcher = { dispatch } as unknown as FileChangeDispatcher;
    const checkpoint = new GitDiffCheckpointService({
      dispatcher,
      logger: { info: vi.fn(), warn: vi.fn() },
      projectRoot: repo,
    });

    appendFileSync(join(repo, 'src', 'index.ts'), '\nexport const next = 2;\n');
    const failed = await checkpoint.checkpoint(1_000);
    const retried = await checkpoint.checkpoint(2_000);

    expect(failed).toMatchObject({
      changed: true,
      dispatchedEventCount: 0,
      ok: false,
    });
    expect(retried).toMatchObject({
      changed: true,
      dispatchedEventCount: 1,
      ok: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  test('reports committed HEAD changes as git-head events at checkpoint time', async () => {
    const repo = createRepo();
    const { checkpoint, dispatch } = createCheckpoint(repo);

    await checkpoint.checkpoint(1_000);
    writeFileSync(join(repo, 'src', 'committed.ts'), 'export const committed = true;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'add committed file']);
    const result = await checkpoint.checkpoint(2_000);

    expect(result).toMatchObject({
      changed: true,
      dispatchedEventCount: 1,
      headChanged: true,
      ok: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toEqual([
      {
        eventSource: 'git-head',
        path: 'src/committed.ts',
        type: 'created',
      },
    ]);
  });

  test('scanner exposes git unavailable status for non-worktrees', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alembic-git-diff-nongit-'));
    tempDirs.push(dir);
    const scanner = new GitDiffScanner({ projectRoot: dir });

    const result = await scanner.scanOnce(1_000);

    expect(result).toMatchObject({
      dirtyPathCount: 0,
      events: [],
      scanned: false,
      signature: null,
    });
    expect(scanner.getStatus()).toMatchObject({
      backend: 'git',
      healthy: false,
      lastError: 'project is not a git worktree',
    });
  });
});

function createCheckpoint(repo: string) {
  const dispatch = vi.fn(async (events: FileChangeEvent[]) => makeReport(events[0]?.eventSource));
  const dispatcher = { dispatch } as unknown as FileChangeDispatcher;
  const checkpoint = new GitDiffCheckpointService({
    dispatcher,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    projectRoot: repo,
  });
  return { checkpoint, dispatch };
}

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'alembic-git-diff-checkpoint-'));
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

function makeReport(eventsSource: ReactiveEvolutionReport['eventSource']): ReactiveEvolutionReport {
  return {
    deprecated: 0,
    details: [],
    eventSource: eventsSource,
    fixed: 0,
    needsReview: 0,
    skipped: 0,
    suggestReview: false,
  };
}

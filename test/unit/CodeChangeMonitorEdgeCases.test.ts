import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  CodeChangeMonitor,
  createInactiveMonitorStatus,
  FileChangeEventBuffer,
  GitWorktreeReconciler,
  shouldIgnoreProjectPath,
  toProjectRelativePath,
} from '../../lib/service/evolution/code-change-monitor/index.js';
import type {
  FileChangeEvent,
  ReactiveEvolutionReport,
} from '../../lib/types/reactive-evolution.js';

describe('CodeChangeMonitor edge cases', () => {
  test('does not ignore source directories that share generated-folder names', () => {
    expect(shouldIgnoreProjectPath('cache/build-state.json')).toBe(true);
    expect(shouldIgnoreProjectPath('dist/index.js')).toBe(true);
    expect(shouldIgnoreProjectPath('node_modules/pkg/index.js')).toBe(true);
    expect(shouldIgnoreProjectPath('.asd/state.json')).toBe(true);

    expect(shouldIgnoreProjectPath('src/cache/index.ts')).toBe(false);
    expect(shouldIgnoreProjectPath('lib/logs/parser.ts')).toBe(false);
    expect(shouldIgnoreProjectPath('packages/app/src/vendor/client.ts')).toBe(false);
  });

  test('normalizes absolute watcher paths relative to the project root', () => {
    const projectRoot = join('/tmp', 'alembic-project');
    expect(toProjectRelativePath(join(projectRoot, 'src', 'index.ts'), projectRoot)).toBe(
      'src/index.ts'
    );
    expect(toProjectRelativePath('src/index.ts', projectRoot)).toBe('src/index.ts');
  });

  test('keeps a disabled monitor status visible for diagnostics', () => {
    const status = createInactiveMonitorStatus('/tmp/project', 'disabled for test', false);

    expect(status).toMatchObject({
      active: false,
      enabled: false,
      healthy: false,
      mode: 'daemon-chokidar-git',
      projectRoot: '/tmp/project',
      reason: 'disabled for test',
      surface: 'codex-plugin',
    });
  });

  test('retries pending events when dispatch fails', async () => {
    const dispatch = vi
      .fn<(events: FileChangeEvent[]) => Promise<ReactiveEvolutionReport>>()
      .mockRejectedValueOnce(new Error('dispatcher offline'))
      .mockResolvedValueOnce(makeReport('git-worktree'));
    const warn = vi.fn();
    const onDispatchError = vi.fn();
    const buffer = new FileChangeEventBuffer({
      debounceMs: 999_999,
      dispatch,
      logger: { warn },
      onDispatchError,
    });

    buffer.push({
      eventSource: 'git-worktree',
      path: 'src/index.ts',
      type: 'modified',
    });

    await buffer.flushNow();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(onDispatchError).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(buffer.pendingCount).toBe(1);

    await buffer.flushNow();

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(buffer.pendingCount).toBe(0);
    expect(buffer.getLastDispatch()).toMatchObject({
      eventCount: 1,
      source: 'git-worktree',
      truncated: false,
    });
  });

  test('keeps overflow events pending after max batch truncation', async () => {
    const dispatch = vi.fn(async (events: FileChangeEvent[]) => makeReport(events[0]?.eventSource));
    const buffer = new FileChangeEventBuffer({
      debounceMs: 999_999,
      dispatch,
      logger: { warn: vi.fn() },
      maxBatchSize: 2,
    });

    buffer.push({ eventSource: 'git-worktree', path: 'src/a.ts', type: 'modified' });
    buffer.push({ eventSource: 'git-worktree', path: 'src/b.ts', type: 'modified' });
    buffer.push({ eventSource: 'git-worktree', path: 'src/c.ts', type: 'modified' });

    await buffer.flushNow();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(buffer.pendingCount).toBe(1);
    expect(buffer.getLastDispatch()).toMatchObject({
      eventCount: 2,
      truncated: true,
    });

    await buffer.flushNow();

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]?.[0]).toEqual([
      {
        eventSource: 'git-worktree',
        path: 'src/c.ts',
        type: 'modified',
      },
    ]);
    expect(buffer.pendingCount).toBe(0);
  });

  test('suppresses recently dispatched duplicate events across live and reconcile paths', async () => {
    const dispatch = vi.fn(async (events: FileChangeEvent[]) => makeReport(events[0]?.eventSource));
    const buffer = new FileChangeEventBuffer({
      debounceMs: 999_999,
      dispatch,
      logger: { warn: vi.fn() },
    });
    const event: FileChangeEvent = {
      eventSource: 'git-worktree',
      path: 'src/live.ts',
      type: 'created',
    };

    buffer.push(event);
    await buffer.flushNow();
    buffer.push(event);
    await buffer.flushNow();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(buffer.pendingCount).toBe(0);
  });

  test('does not suppress real create-delete-create transitions', async () => {
    const dispatch = vi.fn(async (events: FileChangeEvent[]) => makeReport(events[0]?.eventSource));
    const buffer = new FileChangeEventBuffer({
      debounceMs: 999_999,
      dispatch,
      logger: { warn: vi.fn() },
    });

    buffer.push({ eventSource: 'git-worktree', path: 'src/live.ts', type: 'created' });
    await buffer.flushNow();
    buffer.push({ eventSource: 'git-worktree', path: 'src/live.ts', type: 'deleted' });
    await buffer.flushNow();
    buffer.push({ eventSource: 'git-worktree', path: 'src/live.ts', type: 'created' });
    await buffer.flushNow();

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatch.mock.calls.map((call) => call[0]?.[0]?.type)).toEqual([
      'created',
      'deleted',
      'created',
    ]);
  });

  test('forced git scan emits paths that were already dirty in the previous baseline', async () => {
    const execGit = vi.fn(async (args: string[]) => {
      const command = args.join(' ');
      if (command === 'rev-parse --is-inside-work-tree') {
        return 'true';
      }
      if (command === 'rev-parse HEAD') {
        return 'abc123';
      }
      if (command === 'diff --name-status') {
        return 'M\tsrc/index.ts';
      }
      return '';
    });
    const reconciler = new GitWorktreeReconciler({
      execGit,
      projectRoot: '/repo',
    });

    const baseline = await reconciler.scanOnce(1_000);
    const unchanged = await reconciler.scanOnce(2_000);
    const forced = await reconciler.scanOnce(3_000, { forcePaths: ['src/index.ts'] });

    expect(baseline.events).toEqual([]);
    expect(unchanged.events).toEqual([]);
    expect(forced.events).toEqual([
      {
        eventSource: 'git-worktree',
        path: 'src/index.ts',
        type: 'modified',
      },
    ]);
  });

  test('uses watcher events as git reconcile triggers when git is available', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'alembic-code-monitor-edge-'));
    const dispatch = vi.fn(async (events: FileChangeEvent[]) => makeReport(events[0]?.eventSource));
    const dispatcher = { dispatch };
    const scanOptions: Array<{ forcePaths?: string[] }> = [];
    const reconcilerStatus = {
      backend: 'git' as const,
      baselineReady: true,
      dirtyPathCount: 1,
      healthy: true,
      lastError: null,
      lastEventCount: 0,
      lastHead: 'abc123',
      lastScanAt: null,
    };
    const reconciler = {
      getStatus: () => reconcilerStatus,
      scanOnce: async (_now?: number, options: { forcePaths?: string[] } = {}) => {
        scanOptions.push(options);
        return {
          baseline: scanOptions.length === 1,
          dirtyPathCount: 1,
          events: options.forcePaths?.includes('src/index.ts')
            ? [
                {
                  eventSource: 'git-worktree' as const,
                  path: 'src/index.ts',
                  type: 'modified' as const,
                },
              ]
            : [],
          headChanged: false,
        };
      },
    };
    let emitWatcherEvent: ((event: FileChangeEvent) => void) | null = null;
    const watcher = {
      getStatus: () => ({
        backend: 'chokidar' as const,
        healthy: true,
        lastError: null,
        lastEventAt: null,
        mode: 'native' as const,
        ready: true,
        watchedDirectoryCount: 1,
      }),
      start: async () => {},
      stop: async () => {},
    };
    const monitor = new CodeChangeMonitor({
      dispatcher,
      dependencies: {
        reconciler,
        watcherFactory: (options) => {
          emitWatcherEvent = options.onEvent;
          return watcher;
        },
      },
      gitPollIntervalMs: 999_999,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      projectRoot,
      watchSettleMs: 1,
    });

    try {
      await monitor.start();
      emitWatcherEvent?.({
        eventSource: 'git-worktree',
        path: 'src/index.ts',
        type: 'created',
      });
      await waitForCondition(() => dispatch.mock.calls.length === 1);
      emitWatcherEvent?.({
        eventSource: 'git-worktree',
        path: 'src/index.ts',
        type: 'created',
      });
      await waitForCondition(() => dispatch.mock.calls.length === 2);

      expect(scanOptions.at(-1)?.forcePaths).toEqual(['src/index.ts']);
      expect(monitor.getStatus()).toMatchObject({
        pipeline: {
          gitSourceOfTruth: true,
          mode: 'watch-hints-git-truth',
        },
        tuning: {
          gitPollIntervalMs: 999_999,
          watchSettleMs: 1,
        },
      });
      expect(dispatch.mock.calls.map((call) => call[0]?.[0])).toEqual([
        {
          eventSource: 'git-worktree',
          path: 'src/index.ts',
          type: 'modified',
        },
        {
          eventSource: 'git-worktree',
          path: 'src/index.ts',
          type: 'modified',
        },
      ]);
    } finally {
      await monitor.stop();
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });
});

function makeReport(eventSource: ReactiveEvolutionReport['eventSource']): ReactiveEvolutionReport {
  return {
    deprecated: 0,
    details: [],
    eventSource,
    fixed: 0,
    needsReview: 0,
    skipped: 0,
    suggestReview: false,
  };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

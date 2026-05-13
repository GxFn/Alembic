import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  createInactiveMonitorStatus,
  FileChangeEventBuffer,
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

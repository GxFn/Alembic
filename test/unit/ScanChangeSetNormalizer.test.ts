import { describe, expect, test } from 'vitest';
import {
  collectChangeSetFiles,
  eventsToChangeSet,
  normalizeFileChangeEvents,
  normalizeScanChangeSet,
} from '../../lib/workflows/scan/normalization/ScanChangeSetNormalizer.js';

describe('ScanChangeSetNormalizer', () => {
  test('normalizes valid file events and filters invalid payloads', () => {
    const result = normalizeFileChangeEvents([
      { type: 'modified', path: 'src/api.ts', eventSource: 'ide-edit' },
      { type: 'renamed', path: 'src/new.ts', oldPath: 'src/old.ts', eventSource: 'git-head' },
      { type: 'ignored', path: 'src/nope.ts' },
      { type: 'deleted' },
      null,
    ]);

    expect(result).toMatchObject({ inputCount: 5, invalidCount: 3, wasArray: true });
    expect(result.events).toEqual([
      { type: 'modified', path: 'src/api.ts', eventSource: 'ide-edit' },
      { type: 'renamed', path: 'src/new.ts', oldPath: 'src/old.ts', eventSource: 'git-head' },
    ]);
  });

  test('projects events into a changeSet with event source', () => {
    const changeSet = eventsToChangeSet([
      { type: 'created', path: 'src/new.ts', eventSource: 'ide-edit' },
      { type: 'modified', path: 'src/api.ts' },
      { type: 'deleted', path: 'src/old.ts' },
      { type: 'renamed', path: 'src/name.ts', oldPath: 'src/legacy.ts' },
    ]);

    expect(changeSet).toEqual({
      added: ['src/new.ts'],
      modified: ['src/api.ts'],
      deleted: ['src/old.ts'],
      renamed: [{ oldPath: 'src/legacy.ts', newPath: 'src/name.ts' }],
      source: 'ide-edit',
    });
  });

  test('normalizes raw changeSet payloads', () => {
    const changeSet = normalizeScanChangeSet({
      added: ['src/new.ts', 42],
      modified: ['src/api.ts'],
      deleted: ['src/old.ts'],
      renamed: [{ oldPath: 'src/a.ts', newPath: 'src/b.ts' }, { oldPath: 'broken' }],
      source: 'manual',
    });

    expect(changeSet).toEqual({
      added: ['src/new.ts'],
      modified: ['src/api.ts'],
      deleted: ['src/old.ts'],
      renamed: [{ oldPath: 'src/a.ts', newPath: 'src/b.ts' }],
      source: 'manual',
    });
  });

  test('collects changed files once across all change buckets', () => {
    expect(
      collectChangeSetFiles({
        added: ['src/api.ts'],
        modified: ['src/api.ts', 'src/edit.ts'],
        deleted: ['src/old.ts'],
        renamed: [{ oldPath: 'src/legacy.ts', newPath: 'src/new-name.ts' }],
      })
    ).toEqual(['src/api.ts', 'src/edit.ts', 'src/old.ts', 'src/legacy.ts', 'src/new-name.ts']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  FileDiffSnapshotStore,
  normalizeSnapshotPath,
  reconcileSnapshotHashes,
  type SnapshotData,
} from '../../lib/workflows/capabilities/project-intelligence/FileDiffSnapshotStore.js';

describe('normalizeSnapshotPath', () => {
  it('prefers project-relative path derived from absolute file path', () => {
    const rel = normalizeSnapshotPath(
      {
        path: '/repo/Sources/Infrastructure/Networking/Middleware/AuthMiddleware.swift',
        relativePath: 'Middleware/AuthMiddleware.swift',
      },
      '/repo'
    );

    expect(rel).toBe('Sources/Infrastructure/Networking/Middleware/AuthMiddleware.swift');
  });

  it('falls back to scanner relativePath when absolute path is outside project', () => {
    const rel = normalizeSnapshotPath(
      {
        path: '/tmp/AuthMiddleware.swift',
        relativePath: 'Middleware/AuthMiddleware.swift',
      },
      '/repo'
    );

    expect(rel).toBe('Middleware/AuthMiddleware.swift');
  });
});

describe('reconcileSnapshotHashes', () => {
  it('maps legacy short snapshot paths to unique current project-relative paths', () => {
    const result = reconcileSnapshotHashes(
      {
        'Middleware/AuthMiddleware.swift': 'old-auth-hash',
        'Sources/App.swift': 'app-hash',
      },
      ['Sources/Infrastructure/Networking/Middleware/AuthMiddleware.swift', 'Sources/App.swift']
    );

    expect(result.hashes).toEqual({
      'Sources/Infrastructure/Networking/Middleware/AuthMiddleware.swift': 'old-auth-hash',
      'Sources/App.swift': 'app-hash',
    });
    expect(result.remapped).toEqual({
      'Middleware/AuthMiddleware.swift':
        'Sources/Infrastructure/Networking/Middleware/AuthMiddleware.swift',
    });
    expect(result.ambiguous).toEqual([]);
  });

  it('keeps ambiguous legacy paths unchanged', () => {
    const result = reconcileSnapshotHashes(
      {
        'Middleware/AuthMiddleware.swift': 'old-auth-hash',
      },
      [
        'Sources/Infrastructure/Networking/Middleware/AuthMiddleware.swift',
        'Sources/Feature/Networking/Middleware/AuthMiddleware.swift',
      ]
    );

    expect(result.hashes).toEqual({
      'Middleware/AuthMiddleware.swift': 'old-auth-hash',
    });
    expect(result.remapped).toEqual({});
    expect(result.ambiguous).toEqual(['Middleware/AuthMiddleware.swift']);
  });
});

describe('FileDiffSnapshotStore.computeDiff', () => {
  it('reports a canonical modified file instead of legacy added/deleted noise', () => {
    const store = new FileDiffSnapshotStore({ getDrizzle: () => ({}) });
    const snapshot: SnapshotData = {
      id: 'snap_legacy',
      sessionId: null,
      projectRoot: '/repo',
      createdAt: new Date(0).toISOString(),
      durationMs: 0,
      fileCount: 1,
      dimensionCount: 0,
      candidateCount: 0,
      primaryLang: null,
      fileHashes: {
        'Middleware/AuthMiddleware.swift': 'old-auth-hash',
      },
      dimensionMeta: {},
      episodicData: null,
      isIncremental: false,
      parentId: null,
      changedFiles: [],
      affectedDims: [],
      status: 'complete',
    };

    const diff = store.computeDiff(
      snapshot,
      [
        {
          path: '/repo/Sources/Infrastructure/Networking/Middleware/AuthMiddleware.swift',
          relativePath: 'Middleware/AuthMiddleware.swift',
          content: 'new auth middleware content',
        },
      ],
      '/repo'
    );

    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([
      'Sources/Infrastructure/Networking/Middleware/AuthMiddleware.swift',
    ]);
    expect(diff.deleted).toEqual([]);
  });
});

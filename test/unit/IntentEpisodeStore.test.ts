import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  IntentEpisodeStore,
  toIntentEpisodeSessionKey,
} from '../../lib/service/task/IntentEpisodeStore.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'alembic-intent-episode-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('IntentEpisodeStore', () => {
  test('persists redacted ProjectScope episodes with latest recent and append-only audit', () => {
    const dataRoot = tempRoot();
    const store = new IntentEpisodeStore({
      dataRoot,
      now: () => new Date('2026-05-26T15:00:00.000Z'),
      workspace: {
        dataRootSource: 'ghost-registry',
        projectId: 'project-abc',
        projectScopeId: 'scope-123',
        workspaceMode: 'ghost',
      },
    });

    const started = store.start({
      activeFile: '/Users/secret/project/src/service.ts',
      hostIntent: {
        applied: true,
        compatibility: {
          consumer: 'alembic-plugin',
          fallbackAllowed: true,
          fallbackFields: ['userQuery', 'activeFile'],
          mode: 'mixed-host-intent-and-legacy-args',
          redacted: true,
          removalCondition:
            'Remove legacy userQuery/activeFile/language fallback after the Plugin host-intent frame is the only current consumer input path.',
        },
        confidence: 0.82,
        scenario: 'generate',
        sourceRefs: ['/Users/secret/project/src/service.ts:42', 'host:intent'],
      },
      language: 'typescript',
      module: 'src/service.ts',
      query: 'persist intent episode',
      searchMeta: {
        filteredCount: 1,
        hostIntentSourceRefs: ['/Users/secret/project/src/search.ts:7'],
        primeInjectionPackage: {
          injection: { selectedCount: 1, status: 'ready' },
          intent: { sourceRefs: ['/Users/secret/project/src/intent.ts:3'] },
          selectedKnowledge: [
            {
              itemId: 'recipe-1',
              scoreBreakdown: { finalScore: 0.9, itemId: 'recipe-1' },
              sourceRefs: ['/Users/secret/project/src/recipe.ts:8'],
            },
          ],
          trace: { sourceRefs: ['/Users/secret/project/src/trace.ts:9'] },
          version: 1,
        },
        queries: ['persist intent episode'],
        resultCount: 2,
      },
      sessionId: 'raw-thread-id',
      sourceRefs: ['/Users/secret/project/src/explicit.ts:12'],
      turnId: 'raw-turn-id',
    });
    const completed = store.updateOutcome(started.episodeId, {
      reason: 'done',
      status: 'completed',
      taskId: 'task-1',
    });

    expect(started).toMatchObject({
      activeFileRef: '[absolute-path]/service.ts',
      dataRootSource: 'ghost-registry',
      projectId: 'project-abc',
      projectScopeId: 'scope-123',
      query: 'persist intent episode',
      scenario: 'generate',
      sessionKey: toIntentEpisodeSessionKey('raw-thread-id'),
      status: 'active',
      turnKey: toIntentEpisodeSessionKey('raw-turn-id'),
      workspaceMode: 'ghost',
    });
    expect(started.sourceRefs).toEqual([
      '[absolute-path]/explicit.ts:12',
      '[absolute-path]/service.ts:42',
      'host:intent',
      '[absolute-path]/search.ts:7',
    ]);
    expect(completed).toMatchObject({
      outcomeReason: 'done',
      status: 'completed',
      taskId: 'task-1',
    });
    expect(started.hostIntent).toMatchObject({
      compatibility: {
        consumer: 'alembic-plugin',
        fallbackAllowed: true,
        fallbackFields: ['userQuery', 'activeFile'],
        mode: 'mixed-host-intent-and-legacy-args',
        redacted: true,
      },
    });
    expect(store.latest()).toMatchObject({ episodeId: started.episodeId, status: 'completed' });
    expect(store.latest({ sessionId: 'raw-thread-id' })).toMatchObject({
      episodeId: started.episodeId,
    });
    expect(store.recent({ sessionId: 'other-thread' })).toEqual([]);

    const storeDir = path.join(dataRoot, '.asd', 'intent-episodes');
    const recordPath = path.join(storeDir, 'records', `${started.episodeId}.json`);
    const disk = readFileSync(recordPath, 'utf8');
    expect(existsSync(path.join(storeDir, 'latest.json'))).toBe(true);
    expect(existsSync(path.join(storeDir, 'index.json'))).toBe(true);
    expect(
      readFileSync(path.join(storeDir, 'episodes.jsonl'), 'utf8').trim().split('\n')
    ).toHaveLength(2);
    expect(disk).not.toContain('raw-thread-id');
    expect(disk).not.toContain('raw-turn-id');
    expect(disk).not.toContain('/Users/secret');
  });
});
